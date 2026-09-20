/**
 * Share links: public, token-addressed access to a single file with optional
 * password and expiry. Shared files stream through the same range-aware
 * endpoint as the owner's library, so a shared HEVC video is still seekable.
 */
import { db } from '../db/index.js';
import { ApiError } from '../lib/errors.js';
import { hashPassword, randomToken, verifyPassword } from '../lib/crypto.js';
import { publicFile } from './uploadManager.js';

const now = () => new Date().toISOString();

export async function createShare({ userId, fileId, expiresAt = null, password = null, note = null }) {
  const file = await db.files.findOne({ _id: fileId, userId });
  if (!file) throw ApiError.notFound('File not found');
  if (file.status !== 'ready') throw ApiError.badRequest('This file is still being processed — share it once it is ready');

  const token = randomToken(12);
  const doc = {
    _id: token,
    token,
    userId,
    fileId,
    name: file.name,
    size: file.size,
    kind: file.kind,
    passwordHash: password ? await hashPassword(String(password)) : null,
    expiresAt: expiresAt || null,
    maxDownloads: null,
    downloads: 0,
    views: 0,
    note: note || null,
    revoked: false,
    createdAt: now(),
  };
  await db.shares.insertOne(doc);
  return publicShare(doc);
}

export function publicShare(share) {
  if (!share) return null;
  const { passwordHash, userId, ...rest } = share;
  return {
    ...rest,
    id: share._id,
    protected: !!passwordHash,
    url: `/s/${share.token}`,
    expired: !!share.expiresAt && share.expiresAt < now(),
  };
}

export async function listShares(userId, { fileId = null } = {}) {
  const query = { userId, revoked: false };
  if (fileId) query.fileId = fileId;
  const shares = await db.shares.find(query, { sort: { createdAt: 'desc' } });
  return shares.map(publicShare);
}

export async function revokeShare({ userId, token }) {
  const share = await db.shares.findOne({ token, userId });
  if (!share) throw ApiError.notFound('Share link not found');
  await db.shares.updateOne({ token }, { $set: { revoked: true, updatedAt: now() } });
  return { ok: true };
}

export async function updateShare({ userId, token, expiresAt, password, note }) {
  const share = await db.shares.findOne({ token, userId });
  if (!share) throw ApiError.notFound('Share link not found');
  const patch = { updatedAt: now() };
  if (expiresAt !== undefined) patch.expiresAt = expiresAt || null;
  if (note !== undefined) patch.note = note || null;
  if (password !== undefined) patch.passwordHash = password ? await hashPassword(String(password)) : null;
  await db.shares.updateOne({ token }, { $set: patch });
  return publicShare({ ...share, ...patch });
}

/**
 * Resolves a public token → { share, file }. Throws 401 when a password is
 * required, so the public UI can prompt for it.
 */
export async function resolvePublicShare(token, { password = null } = {}) {
  const share = await db.shares.findOne({ token, revoked: false });
  if (!share) throw ApiError.notFound('This share link is invalid or has been revoked');
  if (share.expiresAt && share.expiresAt < now()) throw ApiError.forbidden('This share link has expired');
  if (share.passwordHash) {
    if (!password) {
      const err = ApiError.unauthorized('This link is password protected');
      err.code = 'PASSWORD_REQUIRED';
      throw err;
    }
    const ok = await verifyPassword(String(password), share.passwordHash);
    if (!ok) throw ApiError.unauthorized('Incorrect password for this link');
  }
  const file = await db.files.findOne({ _id: share.fileId });
  if (!file || file.status !== 'ready' || file.trashed) throw ApiError.notFound('The shared file is no longer available');
  return { share, file };
}

export async function registerShareAccess(token, { download = false } = {}) {
  const inc = download ? { downloads: 1, views: 1 } : { views: 1 };
  await db.shares
    .updateOne({ token }, { $inc: inc, $set: { lastAccessedAt: now() } })
    .catch(() => {});
}

/** Share links owned by a user whose files are deleted must go too. */
export async function deleteSharesForFile(fileId) {
  await db.shares.deleteMany({ fileId }).catch(() => {});
}

/** Finds a ready browser-native derivative while keeping the shared original. */
export async function browserCopyFor(file) {
  if (file?.kind !== 'video' || !Array.isArray(file.derivatives)) return null;
  for (const id of [...file.derivatives].reverse()) {
    const candidate = await db.files.findOne({ _id: id, userId: file.userId });
    if (!candidate || candidate.status !== 'ready' || candidate.trashed) continue;
    if (publicFile(candidate).previewKind === 'video') return candidate;
  }
  return null;
}

export async function publicSharedFile(file, share) {
  const base = publicFile(file);
  const browserCopy = await browserCopyFor(file);
  const playback = browserCopy ? publicFile(browserCopy) : null;
  return {
    ...base,
    ...(playback
      ? {
          previewKind: playback.previewKind,
          playable: playback.playable,
          needsTranscode: false,
          videoCompatibility: playback.videoCompatibility,
          browserCopyAvailable: true,
        }
      : {}),
    shareToken: share.token,
    streamUrl: `/api/public/${share.token}/stream`,
    downloadUrl: `/api/public/${share.token}/download`,
    thumbUrl: `/api/public/${share.token}/thumbnail`,
  };
}

export default {
  createShare,
  listShares,
  revokeShare,
  updateShare,
  resolvePublicShare,
  registerShareAccess,
  publicShare,
  deleteSharesForFile,
  browserCopyFor,
  publicSharedFile,
};
