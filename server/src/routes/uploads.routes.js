/**
 * Upload routes.
 *
 * Chunked (resumable):
 *   POST   /api/uploads                     → start/resume a session
 *   GET    /api/uploads/:id                 → which chunks the server already has
 *   PUT    /api/uploads/:id/chunks/:index   → raw octet-stream body for one chunk
 *   POST   /api/uploads/:id/complete        → assemble + start processing
 *   DELETE /api/uploads/:id                 → abandon and clean up
 *
 * One-shot (convenient for small files, scripts and curl):
 *   POST   /api/uploads/simple?name=&folderId=   → raw body, any size ≤ limit
 */
import express from 'express';
import { z } from 'zod';
import config from '../config.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { createLogger } from '../lib/logger.js';
import { randomHex } from '../lib/crypto.js';
import { mimeOf, sanitizeFileName } from '../lib/fileTypes.js';
import {
  cancelUpload,
  completeSession,
  createSession,
  deleteSession,
  getSession,
  ingestLocalFile,
  sessionState,
  writeChunk,
} from '../services/uploadManager.js';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { getProviderForUser } from '../storage/index.js';

const log = createLogger('uploads:http');
const router = express.Router();

router.use(requireAuth);

const createSchema = z.object({
  name: z.string().min(1).max(300),
  size: z.union([z.number(), z.string()]).transform(Number),
  mime: z.string().optional(),
  folderId: z.string().nullable().optional(),
  chunkSize: z.union([z.number(), z.string()]).transform(Number).optional(),
  checksum: z.string().max(128).optional(),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body || {});
    if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message || 'Invalid upload request');
    const session = await createSession({ userId: req.userId, ...parsed.data });
    res.status(201).json(session);
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await sessionState(req.userId, req.params.id));
  }),
);

/**
 * Raw chunk upload. No body parser is involved, so the request stream is piped
 * straight to disk — memory use stays flat even for a 64 MB chunk.
 */
router.put(
  '/:id/chunks/:index',
  asyncHandler(async (req, res) => {
    const declaredSize = req.headers['content-length'] ? Number(req.headers['content-length']) : null;
    if (declaredSize === 0) throw ApiError.badRequest('Empty chunk');
    const result = await writeChunk({
      userId: req.userId,
      uploadId: req.params.id,
      index: req.params.index,
      stream: req,
      declaredSize,
    });
    res.json({ ok: true, ...result });
  }),
);

router.post(
  '/:id/complete',
  asyncHandler(async (req, res) => {
    const result = await completeSession({ userId: req.userId, uploadId: req.params.id });
    res.json(result);
  }),
);

router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const session = await getSession(req.userId, req.params.id);
    res.json(await cancelUpload({ userId: req.userId, uploadId: session._id, fileId: session.fileId || undefined }));
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await deleteSession({ userId: req.userId, uploadId: req.params.id }));
  }),
);

/** Single-request upload for small files (also handy for CLI/curl users). */
router.post(
  '/simple',
  asyncHandler(async (req, res) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (!declared) throw ApiError.badRequest('Send the file as the raw request body with a Content-Length header');
    if (declared > config.limits.maxUploadSize) throw ApiError.payload('File exceeds the maximum upload size');

    // Reject before receiving even a temporary payload when Telegram is not ready.
    await getProviderForUser(req.userId);

    const name = sanitizeFileName(String(req.query.name || req.headers['x-file-name'] || `upload-${randomHex(3)}`));
    const folderId = req.query.folderId ? String(req.query.folderId) : null;
    const mime = mimeOf(name, req.headers['content-type']);

    const tmp = path.join(config.paths.uploads, String(req.userId), `simple-${Date.now().toString(36)}-${randomHex(4)}`);
    await fsp.mkdir(path.dirname(tmp), { recursive: true });

    const controller = new AbortController();
    req.on('aborted', () => controller.abort());

    let written = 0;
    const out = fsp.open ? await fsp.open(tmp, 'w') : null;
    try {
      for await (const chunk of req) {
        written += chunk.length;
        if (written > config.limits.maxUploadSize) {
          controller.abort();
          throw ApiError.payload('File exceeds the maximum upload size');
        }
        await out.write(chunk);
      }
    } finally {
      await out?.close();
    }
    if (written === 0) {
      await fsp.unlink(tmp).catch(() => {});
      throw ApiError.badRequest('No data received');
    }

    let file;
    try {
      file = await ingestLocalFile({ userId: req.userId, filePath: tmp, name, size: written, mime, folderId });
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
    log.info(`simple upload accepted: ${name} (${written} bytes)`);
    res.status(202).json({ fileId: file._id, status: file.status });
  }),
);

export default router;
