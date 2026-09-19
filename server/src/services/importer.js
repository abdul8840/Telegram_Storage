/**
 * Import existing Telegram media into the drive.
 *
 * Useful the first time you connect: everything already sitting in Saved
 * Messages (or your cloud channel) becomes part of the library — indexed,
 * searchable, thumbnail-able and streamable — without re-uploading a byte.
 */
import { db } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import { userBus } from '../lib/events.js';
import { randomId } from '../lib/crypto.js';
import { extOf, kindOf, mimeOf, sanitizeFileName } from '../lib/fileTypes.js';
import { publicFile } from './files.js';
import { enqueueRegenerate } from './jobs.js';

const log = createLogger('importer');
const now = () => new Date().toISOString();

/**
 * @param {object} opts
 * @param {string} opts.userId
 * @param {Array}  opts.items     entries from telegramProvider.listRemote()
 * @param {string|null} opts.folderId  destination folder in the drive
 * @param {boolean} opts.thumbnails    queue a metadata/thumbnail pass per file
 */
export async function importFromTelegram({ userId, items = [], folderId = null, thumbnails = true }) {
  const imported = [];
  const skipped = [];

  for (const item of items) {
    const documentId = item.storage?.documentId;
    if (!documentId) {
      skipped.push({ name: item.name, reason: 'not a document' });
      continue;
    }
    const existing = await db.files.findOne({ userId, 'storage.documentId': documentId, 'storage.messageId': item.storage.messageId });
    if (existing) {
      skipped.push({ name: item.name, reason: 'already in library', fileId: existing._id });
      imported.push(publicFile(existing));
      continue;
    }

    const name = sanitizeFileName(item.name || `telegram-${item.messageId}`);
    const mime = item.mimeType || mimeOf(name);
    const doc = {
      _id: randomId(12),
      userId,
      name,
      originalName: name,
      ext: extOf(name),
      mime,
      kind: kindOf(name, mime),
      size: Number(item.size) || 0,
      folderId: folderId || null,
      provider: 'telegram',
      storage: item.storage,
      media: item.duration ? { duration: Number(item.duration) } : null,
      thumb: null,
      preview: null,
      starred: false,
      trashed: false,
      trashedAt: null,
      status: 'ready',
      progress: 100,
      error: null,
      derivedFrom: null,
      derivatives: [],
      tags: ['imported'],
      checksum: null,
      downloadCount: 0,
      viewCount: 0,
      importedFromTelegram: true,
      telegramDate: item.date || null,
      createdAt: item.date || now(),
      updatedAt: now(),
      uploadedAt: item.date || now(),
      providerNote: null,
    };
    await db.files.insertOne(doc);
    userBus(String(userId)).emit('file:created', { file: publicFile(doc) });
    imported.push(publicFile(doc));

    if (thumbnails) {
      // Downloads the object once to learn codecs and build a thumbnail.
      enqueueRegenerate({ userId, fileId: doc._id }).catch((err) => log.warn(`thumbnail pass failed for ${name}: ${err.message}`));
    }
  }

  log.info(`imported ${imported.length} item(s) from Telegram (${skipped.length} skipped)`);
  return { imported: imported.length, skipped: skipped.length, files: imported, details: skipped };
}

export default { importFromTelegram };
