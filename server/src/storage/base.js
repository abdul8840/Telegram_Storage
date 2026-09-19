/**
 * StorageProvider contract.
 *
 * Every backend (Telegram, local disk) implements this interface, so the rest
 * of the app is completely backend-agnostic.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * name        : 'telegram' | 'local'
 * label       : human readable name for the UI
 *
 * status(ctx) : { ready:boolean, reason?:string, details?:object }
 *               Cheap health check used by the UI to explain why uploads are
 *               unavailable (e.g. "Telegram account not connected").
 *
 * upload(ctx) : ctx = {
 *                 userId, filePath, fileName, size, mimeType, kind,
 *                 media, thumbPath, folderPath, onProgress({sent,total,percent}),
 *                 signal (AbortSignal), meta (arbitrary JSON)
 *               }
 *               → { storage: <opaque reference object>, provider: name }
 *               `storage` is persisted on the file document and handed back to
 *               every other method. It must be JSON-serialisable.
 *
 * createReadStream(ctx) :
 *               ctx = { userId, storage, start?, end?, size, signal }
 *               → Readable stream positioned at `start` and ending at `end`
 *                 (inclusive, HTTP-Range semantics). This is what powers
 *                 seekable video playback and partial downloads.
 *
 * openLocal(ctx) : ctx = { userId, storage, size, signal, onProgress }
 *               → { path, cleanup():Promise<void> }
 *               Materialises the whole object on local disk so ffmpeg can work
 *               on it (thumbnails, probing, transcoding). For the local
 *               provider this is a no-op reference to the existing file.
 *
 * delete(ctx)  : ctx = { userId, storage } → removes the object permanently.
 * ─────────────────────────────────────────────────────────────────────────
 */

export class StorageError extends Error {
  constructor(message, { code = 'STORAGE_ERROR', retryable = false, cause = null } = {}) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.retryable = retryable;
    this.cause = cause;
  }
}

/** Thrown when an operation is cancelled by the user. */
export class AbortError extends Error {
  constructor(message = 'Operation cancelled') {
    super(message);
    this.name = 'AbortError';
    this.code = 'ABORTED';
  }
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new AbortError();
}

/** Default no-op provider so the API can answer status checks before setup. */
export const nullProvider = {
  name: 'none',
  label: 'No storage backend',
  async status() {
    return { ready: false, reason: 'No storage backend configured' };
  },
  async upload() {
    throw new StorageError('No storage backend configured', { code: 'NO_BACKEND' });
  },
  async createReadStream() {
    throw new StorageError('No storage backend configured', { code: 'NO_BACKEND' });
  },
  async openLocal() {
    throw new StorageError('No storage backend configured', { code: 'NO_BACKEND' });
  },
  async delete() {
    throw new StorageError('No storage backend configured', { code: 'NO_BACKEND' });
  },
};
