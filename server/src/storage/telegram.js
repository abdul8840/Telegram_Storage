/**
 * Telegram storage provider.
 *
 * Uses a connected Telegram account as the file-storage backend over MTProto:
 *   • uploads  — streamed from disk in parts (2 GB free / 4 GB Premium per file)
 *   • downloads — arbitrary byte ranges, which is what makes <video> seeking work
 *   • deletes  — removes the backing message
 *
 * Everything the drive needs (document id, access hash, file reference, DC) is
 * captured from the sent message and persisted, so later reads never need to
 * re-fetch the whole chat history. Expired file references are refreshed
 * automatically and transparently.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { CustomFile } from 'teleproto/client/uploads.js';
import config from '../config.js';
import { db } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import { describeTelegramError } from '../lib/errors.js';
import { extOf, isHevc, isWebPlayableVideo, formatBytes } from '../lib/fileTypes.js';
import { createSemaphore, retry } from '../lib/concurrency.js';
import { randomHex } from '../lib/crypto.js';
import { AbortError, StorageError, throwIfAborted } from './base.js';
import { Api, bigInt, getAccount, getClientAndAccount, maskPhone, resolveEntity } from './telegramClient.js';

const log = createLogger('storage:telegram');

const uploadSemaphores = new Map();
const downloadSemaphores = new Map();

function semaphoreFor(map, userId, limit) {
  const key = String(userId);
  if (!map.has(key)) map.set(key, createSemaphore(limit));
  return map.get(key);
}

/** Containers/codecs Telegram can present as a playable video message. */
const NATIVE_VIDEO_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', '3gp', 'avi']);
const STREAMABLE_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm']);
const NATIVE_AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wav', 'amr']);

function buildAttributes({ fileName, kind, media = {} }) {
  const attrs = [new Api.DocumentAttributeFilename({ fileName })];
  if (kind === 'video') {
    attrs.unshift(
      new Api.DocumentAttributeVideo({
        duration: Math.round(media.duration || 0) || undefined,
        w: Math.round(media.width || 0) || undefined,
        h: Math.round(media.height || 0) || undefined,
        supportsStreaming: STREAMABLE_CONTAINERS.has(extOf(fileName)),
        roundMessage: false,
      }),
    );
  } else if (kind === 'audio') {
    attrs.unshift(
      new Api.DocumentAttributeAudio({
        duration: Math.round(media.duration || 0) || undefined,
        title: media.title || fileName,
        performer: media.artist || undefined,
        voice: false,
      }),
    );
  } else if (kind === 'image' && media.width && media.height) {
    attrs.unshift(new Api.DocumentAttributeImageSize({ w: Math.round(media.width), h: Math.round(media.height) }));
  }
  return attrs.filter(Boolean);
}

/** Decides whether to send as a native media message or as a plain document. */
function sendPolicy({ fileName, kind, media }) {
  const ext = extOf(fileName);
  if (kind === 'video' && NATIVE_VIDEO_CONTAINERS.has(ext)) {
    // HEVC/H.265 and odd containers are still sent as video (iOS/Android play
    // HEVC natively); if Telegram rejects it we fall back to a document.
    return {
      forceDocument: false,
      supportsStreaming: STREAMABLE_CONTAINERS.has(ext) && (isWebPlayableVideo(fileName, media) || isHevc(fileName, media)),
      asNative: true,
    };
  }
  if (kind === 'audio' && NATIVE_AUDIO_EXTS.has(ext)) {
    return { forceDocument: false, supportsStreaming: true, asNative: true };
  }
  // Images are deliberately sent as documents: Telegram re-compresses photos and
  // strips EXIF, which would destroy originals (HEIC, RAW, edited exports).
  return { forceDocument: true, supportsStreaming: false, asNative: false };
}

function captionFor({ fileName, folderPath, size }) {
  const where = folderPath && folderPath !== '/' ? folderPath : '';
  const head = '☁️ ZoZoCloud';
  return [head, where, `${fileName} · ${formatBytes(size)}`].filter(Boolean).join(' · ').slice(0, 1000);
}

