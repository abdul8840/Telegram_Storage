/** Share-link management for the owner. */
import express from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { createShare, listShares, revokeShare, updateShare } from '../services/shares.js';

const router = express.Router();
router.use(requireAuth);

const createSchema = z.object({
  fileId: z.string().min(1),
  expiresInDays: z.coerce.number().min(0).max(3650).optional(),
  password: z.string().min(1).max(200).nullable().optional(),
  note: z.string().max(200).nullable().optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ shares: await listShares(req.userId, { fileId: req.query.fileId ? String(req.query.fileId) : null }) });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body || {});
    if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message || 'Invalid share request');
    const { fileId, expiresInDays, password, note } = parsed.data;
    const expiresAt = expiresInDays && expiresInDays > 0 ? new Date(Date.now() + expiresInDays * 86400000).toISOString() : null;
    const share = await createShare({ userId: req.userId, fileId, expiresAt, password: password || null, note: note || null });
    res.status(201).json({ share });
  }),
);

router.patch(
  '/:token',
  asyncHandler(async (req, res) => {
    const { password, expiresInDays, note } = req.body || {};
    const expiresAt = expiresInDays === undefined ? undefined : expiresInDays > 0 ? new Date(Date.now() + Number(expiresInDays) * 86400000).toISOString() : null;
    const share = await updateShare({
      userId: req.userId,
      token: req.params.token,
      expiresAt,
      password: password === undefined ? undefined : password || null,
      note,
    });
    res.json({ share });
  }),
);

router.delete(
  '/:token',
  asyncHandler(async (req, res) => {
    res.json(await revokeShare({ userId: req.userId, token: req.params.token }));
  }),
);

export default router;
