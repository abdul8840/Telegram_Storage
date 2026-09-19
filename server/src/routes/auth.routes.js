/** Account routes: signup, login, profile, password, and account deletion. */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import config from '../config.js';
import { db } from '../db/index.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { hashPassword, randomId, verifyPassword } from '../lib/crypto.js';
import { clearAuthCookie, publicUser, requireAuth, setAuthCookie, signToken } from '../middleware/auth.js';
import { createLogger } from '../lib/logger.js';
import { deleteForever } from '../services/files.js';
import { disconnectAccount } from '../storage/telegramClient.js';

const log = createLogger('auth');
const router = express.Router();

const now = () => new Date().toISOString();

const signupSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters').max(200),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, 'Password is required'),
});

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts — please wait a few minutes.' },
});

function defaultSettings() {
  return {
    storageProvider: config.storage.defaultProvider === 'telegram' ? 'telegram' : 'local',
    view: 'grid',
    sort: 'createdAt',
    order: 'desc',
    theme: 'dark',
    // Send videos as playable Telegram media when the codec allows it
    sendVideosAsMedia: true,
    // Keep photo originals as documents (Telegram re-compresses photos)
    imagesAsPhotos: false,
    uploadConcurrency: 3,
  };
}

router.post(
  '/signup',
  authLimiter,
  asyncHandler(async (req, res) => {
    const parsed = signupSchema.safeParse(req.body || {});
    if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message || 'Invalid signup data');
    const { name, email, password } = parsed.data;

    const existing = await db.users.findOne({ email });
    if (existing) throw ApiError.conflict('An account with that email already exists');

    const user = {
      _id: randomId(10),
      name,
      email,
      passwordHash: await hashPassword(password),
      role: (await db.users.countDocuments({})) === 0 ? 'owner' : 'user',
      settings: defaultSettings(),
      createdAt: now(),
      updatedAt: now(),
      lastLoginAt: now(),
    };
    await db.users.insertOne(user);
    log.info(`new account created: ${email} (${user.role})`);

    const token = signToken(user);
    setAuthCookie(res, token);
    res.status(201).json({ token, user: publicUser(user) });
  }),
);

router.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body || {});
    if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message || 'Invalid credentials');
    const { email, password } = parsed.data;

    const user = await db.users.findOne({ email });
    if (!user) throw ApiError.unauthorized('Incorrect email or password');
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw ApiError.unauthorized('Incorrect email or password');

    await db.users.updateOne({ _id: user._id }, { $set: { lastLoginAt: now() } });
    const token = signToken(user);
    setAuthCookie(res, token);
    res.json({ token, user: publicUser(user) });
  }),
);

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: publicUser(req.user) });
  }),
);

const profileSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  settings: z
    .object({
      storageProvider: z.enum(['telegram', 'local']).optional(),
      view: z.enum(['grid', 'list']).optional(),
      sort: z.string().optional(),
      order: z.enum(['asc', 'desc']).optional(),
      theme: z.enum(['dark', 'light']).optional(),
      sendVideosAsMedia: z.boolean().optional(),
      imagesAsPhotos: z.boolean().optional(),
      uploadConcurrency: z.number().int().min(1).max(8).optional(),
    })
    .optional(),
});

router.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = profileSchema.safeParse(req.body || {});
    if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message || 'Invalid profile data');
    const patch = { updatedAt: now() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.settings) patch.settings = { ...(req.user.settings || {}), ...parsed.data.settings };
    await db.users.updateOne({ _id: req.userId }, { $set: patch });
    const user = await db.users.findOne({ _id: req.userId });
    res.json({ user: publicUser(user) });
  }),
);

router.post(
  '/change-password',
  requireAuth,
  authLimiter,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) throw ApiError.badRequest('Current and new password are required');
    if (String(newPassword).length < 6) throw ApiError.badRequest('New password must be at least 6 characters');
    const ok = await verifyPassword(String(currentPassword), req.user.passwordHash);
    if (!ok) throw ApiError.unauthorized('Current password is incorrect');
    await db.users.updateOne({ _id: req.userId }, { $set: { passwordHash: await hashPassword(String(newPassword)), updatedAt: now() } });
    res.json({ ok: true });
  }),
);

/** Deletes the account, its metadata and every stored object. */
router.delete(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.userId;
    const files = await db.files.find({ userId }, { projection: { _id: 1 } });
    await deleteForever({ userId, fileIds: files.map((f) => f._id) }).catch((err) => log.warn(`account cleanup: ${err.message}`));
    await disconnectAccount(userId).catch(() => {});
    await Promise.all([
      db.folders.deleteMany({ userId }),
      db.shares.deleteMany({ userId }),
      db.jobs.deleteMany({ userId }),
      db.uploads.deleteMany({ userId }),
      db.tgAccounts.deleteMany({ userId }),
      db.activity.deleteMany({ userId }),
      db.users.deleteOne({ _id: userId }),
    ]);
    clearAuthCookie(res);
    res.json({ ok: true, deletedFiles: files.length });
  }),
);

export default router;
