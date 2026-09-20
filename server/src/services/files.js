/**
 * Library service: everything the drive UI asks for — listing, filtering,
 * search, rename/move, star, trash/restore, permanent delete and statistics.
 *
 * It also computes the playability metadata the browser needs, e.g. whether a
 * video can be played natively or must be transcoded first (iPhone HEVC .mov).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import config from '../config.js';
import { db } from '../db/index.js';
import { ApiError } from '../lib/errors.js';
import { userBus } from '../lib/events.js';
import {
  KIND,
  extOf,
  formatDuration,
  isHeicImage,
  isHevc,
  isPdf,
  isPlayableAudio,
  isTextPreviewable,
  sanitizeFileName,
  videoCompatibility,
} from '../lib/fileTypes.js';
import { getProviderForFile } from '../storage/index.js';
import { deleteThumbnails, thumbPathsFor } from './media.js';
import { deleteSharesForFile } from './shares.js';
import { descendantIds, escapeRegExp, folderPathOf } from './folders.js';
import { publicFile as basePublicFile } from './uploadManager.js';

const now = () => new Date().toISOString();

function emit(userId, event, payload) {
  userBus(String(userId)).emit(event, payload);
}

/** Determines how the client should preview a file. */
export function previewKind(file) {
  const media = file.media || {};
  const name = file.name || '';
  const mime = file.mime || '';
  if (file.status !== 'ready') return 'pending';
  if (file.kind === KIND.VIDEO) {
    const compatibility = videoCompatibility(name, media);
    if (compatibility.mode === 'native') return 'video';
    if (compatibility.mode === 'conditional') return 'video-conditional';
    if (compatibility.mode === 'attempt') return 'video-native-attempt';
    return 'video-transcode';
  }
  if (file.kind === KIND.AUDIO) return isPlayableAudio(name, media) ? 'audio' : 'download';
  if (file.kind === KIND.IMAGE) {
    if (isHeicImage(name, mime)) return file.preview?.path ? 'image-preview' : 'heic';
    const ext = extOf(name);
    if (['tiff', 'tif', 'dng', 'cr2', 'nef', 'arw', 'raf', 'rw2', 'bmp'].includes(ext)) return file.preview?.path ? 'image-preview' : 'download';
    return 'image';
  }
  if (isPdf(name, mime)) return 'pdf';
  if (isTextPreviewable(name, mime)) return 'text';
  if (file.kind === KIND.DOC) return 'office';
  return 'download';
}

/** Full client-facing shape (base fields + playability/preview metadata). */
export function publicFile(file) {
  if (!file) return null;
  const media = file.media || {};
  const base = basePublicFile(file);
  const kind = previewKind(file);
  const compatibility = file.kind === KIND.VIDEO ? videoCompatibility(file.name || '', media) : null;
  return {
    ...base,
    previewKind: kind,
    playable: kind === 'video' || kind === 'video-conditional' || kind === 'video-native-attempt' || kind === 'audio' || kind === 'image' || kind === 'image-preview' || kind === 'pdf' || kind === 'text',
    needsTranscode: kind === 'video-transcode',
    hevc: isHevc(file.name || '', media),
    videoCompatibility: compatibility,
    conversionStrategy: compatibility?.strategy || null,
    durationText: media.duration ? formatDuration(media.duration) : null,
    hasPreviewRendition: !!file.preview?.path,
    hasDerivative: Array.isArray(file.derivatives) && file.derivatives.length > 0,
    derivedFrom: file.derivedFrom || null,
  };
}

const VIEW_KINDS = {
  photos: [KIND.IMAGE],
  videos: [KIND.VIDEO],
  audio: [KIND.AUDIO],
  docs: [KIND.DOC, KIND.TEXT],
  archives: [KIND.ARCHIVE],
};