function buildLocation(storage) {
  if (!storage?.documentId) throw new StorageError('Telegram storage reference is incomplete', { code: 'BAD_REF' });
  const fileReference = storage.fileReference ? Buffer.from(storage.fileReference, 'base64') : Buffer.alloc(0);
  if (storage.mediaType === 'photo') {
    return new Api.InputPhotoFileLocation({
      id: bigInt(storage.documentId),
      accessHash: bigInt(storage.accessHash || '0'),
      fileReference,
      thumbSize: storage.thumbSize || '',
    });
  }
  return new Api.InputDocumentFileLocation({
    id: bigInt(storage.documentId),
    accessHash: bigInt(storage.accessHash || '0'),
    fileReference,
    thumbSize: storage.thumbSize || '',
  });
}

/**
 * Skips an alignment prefix and trims to the exact HTTP range. Telegram only
 * accepts aligned upload.getFile offsets, while browsers may request any byte.
 */
function toReadable(generator, { skipBytes = 0, totalBytes, signal }) {
  let emitted = 0;
  let skipped = 0;
  const iter = (async function* trimmed() {
    for await (const chunk of generator) {
      if (signal?.aborted) throw new AbortError();
      if (!chunk || chunk.length === 0) continue;
      let out = chunk;
      if (skipped < skipBytes) {
        const remainingSkip = skipBytes - skipped;
        const take = Math.min(remainingSkip, out.length);
        skipped += take;
        out = out.subarray(take);
      }
      if (totalBytes !== undefined && emitted + out.length > totalBytes) out = out.subarray(0, Math.max(0, totalBytes - emitted));
      if (out.length === 0) break;
      emitted += out.length;
      yield out;
      if (totalBytes !== undefined && emitted >= totalBytes) break;
    }
  })();
  const stream = Readable.from(iter, { objectMode: false, highWaterMark: 512 * 1024 });
  stream.bytesEmitted = () => emitted;
  return stream;
}

function extractDocument(message) {
  const media = message?.media;
  if (!media) return null;
  const doc = media.document || media.photo;
  if (!doc) return null;
  return {
    mediaType: media.photo ? 'photo' : 'document',
    documentId: doc.id.toString(),
    accessHash: doc.accessHash ? doc.accessHash.toString() : '0',
    fileReference: doc.fileReference ? Buffer.from(doc.fileReference).toString('base64') : '',
    dcId: doc.dcId ?? undefined,
    size: doc.size ? Number(doc.size) : undefined,
    mimeType: doc.mimeType || undefined,
    thumbSize: media.photo && Array.isArray(doc.sizes) && doc.sizes.length ? doc.sizes[doc.sizes.length - 1].type : '',
  };
}

