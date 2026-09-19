/** Library routes: listing, detail, streaming, metadata edits and bulk actions. */
import express from 'express';
import { z } from 'zod';
import config from '../config.js';
import { db } from '../db/index.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { createLogger } from '../lib/logger.js';
import {
  deleteForever,
  emptyTrash,
  getFile,
  getStats,
  listFiles,
  moveFiles,
  previewPath,
  publicFile,
  renameFile,
  restoreFiles,
  setStarred,
  textPreview,
  thumbnailPath,
  touchFile,
  trashFiles,
} from '../services/files.js';
import { sendLocalFile, streamFile } from '../services/streaming.js';
import { enqueueRegenerate, enqueueTranscode } from '../services/jobs.js';
import { cancelUpload, retryFile } from '../services/uploadManager.js';

const log = createLogger('files:http');
const router = express.Router();

router.use(requireAuth);

const listSchema = z.object({
  view: z.string().optional(),
  folderId: z.string().nullable().optional(),
  kind: z.string().nullable().optional(),
  q: z.string().optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  starred: z.coerce.boolean().optional(),
  provider: z.string().nullable().optional(),
  needsTranscode: z.coerce.boolean().nullable().optional(),
});

// ── listing & stats ────────────────────────────────────────────────────────

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message || 'Invalid query');
    const result = await listFiles({ userId: req.userId, ...parsed.data, folderId: parsed.data.folderId || null });
    res.json(result);
  }),
);

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    res.json(await getStats(req.userId));
  }),
);

// ── bulk actions (registered before /:id so they never collide) ────────────

router.post(
  '/move',
  asyncHandler(async (req, res) => {
    const { fileIds, folderId } = req.body || {};
    res.json(await moveFiles({ userId: req.userId, fileIds, folderId: folderId || null }));
  }),
);

router.post(
  '/star',
  asyncHandler(async (req, res) => {
    const { fileIds, starred } = req.body || {};
    res.json(await setStarred({ userId: req.userId, fileIds, starred: starred !== false }));
  }),
);

router.post(
  '/trash',
  asyncHandler(async (req, res) => {
    const { fileIds, folderIds } = req.body || {};
    res.json(await trashFiles({ userId: req.userId, fileIds, folderIds: folderIds || [] }));
  }),
);

router.post(
  '/restore',
  asyncHandler(async (req, res) => {
    const { fileIds, folderIds } = req.body || {};
    res.json(await restoreFiles({ userId: req.userId, fileIds, folderIds: folderIds || [] }));
  }),
);

router.post(
  '/trash/empty',
  asyncHandler(async (req, res) => {
    const result = await emptyTrash(req.userId);
    res.json(result);
  }),
);

router.delete(
  '/',
  asyncHandler(async (req, res) => {
    const ids = req.body?.fileIds || req.query?.ids?.split(',').filter(Boolean) || [];
    if (!ids.length) throw ApiError.badRequest('No files selected');
    const result = await deleteForever({ userId: req.userId, fileIds: ids });
    log.info(`user ${req.userId} permanently deleted ${result.deleted} file(s)`);
    res.json(result);
  }),
);

// ── single file ────────────────────────────────────────────────────────────

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await getFile({ userId: req.userId, fileId: req.params.id }));
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { name, folderId, starred, tags } = req.body || {};
    if (name !== undefined) return res.json(await renameFile({ userId: req.userId, fileId: req.params.id, name }));
    const patch = { updatedAt: new Date().toISOString() };
    if (folderId !== undefined) patch.folderId = folderId || null;
    if (starred !== undefined) patch.starred = !!starred;
    if (tags !== undefined) patch.tags = [].concat(tags).slice(0, 40).map((t) => String(t).slice(0, 40));
    await db.files.updateOne({ _id: req.params.id, userId: req.userId }, { $set: patch });
    const file = await db.files.findOne({ _id: req.params.id, userId: req.userId });
    if (!file) throw ApiError.notFound('File not found');
    res.json(publicFile(file));
  }),
);

/** Range-aware media/download endpoints. */
const streamHandlers = (download) =>
  asyncHandler(async (req, res) => {
    const file = await db.files.findOne({ _id: req.params.id, userId: req.userId });
    if (!file) throw ApiError.notFound('File not found');
    await touchFile(file._id);
    await streamFile(req, res, { file, userId: req.userId, download });
  });

router.get('/:id/stream', streamHandlers(false));
router.head('/:id/stream', streamHandlers(false));
router.get('/:id/download', streamHandlers(true));
router.head('/:id/download', streamHandlers(true));

/** Grid thumbnail (JPEG generated server-side). */
router.get(
  '/:id/thumbnail',
  asyncHandler(async (req, res) => {
    const file = await db.files.findOne({ _id: req.params.id, userId: req.userId });
    if (!file) throw ApiError.notFound('File not found');
    const localPath = await thumbnailPath(file);
    if (!localPath) throw ApiError.notFound('No thumbnail available for this file');
    await sendLocalFile(req, res, localPath, {
      contentType: 'image/jpeg',
      cache: 'private, max-age=604800, immutable',
    });
  }),
);

/**
 * Web-viewable rendition for formats browsers cannot decode natively
 * (iPhone HEIC/HEIF photos, RAW, TIFF…). Falls back to the original bytes when
 * the file is already web-friendly.
 */
router.get(
  '/:id/preview',
  asyncHandler(async (req, res) => {
    const file = await db.files.findOne({ _id: req.params.id, userId: req.userId });
    if (!file) throw ApiError.notFound('File not found');
    const localPath = await previewPath(file);
    if (localPath) {
      return sendLocalFile(req, res, localPath, { contentType: 'image/jpeg', cache: 'private, max-age=604800' });
    }
    // No rendition — stream the original (the client may still be able to show it).
    return streamFile(req, res, { file, userId: req.userId, download: false });
  }),
);

/** Inline text/code preview (first N KB, UTF-8). */
router.get(
  '/:id/text',
  asyncHandler(async (req, res) => {
    const file = await db.files.findOne({ _id: req.params.id, userId: req.userId });
    if (!file) throw ApiError.notFound('File not found');
    if (file.status !== 'ready') throw ApiError.conflict('File is not ready');
    res.json(await textPreview(req.userId, file));
  }),
);

// ── processing actions ─────────────────────────────────────────────────────

/** HEVC/ProRes/odd container → streamable H.264 MP4 (kept next to original). */
router.post(
  '/:id/transcode',
  asyncHandler(async (req, res) => {
    const requestedDimension = Number(req.body?.maxDimension);
    const maxDimension = Number.isFinite(requestedDimension) && requestedDimension > 0
      ? Math.max(720, Math.min(3840, Math.round(requestedDimension)))
      : config.media.transcodeMaxDimension;
    const job = await enqueueTranscode({ userId: req.userId, fileId: req.params.id, maxDimension });
    res.status(202).json({ job });
  }),
);

/** Re-runs probe/thumbnail/preview generation (e.g. after installing ffmpeg). */
router.post(
  '/:id/regenerate',
  asyncHandler(async (req, res) => {
    const job = await enqueueRegenerate({ userId: req.userId, fileId: req.params.id });
    res.status(202).json({ job });
  }),
);

/** Retries a failed upload. */
router.post(
  '/:id/retry',
  asyncHandler(async (req, res) => {
    res.json(await retryFile({ userId: req.userId, fileId: req.params.id }));
  }),
);

router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    res.json(await cancelUpload({ userId: req.userId, fileId: req.params.id }));
  }),
);

export default router;
