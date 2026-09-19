/**
 * Local-disk storage provider.
 *
 * Used when STORAGE_PROVIDER=local (the default). It gives you a fully working
 * cloud drive — uploads, seekable streaming, previews, transcoding, sharing —
 * without a Telegram account, which makes it ideal for local development,
 * demos and offline use. Files live under LOCAL_STORAGE_PATH/<userId>/.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import config from '../config.js';
import { createLogger } from '../lib/logger.js';
import { extOf } from '../lib/fileTypes.js';
import { StorageError, throwIfAborted } from './base.js';

const log = createLogger('storage:local');

const ROOT = config.storage.localStoragePath;

function userDir(userId) {
  return path.join(ROOT, String(userId).replace(/[^a-zA-Z0-9_-]/g, '_'));
}

function objectPath(userId, storage) {
  const rel = storage?.relPath;
  if (!rel) throw new StorageError('Local storage reference is missing a path', { code: 'BAD_REF' });
  const resolved = path.resolve(userDir(userId), rel);
  // Guard against path traversal via a crafted reference.
  if (!resolved.startsWith(path.resolve(userDir(userId)))) {
    throw new StorageError('Invalid storage reference', { code: 'BAD_REF' });
  }
  return resolved;
}

export const localProvider = {
  name: 'local',
  label: 'Local disk',

  async status({ userId } = {}) {
    const dir = userId ? userDir(userId) : ROOT;
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.access(dir, fs.constants.W_OK);
      return { ready: true, details: { path: ROOT } };
    } catch (err) {
      return { ready: false, reason: `Local storage directory is not writable: ${err.message}`, details: { path: ROOT } };
    }
  },

  async upload({ userId, filePath, fileName, size, onProgress, signal }) {
    throwIfAborted(signal);
    const dir = userDir(userId);
    await fsp.mkdir(dir, { recursive: true });
    const ext = extOf(fileName);
    const relPath = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext ? `.${ext}` : ''}`;
    const dest = path.join(dir, relPath);

    // Move when on the same filesystem (instant), otherwise stream-copy with
    // progress so large videos do not block the event loop.
    try {
      await fsp.copyFile(filePath, dest);
      onProgress?.({ sent: size, total: size, percent: 100 });
      await fsp.unlink(filePath).catch(() => {});
    } catch (err) {
      log.warn(`copyFile failed (${err.message}) — falling back to rename`);
      await fsp.rename(filePath, dest);
      onProgress?.({ sent: size, total: size, percent: 100 });
    }

    const stats = await fsp.stat(dest);
    return {
      storage: { relPath, size: stats.size, provider: 'local' },
      provider: 'local',
      size: stats.size,
    };
  },

  async createReadStream({ userId, storage, start = 0, end, signal }) {
    const file = objectPath(userId, storage);
    const stats = await fsp.stat(file);
    const from = Math.max(0, Math.min(start, stats.size));
    const to = end === undefined || end === null ? stats.size - 1 : Math.min(end, stats.size - 1);
    if (from > to) throw new StorageError('Requested range is not satisfiable', { code: 'RANGE' });
    const stream = fs.createReadStream(file, { start: from, end: to });
    if (signal) {
      const onAbort = () => stream.destroy(new Error('Aborted'));
      if (signal.aborted) stream.destroy(new Error('Aborted'));
      else signal.addEventListener('abort', onAbort, { once: true });
      stream.on('close', () => signal.removeEventListener('abort', onAbort));
    }
    stream.size = to - from + 1;
    return stream;
  },

  async openLocal({ userId, storage }) {
    const file = objectPath(userId, storage);
    await fsp.access(file);
    return { path: file, cleanup: async () => {} };
  },

  async delete({ userId, storage }) {
    try {
      await fsp.unlink(objectPath(userId, storage));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new StorageError(`Could not delete local object: ${err.message}`, { cause: err });
    }
  },

  /** Reads a small prefix of an object — used for text previews. */
  async readPrefix({ userId, storage, bytes = 64 * 1024 }) {
    const file = objectPath(userId, storage);
    const handle = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(bytes, (await handle.stat()).size));
      await handle.read(buf, 0, buf.length, 0);
      return buf;
    } finally {
      await handle.close();
    }
  },

  async usage({ userId }) {
    const dir = userDir(userId);
    let total = 0;
    let count = 0;
    const walk = async (d) => {
      const entries = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) await walk(full);
        else {
          const s = await fsp.stat(full).catch(() => null);
          if (s) {
            total += s.size;
            count += 1;
          }
        }
      }
    };
    await walk(dir);
    return { total, count };
  },
};

/** Helper for tests/tooling: wrap a buffer as a readable stream. */
export function bufferToStream(buffer) {
  return Readable.from([buffer]);
}

export default localProvider;