export const telegramProvider = {
  name: 'telegram',
  label: 'Telegram',

  /** Cheap readiness check (does not open a socket). */
  async status({ userId } = {}) {
    const account = await getAccount(userId);
    if (!account) {
      return {
        ready: false,
        reason: 'Connect your Telegram account to store files in the cloud.',
        code: 'TG_NOT_CONNECTED',
      };
    }
    if (account.status !== 'active' || !account.sessionString) {
      return {
        ready: false,
        reason: 'Your Telegram connection is incomplete — finish the login to continue.',
        code: 'TG_NOT_CONNECTED',
      };
    }
    return {
      ready: true,
      details: {
        account: {
          firstName: account.firstName,
          username: account.username,
          phone: maskPhone(account.phone || ''),
          isPremium: !!account.isPremium,
        },
        destination: account.chatLabel || account.chatTarget || 'Saved Messages',
        chatTarget: account.chatTarget || 'me',
        lastError: account.lastError || null,
        perFileLimit: account.isPremium ? '4 GB (Premium)' : '2 GB',
      },
    };
  },

  /** Actively verifies the session + destination chat by opening a connection. */
  async verifyConnection({ userId }) {
    const { client, account } = await getClientAndAccount(userId);
    const target = account.chatTarget || config.telegram.chatTarget || 'me';
    const peer = await resolveEntity(client, target);
    const me = await client.getMe().catch(() => null);
    return {
      ok: true,
      account: {
        firstName: me?.firstName || account.firstName,
        username: me?.username || account.username,
        phone: maskPhone(me?.phone || account.phone || ''),
        isPremium: !!me?.premium,
        id: me?.id?.toString?.() || account.tgUserId,
      },
      destination: account.chatLabel || target,
    };
  },

  async upload(ctx) {
    const { userId, filePath, fileName, size, kind, media = {}, thumbPath, tgThumbPath, folderPath = '/', onProgress, signal, imagesAsPhotos } = ctx;
    throwIfAborted(signal);

    return semaphoreFor(uploadSemaphores, userId, config.telegram.maxConcurrentUploads).run(async () => {
      const { client, account } = await getClientAndAccount(userId);
      const target = account.chatTarget || config.telegram.chatTarget || 'me';
      const peer = await resolveEntity(client, target);

      // Sanity check against Telegram's hard limits before wasting bandwidth.
      const hardLimit = account.isPremium ? 4 * 1024 ** 3 : 2 * 1024 ** 3;
      if (size > hardLimit) {
        throw new StorageError(
          `${fileName} is ${formatBytes(size)} — Telegram allows up to ${formatBytes(hardLimit)} per file${
            account.isPremium ? '' : ' (4 GB with Telegram Premium)'
          }.`,
          { code: 'FILE_TOO_BIG' },
        );
      }

      const customFile = new CustomFile(fileName, size, filePath);

      const progressCallback = (fraction) => {
        const percent = Math.max(0, Math.min(100, Math.round((Number(fraction) || 0) * 100)));
        onProgress?.({ sent: Math.round((percent / 100) * size), total: size, percent, phase: 'telegram' });
      };
      progressCallback.isCanceled = false;
      const onAbort = () => {
        progressCallback.isCanceled = true;
      };
      if (signal) {
        if (signal.aborted) throw new AbortError();
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        const inputFile = await retry(
          () =>
            client.uploadFile({
              file: customFile,
              workers: config.telegram.uploadWorkers,
              onProgress: progressCallback,
            }),
          {
            attempts: 3,
            baseDelayMs: 1500,
            shouldRetry: (err) => {
              const msg = err?.errorMessage || err?.message || '';
              return !progressCallback.isCanceled && /TIMEOUT|NETWORK|CONNECTION|RPC_CALL_FAIL|FLOOD_WAIT_/i.test(msg);
            },
            onRetry: (err, attempt) => log.warn(`upload retry ${attempt} for ${fileName}: ${err.message}`),
          },
        );

        const caption = captionFor({ fileName, folderPath, size });
        const policy = sendPolicy({ fileName, kind, media });
        const usePhoto = kind === 'image' && imagesAsPhotos && !isHevc(fileName, media);

        const sendAttempts = [];
        if (usePhoto) sendAttempts.push({ forceDocument: false, supportsStreaming: false, asImage: true });
        if (policy.asNative) sendAttempts.push(policy);
        sendAttempts.push({ forceDocument: true, supportsStreaming: false, asNative: false });

        let message = null;
        let lastError = null;
        for (const [index, attempt] of sendAttempts.entries()) {
          try {
            message = await client.sendFile(peer, {
              file: inputFile,
              caption,
              forceDocument: attempt.forceDocument,
              supportsStreaming: !!attempt.supportsStreaming,
              fileSize: size,
              // Telegram only accepts a .jpg thumbnail for documents.
              thumb: tgThumbPath && fs.existsSync(tgThumbPath) ? tgThumbPath : undefined,
              attributes: buildAttributes({ fileName, kind, media }),
              silent: true,
              workers: config.telegram.uploadWorkers,
            });
            if (index > 0) log.info(`${fileName}: sent as ${attempt.forceDocument ? 'document' : 'native media'} after fallback`);
            break;
          } catch (err) {
            lastError = err;
            const msg = err?.errorMessage || err?.message || String(err);
            const retryable = /MEDIA_INVALID|VIDEO_CONTENT_TYPE_ERROR|PHOTO_INVALID_DIMENSIONS|IMAGE_PROCESS_FAILED|DOCUMENT_INVALID|FILE_PARTS_INVALID/i.test(msg);
            if (!retryable) throw err;
            log.warn(`${fileName}: Telegram rejected media form (${msg}); trying next form`);
          }
        }
        if (!message) throw lastError || new StorageError('Telegram did not accept the file');

        const doc = extractDocument(message);
        if (!doc) throw new StorageError('Telegram accepted the file but returned no media reference');

        const storage = {
          provider: 'telegram',
          entityRef: target,
          messageId: message.id,
          ...doc,
          size: doc.size || size,
        };

        onProgress?.({ sent: size, total: size, percent: 100, phase: 'telegram' });
        log.info(`uploaded ${fileName} (${formatBytes(size)}) → message ${message.id}`);
        return { storage, provider: 'telegram', size: storage.size, messageId: message.id };
      } catch (err) {
        if (progressCallback.isCanceled || err?.message === 'USER_CANCELED') throw new AbortError('Upload cancelled');
        throw new StorageError(describeTelegramError(err), {
          code: err?.errorMessage || 'TG_UPLOAD_FAILED',
          retryable: /FLOOD_WAIT|TIMEOUT|NETWORK|CONNECTION/i.test(err?.errorMessage || err?.message || ''),
          cause: err,
        });
      } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    });
  },

  async createReadStream({ userId, storage, start = 0, end, size, signal }) {
    const total = Number(size || storage?.size || 0);
    const from = Math.max(0, start);
    const to = end === undefined || end === null ? Math.max(0, total - 1) : Math.min(end, Math.max(0, total - 1));
    if (total > 0 && from > to) throw new StorageError('Requested range is not satisfiable', { code: 'RANGE' });
    const length = to - from + 1;
    // upload.getFile rejects arbitrary offsets and requests that cross its
    // internal 1 MiB boundaries. Align to our 512 KiB request size, then
    // discard the prefix before exposing bytes to the HTTP client.
    const telegramAlignment = 512 * 1024;
    const alignedFrom = Math.floor(from / telegramAlignment) * telegramAlignment;
    const prefixBytes = from - alignedFrom;
    const telegramLength = prefixBytes + length;

    const gate = semaphoreFor(downloadSemaphores, userId, config.telegram.maxConcurrentDownloads);
    await gate.acquire();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      gate.release();
    };
    try {
      const { client } = await getClientAndAccount(userId);
      const open = async (ref) => {
        const location = buildLocation(ref);
        const generator = client.iterDownload(location, {
          offset: bigInt(alignedFrom),
          limit: telegramLength,
          requestSize: Math.min(1024 * 1024, 512 * 1024),
          dcId: ref.dcId ? Number(ref.dcId) : undefined,
          signal,
        });
        const stream = toReadable(generator, { skipBytes: prefixBytes, totalBytes: length, signal });
        stream.size = length;
        stream.once('end', release);
        stream.once('close', release);
        stream.once('error', release);
        return stream;
      };

      try {
        return await open(storage);
      } catch (err) {
        const msg = err?.errorMessage || err?.message || String(err);
        if (/FILE_REFERENCE_EXPIRED/i.test(msg)) {
          log.info(`file reference expired for document ${storage.documentId} — refreshing`);
          const refreshed = await refreshReference(userId, storage);
          return open(refreshed);
        }
        throw new StorageError(describeTelegramError(err), { code: 'TG_DOWNLOAD_FAILED', cause: err });
      }
    } catch (err) {
      release();
      throw err;
    }
  },

  /** Downloads the whole object to a temp file (for ffmpeg probing/transcoding). */
  async openLocal({ userId, storage, size, signal, onProgress, fileId }) {
    const { client } = await getClientAndAccount(userId);
    const dest = path.join(config.paths.tmp, `tg-${fileId || storage.documentId}-${randomHex(4)}${extOf(storage.fileName || '') ? `.${extOf(storage.fileName)}` : ''}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });

    const progressCallback = (downloaded, total) => {
      const sent = Number(downloaded?.toString?.() ?? downloaded);
      const all = Number(total?.toString?.() ?? total ?? size ?? 0);
      onProgress?.({ sent, total: all, percent: all ? Math.round((sent / all) * 100) : 0, phase: 'download' });
    };

    const doDownload = async (ref) => {
      await client.downloadFile(buildLocation(ref), {
        outputFile: dest,
        dcId: ref.dcId ? Number(ref.dcId) : undefined,
        fileSize: bigInt(Number(size || ref.size || 0)),
        progressCallback,
        signal,
      });
    };

    try {
      await retry(() => doDownload(storage), {
        attempts: 3,
        baseDelayMs: 1000,
        shouldRetry: (err) => {
          const msg = err?.errorMessage || err?.message || '';
          return !signal?.aborted && /TIMEOUT|NETWORK|CONNECTION|RPC_CALL_FAIL/i.test(msg);
        },
      });
    } catch (err) {
      const msg = err?.errorMessage || err?.message || String(err);
      if (/FILE_REFERENCE_EXPIRED/i.test(msg)) {
        const refreshed = await refreshReference(userId, storage, fileId);
        await doDownload(refreshed);
      } else {
        await fsp.unlink(dest).catch(() => {});
        if (signal?.aborted) throw new AbortError();
        throw new StorageError(describeTelegramError(err), { code: 'TG_DOWNLOAD_FAILED', cause: err });
      }
    }

    const stats = await fsp.stat(dest).catch(() => null);
    if (!stats) throw new StorageError('Telegram download produced no file');
    return {
      path: dest,
      size: stats.size,
      cleanup: async () => {
        await fsp.unlink(dest).catch(() => {});
      },
    };
  },

  /** Reads only the first `bytes` — enough for text previews and codec sniffing. */
  async readPrefix({ userId, storage, bytes = 256 * 1024, signal }) {
    const stream = await telegramProvider.createReadStream({ userId, storage, start: 0, end: bytes - 1, size: bytes, signal });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  },

  async delete({ userId, storage }) {
    if (!storage?.messageId) return;
    try {
      const { client } = await getClientAndAccount(userId);
      const peer = await resolveEntity(client, storage.entityRef || 'me');
      await client.deleteMessages(peer, [Number(storage.messageId)], { revoke: true });
      log.info(`deleted telegram message ${storage.messageId}`);
    } catch (err) {
      const msg = err?.errorMessage || err?.message || String(err);
      if (/MESSAGE_ID_INVALID|MESSAGE_DELETE_FORBIDDEN/i.test(msg)) {
        log.warn(`message ${storage.messageId} already gone or not deletable`);
        return;
      }
      throw new StorageError(describeTelegramError(err), { code: 'TG_DELETE_FAILED', cause: err });
    }
  },

  /** Lists recent media in the destination chat (powers "Import from Telegram"). */
  async listRemote({ userId, target, limit = 50, offsetId = 0, filter = 'all' }) {
    const { client, account } = await getClientAndAccount(userId);
    const peer = await resolveEntity(client, target || account.chatTarget || 'me');
    const filters = {
      all: undefined,
      video: new Api.InputMessagesFilterVideo(),
      photo: new Api.InputMessagesFilterPhoto(),
      document: new Api.InputMessagesFilterDocument(),
      audio: new Api.InputMessagesFilterMusic(),
    };
    const messages = await client.getMessages(peer, { limit, offsetId: offsetId || undefined, filter: filters[filter] });
    const items = [];
    for (const message of messages) {
      const doc = extractDocument(message);
      if (!doc) continue;
      const nameAttr = (message.media?.document?.attributes || []).find((a) => a.className === 'DocumentAttributeFilename');
      const videoAttr = (message.media?.document?.attributes || []).find((a) => a.className === 'DocumentAttributeVideo');
      items.push({
        messageId: message.id,
        name: nameAttr?.fileName || `telegram-${message.id}`,
        size: doc.size,
        mimeType: doc.mimeType,
        date: message.date ? new Date(message.date * 1000).toISOString() : null,
        duration: videoAttr?.duration || null,
        storage: { provider: 'telegram', entityRef: target || account.chatTarget || 'me', messageId: message.id, ...doc },
      });
    }
    return { items, hasMore: messages.length === limit };
  },
};

/**
 * Re-reads a message from Telegram to obtain a fresh file reference, updates the
 * stored document and returns the new reference. Telegram rotates references,
 * so this is expected to happen occasionally on long-lived files.
 */
export async function refreshReference(userId, storage, fileId) {
  const { client, account } = await getClientAndAccount(userId);
  const peer = await resolveEntity(client, storage.entityRef || account.chatTarget || 'me');
  const messages = await client.getMessages(peer, { ids: [Number(storage.messageId)] });
  const message = messages?.[0];
  if (!message) throw new StorageError('This file no longer exists in Telegram (message deleted?)', { code: 'TG_MISSING' });
  const doc = extractDocument(message);
  if (!doc) throw new StorageError('Telegram message has no media attached', { code: 'TG_MISSING' });

  const updated = { ...storage, ...doc };
  const query = fileId ? { _id: fileId, userId } : { userId, 'storage.documentId': storage.documentId };
  await db.files
    .updateOne(query, {
      $set: {
        'storage.fileReference': updated.fileReference,
        'storage.accessHash': updated.accessHash,
        'storage.dcId': updated.dcId,
        'storage.messageId': updated.messageId,
        updatedAt: new Date().toISOString(),
      },
    })
    .catch((err) => log.warn(`could not persist refreshed file reference: ${err.message}`));
  return updated;
}

export default telegramProvider;
