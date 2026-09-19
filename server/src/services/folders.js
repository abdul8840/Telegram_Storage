/**
 * Folder helpers. Telegram has no folders, so the drive keeps a virtual folder
 * tree in MongoDB and stamps the path into the message caption. Renaming or
 * moving a folder is therefore instant and never touches Telegram.
 */
import { db } from '../db/index.js';
import { ApiError } from '../lib/errors.js';
import { randomId } from '../lib/crypto.js';
import { sanitizeFolderName } from '../lib/fileTypes.js';

const now = () => new Date().toISOString();

export async function createFolder({ userId, name, parentId = null }) {
  const clean = sanitizeFolderName(name);
  if (!clean) throw ApiError.badRequest('Folder name cannot be empty');
  if (parentId) {
    const parent = await db.folders.findOne({ _id: parentId, userId });
    if (!parent) throw ApiError.badRequest('Parent folder not found');
  }
  const duplicate = await db.folders.findOne({ userId, parentId: parentId || null, name: { $regex: `^${escapeRegExp(clean)}$`, $options: 'i' } });
  if (duplicate) throw ApiError.conflict(`A folder named "${clean}" already exists here`);

  const doc = {
    _id: randomId(10),
    userId,
    name: clean,
    parentId: parentId || null,
    color: null,
    createdAt: now(),
    updatedAt: now(),
  };
  await db.folders.insertOne(doc);
  return doc;
}

export async function renameFolder({ userId, folderId, name }) {
  const clean = sanitizeFolderName(name);
  if (!clean) throw ApiError.badRequest('Folder name cannot be empty');
  const folder = await db.folders.findOne({ _id: folderId, userId });
  if (!folder) throw ApiError.notFound('Folder not found');
  await db.folders.updateOne({ _id: folderId }, { $set: { name: clean, updatedAt: now() } });
  return { ...folder, name: clean };
}

export async function moveFolder({ userId, folderId, parentId }) {
  const folder = await db.folders.findOne({ _id: folderId, userId });
  if (!folder) throw ApiError.notFound('Folder not found');
  if (parentId === folderId) throw ApiError.badRequest('A folder cannot be moved into itself');
  if (parentId) {
    const parent = await db.folders.findOne({ _id: parentId, userId });
    if (!parent) throw ApiError.badRequest('Destination folder not found');
    // Prevent cycles: the destination must not be a descendant of the folder.
    const descendants = await descendantIds(userId, folderId);
    if (descendants.has(parentId)) throw ApiError.badRequest('Cannot move a folder inside one of its own subfolders');
  }
  await db.folders.updateOne({ _id: folderId }, { $set: { parentId: parentId || null, updatedAt: now() } });
  return { ...folder, parentId: parentId || null };
}

export async function deleteFolder({ userId, folderId, mode = 'trash' }) {
  const folder = await db.folders.findOne({ _id: folderId, userId });
  if (!folder) throw ApiError.notFound('Folder not found');
  const ids = [folderId, ...(await descendantIds(userId, folderId))];

  if (mode === 'delete') {
    // Permanently remove: caller handles storage deletion for the files.
    await db.folders.deleteMany({ _id: { $in: ids }, userId });
    await db.files.deleteMany({ userId, folderId: { $in: ids } });
  } else {
    await db.files.updateMany({ userId, folderId: { $in: ids } }, { $set: { trashed: true, trashedAt: now(), updatedAt: now() } });
    await db.folders.deleteMany({ _id: { $in: ids }, userId });
  }
  return { removedFolderIds: ids };
}

export async function descendantIds(userId, folderId) {
  const all = await db.folders.find({ userId });
  const childrenOf = new Map();
  for (const f of all) {
    const key = f.parentId || null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(f._id);
  }
  const out = [];
  const stack = [folderId];
  while (stack.length) {
    const current = stack.pop();
    for (const child of childrenOf.get(current) || []) {
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

/** Ensures /a/b/c exists, creating missing levels. Returns the leaf folder id. */
export async function ensureFolderPath({ userId, folderPath }) {
  const parts = String(folderPath || '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  let parentId = null;
  for (const part of parts) {
    const existing = await db.folders.findOne({ userId, parentId: parentId || null, name: part });
    if (existing) {
      parentId = existing._id;
    } else {
      const created = await createFolder({ userId, name: part, parentId });
      parentId = created._id;
    }
  }
  return parentId;
}

export async function folderPathOf(userId, folderId) {
  if (!folderId) return '/';
  const all = await db.folders.find({ userId });
  const byId = new Map(all.map((f) => [f._id, f]));
  const parts = [];
  let current = byId.get(folderId);
  let guard = 0;
  while (current && guard < 64) {
    parts.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : null;
    guard += 1;
  }
  return `/${parts.join('/')}`;
}

/** Builds a tree (with per-folder counts and sizes) for the sidebar. */
export async function buildFolderTree(userId, { counts = true } = {}) {
  const folders = await db.folders.find({ userId }, { sort: { name: 1 } });
  const nodes = new Map(
    folders.map((f) => [
      f._id,
      { ...f, id: f._id, children: [], fileCount: 0, size: 0, path: '' },
    ]),
  );
  const roots = [];
  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId)) nodes.get(node.parentId).children.push(node);
    else roots.push(node);
  }
  // Materialised paths make breadcrumbs cheap on the client.
  const setPaths = (list, prefix) => {
    for (const node of list) {
      node.path = `${prefix}/${node.name}`;
      setPaths(node.children, node.path);
    }
  };
  setPaths(roots, '');

  if (counts) {
    const files = await db.files.find({ userId, trashed: false }, { projection: { folderId: 1, size: 1 } });
    const direct = new Map();
    for (const file of files) {
      const key = file.folderId || null;
      const entry = direct.get(key) || { count: 0, size: 0 };
      entry.count += 1;
      entry.size += Number(file.size) || 0;
      direct.set(key, entry);
    }
    const roll = (node) => {
      let count = direct.get(node._id)?.count || 0;
      let size = direct.get(node._id)?.size || 0;
      for (const child of node.children) {
        const rolled = roll(child);
        count += rolled.count;
        size += rolled.size;
      }
      node.fileCount = count;
      node.size = size;
      return { count, size };
    };
    roots.forEach(roll);
    return { tree: roots, rootCount: direct.get(null)?.count || 0, rootSize: direct.get(null)?.size || 0 };
  }
  return { tree: roots };
}

export function escapeRegExp(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default { createFolder, renameFolder, moveFolder, deleteFolder, buildFolderTree, folderPathOf, ensureFolderPath, descendantIds };
