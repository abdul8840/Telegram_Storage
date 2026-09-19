/**
 * Public share endpoints (no authentication).
 *
 * Password-protected links work like this: the visitor POSTs the password once
 * to /unlock, we hand back a short-lived signed cookie, and the browser then
 * sends it automatically with the <video>/<img>/download requests that follow —
 * which is the only way to protect media URLs that cannot carry headers.
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import config from '../config.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { db } from '../db/index.js';
import { publicShare, publicSharedFile, registerShareAccess, resolvePublicShare } from '../services/shares.js';
import { sendLocalFile, streamFile } from '../services/streaming.js';
import { previewPath, thumbnailPath } from '../services/files.js';

const log = createLogger('public');
const router = express.Router();

const unlockLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 25,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a moment.' },
});

const cookieName = (token) => `tgc_share_${token}`.slice(0, 60);

function signSharePass(token) {
  return jwt.sign({ share: token }, config.jwt.secret, { expiresIn: '4h' });
}

function hasSharePass(req, token) {
  const value = req.cookies?.[cookieName(token)];
  if (!value) return false;
  try {
    return jwt.verify(value, config.jwt.secret)?.share === token;
  } catch {
    return false;
  }
}

function setSharePass(res, token) {
  res.cookie(cookieName(token), signSharePass(token), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: 4 * 3600 * 1000,
    path: '/',
  });
}

async function resolve(token, req, { password = null } = {}) {
  const effectivePassword = password || (hasSharePass(req, token) ? '__cookie__' : null);
  if (effectivePassword === '__cookie__') {
    // Cookie proves the password was already accepted → bypass the check by
    // resolving without a password requirement.
    const share = await db.shares.findOne({ token, revoked: false });
    if (!share) throw ApiError.notFound('This share link is invalid or has been revoked');
    if (share.expiresAt && share.expiresAt < new Date().toISOString()) throw ApiError.forbidden('This share link has expired');
    const file = await db.files.findOne({ _id: share.fileId });
    if (!file || file.status !== 'ready' || file.trashed) throw ApiError.notFound('The shared file is no longer available');
    return { share, file };
  }
  return resolvePublicShare(token, { password: effectivePassword });
}

router.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const token = String(req.params.token);
    const password = req.query.password ? String(req.query.password) : null;
    try {
      const { share, file } = await resolve(token, req, { password });
      if (share.passwordHash && password) setSharePass(res, token);
      await registerShareAccess(token);
      res.json({ share: publicShare(share), file: publicSharedFile(file, share) });
    } catch (err) {
      if (err.code === 'PASSWORD_REQUIRED') {
        return res.status(401).json({ error: err.message, code: 'PASSWORD_REQUIRED', share: { token, protected: true } });
      }
      throw err;
    }
  }),
);

router.post(
  '/:token/unlock',
  unlockLimiter,
  asyncHandler(async (req, res) => {
    const token = String(req.params.token);
    const password = String(req.body?.password || '');
    const { share, file } = await resolvePublicShare(token, { password });
    if (share.passwordHash) setSharePass(res, token);
    await registerShareAccess(token);
    log.info(`share ${token} unlocked`);
    res.json({ share: publicShare(share), file: publicSharedFile(file, share) });
  }),
);

const publicStream = (download) =>
  asyncHandler(async (req, res) => {
    const token = String(req.params.token);
    const { share, file } = await resolve(token, req);
    await registerShareAccess(token, { download });
    await streamFile(req, res, { file, userId: share.userId, download });
  });

router.get('/:token/stream', publicStream(false));
router.head('/:token/stream', publicStream(false));
router.get('/:token/download', publicStream(true));

router.get(
  '/:token/thumbnail',
  asyncHandler(async (req, res) => {
    const token = String(req.params.token);
    const { share, file } = await resolve(token, req);
    const localPath = await thumbnailPath(file);
    if (!localPath) throw ApiError.notFound('No thumbnail for this file');
    await sendLocalFile(req, res, localPath, { contentType: 'image/jpeg', cache: 'public, max-age=86400' });
  }),
);

router.get(
  '/:token/preview',
  asyncHandler(async (req, res) => {
    const token = String(req.params.token);
    const { share, file } = await resolve(token, req);
    const localPath = await previewPath(file);
    if (localPath) return sendLocalFile(req, res, localPath, { contentType: 'image/jpeg', cache: 'public, max-age=86400' });
    return streamFile(req, res, { file, userId: share.userId, download: false });
  }),
);

export default router;