export async function listFiles({
  userId,
  view = 'folder',
  folderId = null,
  kind = null,
  q = '',
  sort = 'createdAt',
  order = 'desc',
  page = 1,
  limit = 60,
  starred = false,
  provider = null,
  needsTranscode = null,
  includeFolders = true,
}) {
  const query = { userId };
  const isTrash = view === 'trash';
  query.trashed = isTrash;

  const recursive = ['all', 'recent', 'photos', 'videos', 'audio', 'docs', 'archives', 'starred', 'trash', 'search'].includes(view);
  if (!recursive) query.folderId = folderId || null;

  if (view === 'starred' || starred) query.starred = true;
  if (VIEW_KINDS[view]) query.kind = { $in: VIEW_KINDS[view] };
  else if (kind && VIEW_KINDS[kind]) query.kind = { $in: VIEW_KINDS[kind] };
  else if (kind) query.kind = kind;
  if (provider) query.provider = provider;

  if (q) {
    const rx = { $regex: escapeRegExp(q).replace(/\\\*/g, '.*'), $options: 'i' };
    query.$or = [{ name: rx }, { 'media.title': rx }, { tags: rx }];
  }

  const sortSpec = { [SORTABLE[sort] || 'createdAt']: order === 'asc' ? 1 : -1 };
  // Keep a stable secondary order so pagination never repeats/drops rows.
  sortSpec._id = 1;

  const perPage = Math.max(1, Math.min(Number(limit) || 60, 500));
  const currentPage = Math.max(1, Number(page) || 1);
  const [items, total] = await Promise.all([
    db.files.find(query, { sort: sortSpec, limit: perPage, skip: (currentPage - 1) * perPage }),
    db.files.countDocuments(query),
  ]);

  let decorated = items.map(publicFile);
  if (needsTranscode === true) decorated = decorated.filter((f) => f.needsTranscode);
  if (needsTranscode === false) decorated = decorated.filter((f) => !f.needsTranscode);

  let folders = [];
  if (includeFolders && !recursive) {
    const folderDocs = await db.folders.find({ userId, parentId: folderId || null }, { sort: { name: 1 } });
    folders = folderDocs.map((f) => ({
      ...f,
      id: f._id,
      isFolder: true,
      path: null,
    }));
  }

  return {
    items: decorated,
    folders,
    total,
    page: currentPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
    limit: perPage,
    view,
    folderId,
    folderPath: recursive ? null : await folderPathOf(userId, folderId),
  };
}

const SORTABLE = {
  createdAt: 'createdAt',
  uploadedAt: 'uploadedAt',
  name: 'name',
  size: 'size',
  kind: 'kind',
  updatedAt: 'updatedAt',
  downloadCount: 'downloadCount',
  viewCount: 'viewCount',
};

export async function getFile({ userId, fileId, includeBreadcrumb = true }) {
  const file = await db.files.findOne({ _id: fileId, userId });
  if (!file) throw ApiError.notFound('File not found');
  const decorated = publicFile(file);
  if (includeBreadcrumb) {
    decorated.folderPath = await folderPathOf(userId, file.folderId || null);
    decorated.breadcrumb = await breadcrumb(userId, file.folderId || null);
  }
  // Record a view (used for "recently opened" and stats).
  await db.files.updateOne({ _id: fileId }, { $inc: { viewCount: 1 }, $set: { lastViewedAt: now() } }).catch(() => {});
  return decorated;
}

export async function breadcrumb(userId, folderId) {
  if (!folderId) return [];
  const all = await db.folders.find({ userId });
  const byId = new Map(all.map((f) => [f._id, f]));
  const trail = [];
  let current = byId.get(folderId);
  let guard = 0;
  while (current && guard < 64) {
    trail.unshift({ id: current._id, name: current.name });
    current = current.parentId ? byId.get(current.parentId) : null;
    guard += 1;
  }
  return trail;
}

export async function getFileDoc(userId, fileId) {
  const file = await db.files.findOne({ _id: fileId, userId });
  if (!file) throw ApiError.notFound('File not found');
  return file;
}

export async function renameFile({ userId, fileId, name }) {
  const file = await getFileDoc(userId, fileId);
  const clean = sanitizeFileName(name);
  if (!clean) throw ApiError.badRequest('File name cannot be empty');
  await db.files.updateOne({ _id: fileId }, { $set: { name: clean, ext: extOf(clean), updatedAt: now() } });
  const updated = publicFile({ ...file, name: clean, ext: extOf(clean) });
  emit(userId, 'file:updated', { file: updated });
  return updated;
}

export async function moveFiles({ userId, fileIds, folderId }) {
  if (folderId) {
    const folder = await db.folders.findOne({ _id: folderId, userId });
    if (!folder) throw ApiError.badRequest('Destination folder not found');
  }
  const ids = [].concat(fileIds || []);
  if (!ids.length) throw ApiError.badRequest('No files selected');
  await db.files.updateMany({ _id: { $in: ids }, userId }, { $set: { folderId: folderId || null, updatedAt: now() } });
  const files = await db.files.find({ _id: { $in: ids }, userId });
  const decorated = files.map(publicFile);
  emit(userId, 'files:moved', { fileIds: ids, folderId: folderId || null, files: decorated });
  return { moved: files.length, files: decorated };
}

