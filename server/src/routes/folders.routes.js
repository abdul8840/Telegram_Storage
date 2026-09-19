/** Folder routes (virtual folders — Telegram itself stays flat). */
import express from 'express';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { buildFolderTree, createFolder, deleteFolder, descendantIds, ensureFolderPath, moveFolder, renameFolder } from '../services/folders.js';
import { deleteForever } from '../services/files.js';

const router = express.Router();
router.use(requireAuth);

/**
 * Creates a nested path like "Photos/2026/Trip" in one call, returning the leaf
 * folder id. Used when a whole directory tree is dropped onto the uploader.
 */
router.post(
  '/ensure-path',
  asyncHandler(async (req, res) => {
    const folderPath = String(req.body?.path || '').trim();
    if (!folderPath) throw ApiError.badRequest('path is required');
    const folderId = await ensureFolderPath({ userId: req.userId, folderPath });
    res.json({ folderId });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const result = await buildFolderTree(req.userId);
    res.json(result);
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, parentId } = req.body || {};
    if (!name) throw ApiError.badRequest('Folder name is required');
    const folder = await createFolder({ userId: req.userId, name, parentId: parentId || null });
    res.status(201).json({ ...folder, id: folder._id });
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { name, parentId } = req.body || {};
    if (name !== undefined) {
      const folder = await renameFolder({ userId: req.userId, folderId: req.params.id, name });
      return res.json({ ...folder, id: folder._id });
    }
    if (parentId !== undefined) {
      const folder = await moveFolder({ userId: req.userId, folderId: req.params.id, parentId: parentId || null });
      return res.json({ ...folder, id: folder._id });
    }
    throw ApiError.badRequest('Nothing to update');
  }),
);

/**
 * mode=trash (default) → files inside move to Trash, folder is removed
 * mode=delete          → files are permanently removed from storage too
 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const mode = req.query.mode === 'delete' ? 'delete' : 'trash';
    if (mode === 'delete') {
      const ids = [req.params.id, ...(await descendantIds(req.userId, req.params.id))];
      const files = await db.files.find({ userId: req.userId, folderId: { $in: ids } }, { projection: { _id: 1 } });
      await deleteForever({ userId: req.userId, fileIds: files.map((f) => f._id) });
    }
    const result = await deleteFolder({ userId: req.userId, folderId: req.params.id, mode });
    res.json(result);
  }),
);

export default router;