export async function setStarred({ userId, fileIds, starred }) {
  const ids = [].concat(fileIds || []);
  await db.files.updateMany({ _id: { $in: ids }, userId }, { $set: { starred: !!starred, updatedAt: now() } });
  const files = await db.files.find({ _id: { $in: ids }, userId });
  emit(userId, 'files:updated', { files: files.map(publicFile) });
  return { updated: files.length, files: files.map(publicFile) };
}

export async function trashFiles({ userId, fileIds, folderIds = [] }) {
  const ids = [].concat(fileIds || []);
  let trashedFolders = [];
  if (folderIds.length) {
    for (const folderId of folderIds) {
      const descendants = await descendantIds(userId, folderId);
      trashedFolders.push(folderId, ...descendants);
    }
  }
  const query = { userId, trashed: false };
  if (ids.length && trashedFolders.length) query.$or = [{ _id: { $in: ids } }, { folderId: { $in: trashedFolders } }];
  else if (ids.length) query._id = { $in: ids };
  else if (trashedFolders.length) query.folderId = { $in: trashedFolders };
  else throw ApiError.badRequest('Nothing selected');

  const res = await db.files.updateMany(query, { $set: { trashed: true, trashedAt: now(), updatedAt: now() } });
  for (const folderId of trashedFolders) {
    await db.folders.updateOne({ _id: folderId, userId }, { $set: { trashed: true, trashedAt: now() } }).catch(() => {});
  }
  emit(userId, 'files:trashed', { count: res.modifiedCount || 0, fileIds: ids, folderIds: trashedFolders });
  return { trashed: res.modifiedCount || 0, folders: trashedFolders };
}

export async function restoreFiles({ userId, fileIds, folderIds = [] }) {
  const ids = [].concat(fileIds || []);
  if (ids.length) await db.files.updateMany({ _id: { $in: ids }, userId }, { $set: { trashed: false, trashedAt: null, updatedAt: now() } });
  for (const folderId of folderIds) {
    await db.folders.updateOne({ _id: folderId, userId }, { $set: { trashed: false, trashedAt: null } }).catch(() => {});
  }
  const files = ids.length ? await db.files.find({ _id: { $in: ids }, userId }) : [];
  emit(userId, 'files:restored', { fileIds: ids, files: files.map(publicFile) });
  return { restored: files.length, files: files.map(publicFile) };
}

/**
 * Permanent deletion removes the bytes from Telegram (or a legacy local
 * object), the derived images, share links, and finally the database document.
 */
export async function deleteForever({ userId, fileIds }) {
  const ids = [].concat(fileIds || []);
  if (!ids.length) throw ApiError.badRequest('Nothing selected');
  const files = await db.files.find({ _id: { $in: ids }, userId });
  const results = { deleted: 0, failed: [] };

  for (const file of files) {
    try {
      if (file.storage) {
        const provider = getProviderForFile(file);
        await provider.delete({ userId, storage: file.storage, fileId: file._id });
      }
      await deleteThumbnails(file._id);
      await deleteSharesForFile(file._id);
      await db.files.deleteOne({ _id: file._id, userId });
      if (file.derivedFrom) {
        await db.files.updateOne({ _id: file.derivedFrom, userId }, { $pull: { derivatives: file._id } }).catch(() => {});
      }
      results.deleted += 1;
      emit(userId, 'file:deleted', { fileId: file._id, name: file.name });
    } catch (err) {
      results.failed.push({ fileId: file._id, name: file.name, error: err.message });
    }
  }
  return results;
}

export async function emptyTrash(userId) {
  const files = await db.files.find({ userId, trashed: true });
  const res = await deleteForever({ userId, fileIds: files.map((f) => f._id) });
  await db.folders.deleteMany({ userId, trashed: true }).catch(() => {});
  return { ...res, purged: files.length };
}

/** Deletes trashed files older than TRASH_AUTO_PURGE_DAYS. */
export async function purgeOldTrash({ olderThanDays = config.trash.autoPurgeDays } = {}) {
  if (!olderThanDays) return 0;
  const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
  const files = await db.files.find({ trashed: true, trashedAt: { $lt: cutoff } });
  if (!files.length) return 0;
  let purged = 0;
  const byUser = new Map();
  for (const file of files) {
    if (!byUser.has(file.userId)) byUser.set(file.userId, []);
    byUser.get(file.userId).push(file._id);
  }
  for (const [userId, ids] of byUser) {
    const res = await deleteForever({ userId, fileIds: ids });
    purged += res.deleted;
  }
  return purged;
}

export async function getStats(userId) {
  const [files, folders, shares, jobs] = await Promise.all([
    db.files.find({ userId, trashed: false }),
    db.folders.countDocuments({ userId, trashed: { $ne: true } }),
    db.shares.countDocuments({ userId, revoked: false }),
    db.jobs.find({
      userId,
      status: { $in: ['queued', 'running'] },
      workerScope: config.telegram.sessionScope,
    }),
  ]);

  const byKind = {};
  const byProvider = {};
  const byStatus = {};
  let totalSize = 0;
  let playable = 0;
  let needsTranscode = 0;
  let starred = 0;
  let hevcCount = 0;

  for (const file of files) {
    const size = Number(file.size) || 0;
    totalSize += size;
    const kind = file.kind || KIND.OTHER;
    byKind[kind] = byKind[kind] || { count: 0, size: 0 };
    byKind[kind].count += 1;
    byKind[kind].size += size;

    const provider = file.provider || 'unknown';
    byProvider[provider] = byProvider[provider] || { count: 0, size: 0 };
    byProvider[provider].count += 1;
    byProvider[provider].size += size;

    const status = file.status || 'ready';
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (file.starred) starred += 1;

    const preview = previewKind(file);
    if (['video', 'audio', 'image', 'image-preview'].includes(preview)) playable += 1;
    if (preview === 'video-transcode') needsTranscode += 1;
    if (isHevc(file.name || '', file.media || {})) hevcCount += 1;
  }

  const trashedCount = await db.files.countDocuments({ userId, trashed: true });
  const recent = files
    .filter((f) => f.status === 'ready')
    .sort((a, b) => String(b.uploadedAt || b.createdAt).localeCompare(String(a.uploadedAt || a.createdAt)))
    .slice(0, 8)
    .map(publicFile);

  return {
    files: files.length,
    folders,
    totalSize,
    byKind,
    byProvider,
    byStatus,
    playable,
    needsTranscode,
    hevcCount,
    starred,
    shares,
    trashedCount,
    activeJobs: jobs.length,
    recent,
  };
}

/** Reads the beginning of a text-like file for the inline previewer. */
export async function textPreview(userId, file, { maxBytes = config.limits.maxTextPreviewBytes } = {}) {
  const provider = getProviderForFile(file);
  const bytes = Math.min(maxBytes, Number(file.size) || maxBytes);
  let buffer;
  if (provider.name === 'local' && typeof provider.readPrefix === 'function') {
    buffer = await provider.readPrefix({ userId, storage: file.storage, bytes });
  } else {
    buffer = await provider.readPrefix({ userId, storage: file.storage, bytes });
  }
  const truncated = (Number(file.size) || 0) > buffer.length;
  // Reject binaries (e.g. a .log full of NULs) rather than sending garbage.
  const nul = buffer.slice(0, 4096).filter((b) => b === 0).length;
  if (nul > 8) return { binary: true, truncated, content: null };
  return { binary: false, truncated, content: buffer.toString('utf8'), encoding: 'utf-8' };
}

export async function thumbnailPath(file) {
  if (file.thumb?.path && fs.existsSync(file.thumb.path)) return file.thumb.path;
  const paths = thumbPathsFor(file._id);
  if (fs.existsSync(paths.main)) return paths.main;
  return null;
}

export async function previewPath(file) {
  if (file.preview?.path && fs.existsSync(file.preview.path)) return file.preview.path;
  const paths = thumbPathsFor(file._id);
  if (fs.existsSync(paths.preview)) return paths.preview;
  return null;
}

/** Marks a file as viewed from a stream request (best effort). */
export async function touchFile(fileId) {
  await db.files
    .updateOne({ _id: fileId }, { $inc: { downloadCount: 1 }, $set: { lastAccessedAt: now() } })
    .catch(() => {});
}

export async function ensurePayloadForProcessing(file) {
  if (!file.localPayloadPath) throw ApiError.badRequest('This file has no local payload to reprocess');
  const exists = await fsp.stat(file.localPayloadPath).catch(() => null);
  if (!exists) throw ApiError.badRequest('The temporary payload is gone');
  return file.localPayloadPath;
}

export default {
  listFiles,
  getFile,
  publicFile,
  previewKind,
  renameFile,
  moveFiles,
  setStarred,
  trashFiles,
  restoreFiles,
  deleteForever,
  emptyTrash,
  purgeOldTrash,
  getStats,
  textPreview,
  thumbnailPath,
  previewPath,
  touchFile,
  breadcrumb,
};
