/**
 * Upload manager: resumable chunked uploads + the post-upload processing
 * pipeline (probe → thumbnails → provider upload → ready).
 *
 * Why chunked:
 *   • 4 GB iPhone videos survive flaky connections — each 8 MB part is
 *     acknowledged separately and only missing parts are re-sent.
 *   • Nothing is ever buffered whole in memory; parts stream straight to disk.
 *   • A reload of the browser resumes instead of restarting.
 *
 * Flow:  POST /uploads → PUT /uploads/:id/chunks/:n … → POST /uploads/:id/complete
 *        → the file appears in the library as "processing" and turns "ready"
 *          once it is safely in Telegram, with progress pushed over SSE.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import config from '../config.js';
import { db } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import { ApiError } from '../lib/errors.js';
import { userBus } from '../lib/events.js';
import { randomId } from '../lib/crypto.js';
import {
  extOf,
  kindOf,
  mimeOf,
  sanitizeFileName,
  formatBytes,
  formatDuration,
  isHeicImage,
  isPdf,
  isPlayableAudio,
  isTextPreviewable,
  splitName,
  videoCompatibility,
  KIND,
} from '../lib/fileTypes.js';
import { createSemaphore, clampPercent } from '../lib/concurrency.js';
import { getProviderForUser } from '../storage/index.js';
import {
  generateThumbnails,
  probe,
  ensureWebPreview,
  deleteThumbnails,
  thumbPathsFor,
  remuxToMp4,
  transcodeToH264,
  runVideoProcessing,
} from './media.js';
import { buildFolderTree } from './folders.js';

const log = createLogger('uploads');

const processingSemaphore = createSemaphore(Math.max(1, config.telegram.maxConcurrentUploads + 1));
const activeCancellations = new Map(); // uploadId|fileId → AbortController
const PROCESSING_SCOPE = config.telegram.sessionScope;

const now = () => new Date().toISOString();

function processingScopeQuery(field = 'processingScope') {
  return { [field]: PROCESSING_SCOPE };
}

function sessionDir(userId, uploadId) {
  return path.join(config.paths.uploads, String(userId).replace(/[^a-zA-Z0-9_-]/g, '_'), String(uploadId).replace(/[^a-zA-Z0-9_-]/g, ''));
}

function emit(userId, event, payload) {
  userBus(String(userId)).emit(event, payload);
}

export function abortControllerFor(key) {
  if (!activeCancellations.has(key)) activeCancellations.set(key, new AbortController());
  return activeCancellations.get(key);
}

function clearAbort(key) {
  activeCancellations.delete(key);
}

// ── sessions ───────────────────────────────────────────────────────────────

/**
 * Creates (or resumes) an upload session. If the same user already has an
 * incomplete session for an identical name+size, it is returned so the client
 * can skip the parts it already sent.
 */
export async function createSession({ userId, name, size, mime, folderId, chunkSize, checksum }) {
  const cleanName = sanitizeFileName(name);
  const bytes = Number(size);
  if (!cleanName) throw ApiError.badRequest('A file name is required');
  if (!Number.isFinite(bytes) || bytes <= 0) throw ApiError.badRequest('A positive file size is required');
  if (bytes > config.limits.maxUploadSize) {
    throw ApiError.payload(`This file is ${formatBytes(bytes)}; the maximum supported size is ${formatBytes(config.limits.maxUploadSize)}`);
  }

  // Fail before creating a session directory or accepting chunks. Uploads are
  // never redirected to permanent local storage.
  await getProviderForUser(userId);

  if (folderId) {
    const folder = await db.folders.findOne({ _id: folderId, userId });
    if (!folder) throw ApiError.badRequest('Target folder not found');
  }

  // Resume support: match an unfinished session for the same content.
  const existing = await db.uploads.findOne({
    userId,
    name: cleanName,
    size: bytes,
    status: { $in: ['pending', 'receiving'] },
    ...processingScopeQuery(),
    ...(checksum ? { checksum } : {}),
  });
  if (existing) {
    const received = await listParts(existing._id, existing.userId);
    await db.uploads.updateOne({ _id: existing._id }, { $set: { updatedAt: now(), status: 'receiving' } });
    log.info(`resuming upload session ${existing._id} for ${cleanName} (${received.length}/${existing.totalChunks} parts)`);
    return {
      uploadId: existing._id,
      resumed: true,
      chunkSize: existing.chunkSize,
      totalChunks: existing.totalChunks,
      receivedChunks: received,
      status: existing.status,
    };
  }

  const partSize = Math.max(1024 * 1024, Math.min(chunkSize || config.limits.defaultChunkSize, 64 * 1024 * 1024));
  const totalChunks = Math.max(1, Math.ceil(bytes / partSize));
  const uploadId = randomId(10);
  const dir = sessionDir(userId, uploadId);
  await fsp.mkdir(path.join(dir, 'parts'), { recursive: true });

  const doc = {
    _id: uploadId,
    userId,
    processingScope: PROCESSING_SCOPE,
    name: cleanName,
    size: bytes,
    mime: mimeOf(cleanName, mime),
    kind: kindOf(cleanName, mime),
    folderId: folderId || null,
    chunkSize: partSize,
    totalChunks,
    receivedBytes: 0,
    checksum: checksum || null,
    status: 'receiving',
    dir,
    error: null,
    fileId: null,
    createdAt: now(),
    updatedAt: now(),
  };
  await db.uploads.insertOne(doc);
  emit(userId, 'upload:created', { uploadId, name: cleanName, size: bytes, totalChunks });
  return { uploadId, resumed: false, chunkSize: partSize, totalChunks, receivedChunks: [], status: doc.status };
}

async function listParts(uploadId, userId) {
  const dir = path.join(sessionDir(userId, uploadId), 'parts');
  const entries = await fsp.readdir(dir).catch(() => []);
  return entries
    .filter((f) => /^\d+$/.test(f))
    .map(Number)
    .sort((a, b) => a - b);
}

export async function getSession(userId, uploadId) {
  const session = await db.uploads.findOne({ _id: uploadId, userId, ...processingScopeQuery() });
  if (!session) throw ApiError.notFound('Upload session not found');
  return session;
}

export async function sessionState(userId, uploadId) {
  const session = await getSession(userId, uploadId);
  const received = await listParts(uploadId, userId);
  return {
    uploadId: session._id,
    name: session.name,
    size: session.size,
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    receivedChunks: received,
    status: session.status,
    fileId: session.fileId,
    error: session.error,
  };
}

/**
 * Streams one part to disk. Returns the number of bytes written.
 */
export async function writeChunk({ userId, uploadId, index, stream, declaredSize }) {
  const session = await getSession(userId, uploadId);
  if (['ready', 'cancelled'].includes(session.status)) throw ApiError.conflict(`Upload session is ${session.status}`);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= session.totalChunks) throw ApiError.badRequest(`Chunk index ${index} is out of range`);

  const isLast = i === session.totalChunks - 1;
  const expected = isLast ? session.size - i * session.chunkSize : session.chunkSize;
  if (declaredSize && Number(declaredSize) !== expected) {
    throw ApiError.badRequest(`Chunk ${i} should be ${expected} bytes (got ${declaredSize})`);
  }

  const dir = path.join(sessionDir(userId, uploadId), 'parts');
  await fsp.mkdir(dir, { recursive: true });
  const partPath = path.join(dir, String(i));
  const tmpPath = `${partPath}.part`;

  let written = 0;
  const out = fs.createWriteStream(tmpPath);
  try {
    await pipeline(
      stream,
      async function* count(source) {
        for await (const chunk of source) {
          written += chunk.length;
          if (written > expected) {
            throw ApiError.badRequest(`Chunk ${i} is larger than expected (${expected} bytes)`);
          }
          yield chunk;
        }
      },
      out,
    );
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }

  if (written !== expected) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw ApiError.badRequest(`Chunk ${i} is incomplete: expected ${expected} bytes, received ${written}`);
  }
  await fsp.rename(tmpPath, partPath);

  await db.uploads.updateOne({ _id: uploadId }, { $set: { status: 'receiving', updatedAt: now() } });
  return { index: i, bytes: written };
}

/** Concatenates parts into a single payload file (streamed, constant memory). */
async function assemble(session) {
  const dir = sessionDir(session.userId, session._id);
  const partsDir = path.join(dir, 'parts');
  const payload = path.join(dir, 'payload');
  const received = await listParts(session._id, session.userId);
  if (received.length !== session.totalChunks) {
    const missing = [];
    for (let i = 0; i < session.totalChunks; i += 1) if (!received.includes(i)) missing.push(i);
    throw ApiError.badRequest(`Upload is incomplete — ${missing.length} part(s) missing (first: ${missing[0]})`);
  }

  await fsp.rm(payload, { force: true });

  // Each part is piped into a PassThrough (without ending it), and only the
  // final `merged.end()` closes the destination — so this works for 1 part or
  // 500 parts alike and never buffers the whole file in memory.
  const out = fs.createWriteStream(payload);
  const merged = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });
  const finished = new Promise((resolve, reject) => {
    out.once('close', resolve);
    out.once('error', reject);
    merged.once('error', reject);
  });
  merged.pipe(out);

  try {
    for (let i = 0; i < session.totalChunks; i += 1) {
      await pipeline(fs.createReadStream(path.join(partsDir, String(i))), merged, { end: false });
    }
    merged.end();
    await finished;
  } catch (err) {
    merged.destroy();
    out.destroy();
    await fsp.unlink(payload).catch(() => {});
    throw err;
  }

  const stats = await fsp.stat(payload);
  if (stats.size !== session.size) {
    await fsp.unlink(payload).catch(() => {});
    throw ApiError.badRequest(`Assembled file is ${stats.size} bytes but ${session.size} were declared`);
  }
  // Parts are no longer needed once the payload is complete.
  await fsp.rm(partsDir, { recursive: true, force: true }).catch(() => {});
  return { payload, size: stats.size };
}

// ── completion → library entry → processing pipeline ───────────────────────

export async function completeSession({ userId, uploadId }) {
  const session = await getSession(userId, uploadId);
  if (session.status === 'ready' && session.fileId) {
    const file = await db.files.findOne({ _id: session.fileId, userId });
    if (file) return { fileId: file._id, file };
  }

  // Re-check before assembling chunks. If Telegram was disconnected while a
  // resumable upload was in progress, preserve the chunks for a later retry.
  const { provider, reason } = await getProviderForUser(userId);

  await db.uploads.updateOne({ _id: uploadId }, { $set: { status: 'assembling', updatedAt: now() } });
  emit(userId, 'upload:progress', { uploadId, phase: 'assembling', percent: 100 });

  const { payload } = await assemble(session);

  const fileId = randomId(12);
  const fileDoc = {
    _id: fileId,
    userId,
    processingScope: PROCESSING_SCOPE,
    name: session.name,
    originalName: session.name,
    ext: extOf(session.name),
    mime: session.mime,
    kind: session.kind,
    size: session.size,
    folderId: session.folderId || null,
    provider: provider.name,
    storage: null,
    localPayloadPath: payload,
    media: null,
    thumb: null,
    preview: null,
    starred: false,
    trashed: false,
    trashedAt: null,
    status: 'processing',
    progress: 0,
    error: null,
    derivedFrom: null,
    derivatives: [],
    tags: [],
    checksum: session.checksum || null,
    downloadCount: 0,
    viewCount: 0,
    createdAt: now(),
    updatedAt: now(),
    uploadedAt: null,
    providerNote: reason || null,
  };
  await db.files.insertOne(fileDoc);
  await db.uploads.updateOne({ _id: uploadId }, { $set: { status: 'processing', fileId, updatedAt: now() } });
  emit(userId, 'file:created', { file: publicFile(fileDoc) });

  // Fire and forget — the client follows progress over SSE.
  void processFile(fileId, { uploadId }).catch((err) => log.error(`processing failed for ${fileId}: ${err.message}`));

  return { fileId, uploadId, file: publicFile(fileDoc) };
}

/**
 * Ingests a file that already exists on local disk (single-request uploads,
 * transcode results, imports).
 */
export async function ingestLocalFile({
  userId,
  filePath,
  name,
  size,
  mime,
  folderId,
  derivedFrom = null,
  keepSource = false,
  awaitReady = false,
}) {
  const cleanName = sanitizeFileName(name);
  const stats = size ? { size } : await fsp.stat(filePath);
  if (stats.size > config.limits.maxUploadSize) throw ApiError.payload('File exceeds the maximum upload size');

  // Check Telegram before moving/copying the source into upload staging.
  const { provider, reason } = await getProviderForUser(userId);

  const uploadId = randomId(10);
  const dir = sessionDir(userId, uploadId);
  await fsp.mkdir(dir, { recursive: true });
  const payload = path.join(dir, 'payload');
  if (keepSource) {
    await fsp.copyFile(filePath, payload);
  } else {
    await fsp.rename(filePath, payload).catch(async () => {
      await fsp.copyFile(filePath, payload);
      await fsp.unlink(filePath).catch(() => {});
    });
  }

  const fileId = randomId(12);
  const fileDoc = {
    _id: fileId,
    userId,
    processingScope: PROCESSING_SCOPE,
    name: cleanName,
    originalName: cleanName,
    ext: extOf(cleanName),
    mime: mimeOf(cleanName, mime),
    kind: kindOf(cleanName, mime),
    size: stats.size,
    folderId: folderId || null,
    provider: provider.name,
    storage: null,
    localPayloadPath: payload,
    media: null,
    thumb: null,
    preview: null,
    starred: false,
    trashed: false,
    trashedAt: null,
    status: 'processing',
    progress: 0,
    error: null,
    derivedFrom,
    derivatives: [],
    tags: [],
    checksum: null,
    downloadCount: 0,
    viewCount: 0,
    createdAt: now(),
    updatedAt: now(),
    uploadedAt: null,
    providerNote: reason || null,
  };
  await db.files.insertOne(fileDoc);
  emit(userId, 'file:created', { file: publicFile(fileDoc) });
  const processing = processFile(fileId);
  if (awaitReady) {
    const ready = await processing;
    if (!ready?.storage) throw new Error(`Could not save ${cleanName} to Telegram`);
    return ready;
  }
  void processing.catch((err) => log.error(`processing failed for ${fileId}: ${err.message}`));
  return fileDoc;
}

/**
 * The pipeline: probe → optional video preparation → thumbnails → provider upload → ready.
 * Runs at most `processingSemaphore.limit` files at a time.
 */
export async function processFile(fileId, { uploadId } = {}) {
  return processingSemaphore.run(async () => {
    let file = await db.files.findOne({ _id: fileId });
    if (!file) return null;
    if (file.status !== 'ready' && file.processingScope && file.processingScope !== PROCESSING_SCOPE) {
      log.warn(`ignored processing request for ${fileId}; owned by deployment ${file.processingScope}`);
      return null;
    }
    const userId = file.userId;
    const controller = abortControllerFor(fileId);

    const fail = async (err) => {
      const message = err?.message || String(err);
      log.warn(`file ${fileId} (${file.name}) failed: ${message}`);
      await db.files.updateOne({ _id: fileId }, { $set: { status: 'failed', error: message, updatedAt: now() } });
      if (uploadId) await db.uploads.updateOne({ _id: uploadId }, { $set: { status: 'failed', error: message, updatedAt: now() } });
      emit(userId, 'file:error', { fileId, name: file.name, error: message });
      clearAbort(fileId);
      return null;
    };

    try {
      if (file.status === 'ready' && file.storage) return file;

      let payloadPath = file.localPayloadPath;
      if (!payloadPath || !fs.existsSync(payloadPath)) {
        throw new Error('The temporary upload data is gone; please upload the file again.');
      }

      await db.files.updateOne({ _id: fileId }, { $set: { status: 'processing', error: null, progress: 2, updatedAt: now() } });
      emit(userId, 'file:progress', { fileId, uploadId, phase: 'analyzing', percent: 4, name: file.name });

      // 1) Learn what we are storing (codec, dimensions, duration, HEVC flag…).
      let media = null;
      try {
        media = await probe(payloadPath, { name: file.name, mime: file.mime });
      } catch (err) {
        log.debug(`probe failed for ${file.name}: ${err.message}`);
      }
      if (controller.signal.aborted) throw new Error('Cancelled');
      await db.files.updateOne({ _id: fileId }, { $set: { media, progress: 10, updatedAt: now() } });
      emit(userId, 'file:progress', { fileId, uploadId, phase: 'analyzing', percent: 10, name: file.name });

      // 2) Store one browser-compatible video, not an original plus a second
      // derivative. The source exists only in temporary upload staging. MKV
      // with H.264 is remuxed quickly; HEVC/10-bit/unsupported codecs are
      // encoded once to H.264/AAC before anything is sent to Telegram.
      let preparedVideo = false;
      if (file.kind === KIND.VIDEO && config.media.prepareVideosBeforeUpload && config.media.enableTranscode) {
        const compatibility = videoCompatibility(file.name, media || {});
        if (compatibility.mode !== 'native') {
          const strategy = compatibility.strategy === 'remux' ? 'remux' : 'transcode';
          const phase = strategy === 'remux' ? 'remuxing' : 'transcoding';
          const { base } = splitName(file.name);
          const preparedName = sanitizeFileName(`${base}.mp4`);
          const preparedPath = path.join(path.dirname(payloadPath), 'browser-ready.mp4');
          let lastPreparePercent = 10;

          emit(userId, 'file:progress', {
            fileId,
            uploadId,
            phase: 'conversion-queued',
            percent: 10,
            name: file.name,
            strategy,
          });

          const processor = strategy === 'remux' ? remuxToMp4 : transcodeToH264;
          const result = await runVideoProcessing(async () => {
            if (controller.signal.aborted) throw new Error('Cancelled');
            emit(userId, 'file:progress', { fileId, uploadId, phase, percent: 10, name: file.name, strategy });
            return processor({
              inputPath: payloadPath,
              outputPath: preparedPath,
              media: media || {},
              signal: controller.signal,
              ...(strategy === 'transcode' ? { maxDimension: config.media.transcodeMaxDimension } : {}),
              onProgress: ({ percent = 0, speed = null }) => {
                const overall = clampPercent(10 + (clampPercent(percent) / 100) * 50);
                if (overall === lastPreparePercent) return;
                lastPreparePercent = overall;
                emit(userId, 'file:progress', {
                  fileId,
                  uploadId,
                  phase,
                  percent: overall,
                  speed,
                  name: preparedName,
                  strategy,
                });
                db.files.updateOne({ _id: fileId }, { $set: { progress: overall } }).catch(() => {});
              },
            });
          });
          if (controller.signal.aborted) throw new Error('Cancelled');
          if (result.size > config.limits.maxUploadSize) {
            await fsp.unlink(preparedPath).catch(() => {});
            throw new Error(
              `The browser-compatible video is ${formatBytes(result.size)}, above the ${formatBytes(config.limits.maxUploadSize)} upload limit.`,
            );
          }

          const preparedMedia = (await probe(preparedPath, { name: preparedName, mime: 'video/mp4' })) || {
            ...(media || {}),
            vcodec: 'h264',
            acodec: 'aac',
            pixFmt: 'yuv420p',
            hevc: false,
          };
          const preparedPatch = {
            name: preparedName,
            ext: 'mp4',
            mime: 'video/mp4',
            kind: KIND.VIDEO,
            size: result.size,
            media: preparedMedia,
            localPayloadPath: preparedPath,
            checksum: null,
            preparedFrom: {
              name: file.name,
              size: file.size,
              videoCodec: media?.vcodec || null,
              pixelFormat: media?.pixFmt || null,
              strategy,
            },
            progress: 60,
            updatedAt: now(),
          };
          await db.files.updateOne({ _id: fileId }, { $set: preparedPatch });
          await fsp.unlink(payloadPath).catch(() => {});
          payloadPath = preparedPath;
          media = preparedMedia;
          file = { ...file, ...preparedPatch };
          preparedVideo = true;
          log.info(
            `${strategy === 'remux' ? 'prepared' : 'converted'} ${file.originalName || file.name} before Telegram upload (${formatBytes(
              file.preparedFrom.size,
            )} → ${formatBytes(file.size)})`,
          );
        }
      }

      // 3) Derived images: grid thumbnail, Telegram thumbnail, blur-up, preview.
      let thumb = null;
      let tgThumbPath = null;
      let preview = null;
      try {
        const thumbs = await generateThumbnails({
          localPath: payloadPath,
          fileId,
          kind: file.kind,
          media: media || {},
          name: file.name,
          mime: file.mime,
        });
        tgThumbPath = thumbs.tgThumbPath;
        thumb = thumbs.thumbPath
          ? { available: true, path: thumbs.thumbPath, width: thumbs.width, height: thumbs.height, lqip: thumbs.lqip || null, generatedAt: thumbs.generatedAt }
          : null;
      } catch (err) {
        log.debug(`thumbnail step failed for ${file.name}: ${err.message}`);
      }

      // Videos already have a poster thumbnail. Avoid decoding a second frame
      // into another local JPEG; web preview renditions are only needed for
      // browser-incompatible image formats.
      if (file.kind === KIND.IMAGE) {
        try {
          const webPreview = await ensureWebPreview({
            localPath: payloadPath,
            fileId,
            kind: file.kind,
            name: file.name,
            mime: file.mime,
            media: media || {},
          });
          preview = webPreview ? { path: webPreview.path, generatedAt: now() } : null;
        } catch (err) {
          log.debug(`web preview step failed for ${file.name}: ${err.message}`);
        }
      }

      if (controller.signal.aborted) throw new Error('Cancelled');
      const uploadStartPercent = preparedVideo ? 65 : 20;
      await db.files.updateOne({ _id: fileId }, { $set: { thumb, preview, progress: uploadStartPercent, updatedAt: now() } });
      emit(userId, 'file:progress', { fileId, uploadId, phase: 'uploading', percent: uploadStartPercent, name: file.name });

      // 4) Hand the single final payload to the storage backend.
      const { provider, reason } = await getProviderForUser(userId);
      const folderPath = await folderPathFor(userId, file.folderId);
      const startedAt = Date.now();
      let lastPercent = uploadStartPercent;
      const result = await provider.upload({
        userId,
        fileId,
        filePath: payloadPath,
        fileName: file.name,
        size: file.size,
        mimeType: file.mime,
        kind: file.kind,
        media: media || {},
        thumbPath: thumb?.path || null,
        tgThumbPath,
        folderPath,
        signal: controller.signal,
        onProgress: ({ percent = 0, sent = 0, total = file.size }) => {
          // Map provider progress onto the remaining overall progress band.
          const overall = clampPercent(uploadStartPercent + (clampPercent(percent) / 100) * (98 - uploadStartPercent));
          if (overall === lastPercent) return;
          lastPercent = overall;
          const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
          emit(userId, 'file:progress', {
            fileId,
            uploadId,
            phase: 'uploading',
            percent: overall,
            providerPercent: clampPercent(percent),
            sent,
            total,
            speed: sent ? Math.round(sent / elapsed) : null,
            name: file.name,
          });
          db.files.updateOne({ _id: fileId }, { $set: { progress: overall } }).catch(() => {});
        },
      });

      if (controller.signal.aborted) throw new Error('Cancelled');

      // 5) Publish the finished file.
      const updates = {
        status: 'ready',
        progress: 100,
        provider: provider.name,
        storage: result.storage,
        media,
        thumb,
        preview,
        error: null,
        providerNote: reason || null,
        uploadedAt: now(),
        updatedAt: now(),
      };
      await db.files.updateOne({ _id: fileId }, { $set: updates });
      if (uploadId) await db.uploads.updateOne({ _id: uploadId }, { $set: { status: 'ready', updatedAt: now() } });

      // Telegram confirmed the upload, so drop the temporary staged payload.
      await fsp.rm(path.dirname(payloadPath), { recursive: true, force: true }).catch(() => {});
      await db.files.updateOne({ _id: fileId }, { $unset: { localPayloadPath: true } });

      const updated = { ...file, ...updates };
      delete updated.localPayloadPath;
      emit(userId, 'file:ready', { file: publicFile(updated) });
      log.info(`${file.name} (${formatBytes(file.size)}) is ready in ${provider.name} storage`);
      clearAbort(fileId);
      return updated;
    } catch (err) {
      const cancelled = controller.signal.aborted || /cancel/i.test(err?.message || '');
      if (cancelled) {
        await db.files.updateOne({ _id: fileId }, { $set: { status: 'cancelled', error: 'Cancelled', updatedAt: now() } });
        if (uploadId) await db.uploads.updateOne({ _id: uploadId }, { $set: { status: 'cancelled', updatedAt: now() } });
        emit(userId, 'file:cancelled', { fileId, name: file.name });
        clearAbort(fileId);
        return null;
      }
      return fail(err);
    }
  });
}

export async function retryFile({ userId, fileId }) {
  const file = await db.files.findOne({ _id: fileId, userId });
  if (!file) throw ApiError.notFound('File not found');
  if (file.status === 'ready') return publicFile(file);
  if (file.processingScope && file.processingScope !== PROCESSING_SCOPE) {
    throw ApiError.conflict('This upload is being processed by another deployment. Retry it from the site where it was uploaded.');
  }
  if (!file.localPayloadPath || !fs.existsSync(file.localPayloadPath)) {
    throw ApiError.badRequest('The temporary data for this upload is gone. Please upload the file again.');
  }
  await db.files.updateOne({ _id: fileId }, { $set: { status: 'processing', error: null, updatedAt: now() } });
  void processFile(fileId).catch((err) => log.error(`retry failed for ${fileId}: ${err.message}`));
  return publicFile({ ...file, status: 'processing', error: null });
}

export async function cancelUpload({ userId, fileId, uploadId }) {
  if (fileId) {
    const file = await db.files.findOne({ _id: fileId, userId });
    if (!file) throw ApiError.notFound('File not found');
    if (file.status !== 'ready' && file.processingScope && file.processingScope !== PROCESSING_SCOPE) {
      throw ApiError.conflict('This upload belongs to another deployment and cannot be cancelled from here.');
    }
    abortControllerFor(fileId).abort();
    clearAbort(fileId);
    await db.files.updateOne({ _id: fileId }, { $set: { status: 'cancelled', error: 'Cancelled', updatedAt: now() } });
    if (file.localPayloadPath) await fsp.rm(path.dirname(file.localPayloadPath), { recursive: true, force: true }).catch(() => {});
    emit(userId, 'file:cancelled', { fileId, name: file.name });
    return { ok: true };
  }
  if (uploadId) {
    const session = await getSession(userId, uploadId);
    await fsp.rm(sessionDir(userId, uploadId), { recursive: true, force: true }).catch(() => {});
    await db.uploads.updateOne({ _id: uploadId }, { $set: { status: 'cancelled', updatedAt: now() } });
    if (session.fileId) abortControllerFor(session.fileId).abort();
    emit(userId, 'upload:cancelled', { uploadId });
    return { ok: true };
  }
  throw ApiError.badRequest('fileId or uploadId is required');
}

export async function deleteSession({ userId, uploadId }) {
  await cancelUpload({ userId, uploadId });
  await db.uploads.deleteOne({ _id: uploadId, userId });
  return { ok: true };
}

// ── helpers ────────────────────────────────────────────────────────────────

async function folderPathFor(userId, folderId) {
  if (!folderId) return '/';
  const folders = await db.folders.find({ userId });
  const byId = new Map(folders.map((f) => [f._id, f]));
  const parts = [];
  let current = byId.get(folderId);
  let guard = 0;
  while (current && guard < 50) {
    parts.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : null;
    guard += 1;
  }
  return `/${parts.join('/')}`;
}

/** Shape returned to the browser (never exposes raw storage internals). */
export function publicFile(file) {
  if (!file) return null;
  const { storage, staleStorage, localPayloadPath, ...rest } = file;
  const thumbUrl = file.thumb?.available ? `/api/files/${file._id}/thumbnail` : null;
  const media = file.media || {};
  const compatibility = file.kind === KIND.VIDEO ? videoCompatibility(file.name || '', media) : null;
  let previewKind = 'download';
  if (file.status !== 'ready') previewKind = 'pending';
  else if (file.kind === KIND.VIDEO) {
    previewKind = compatibility.mode === 'native'
      ? 'video'
      : compatibility.mode === 'conditional'
        ? 'video-conditional'
        : compatibility.mode === 'attempt'
          ? 'video-native-attempt'
          : 'video-transcode';
  } else if (file.kind === KIND.AUDIO) previewKind = isPlayableAudio(file.name || '', media) ? 'audio' : 'download';
  else if (file.kind === KIND.IMAGE) {
    if (isHeicImage(file.name || '', file.mime || '')) previewKind = file.preview?.path ? 'image-preview' : 'heic';
    else if (['tiff', 'tif', 'dng', 'cr2', 'nef', 'arw', 'raf', 'rw2', 'bmp'].includes(extOf(file.name || ''))) {
      previewKind = file.preview?.path ? 'image-preview' : 'download';
    } else previewKind = 'image';
  } else if (isPdf(file.name || '', file.mime || '')) previewKind = 'pdf';
  else if (isTextPreviewable(file.name || '', file.mime || '')) previewKind = 'text';
  else if (file.kind === KIND.DOC) previewKind = 'office';
  return {
    ...rest,
    id: file._id,
    // The client only needs to know *whether* the bytes are in Telegram, and for
    // videos whether the browser can play them natively.
    inTelegram: storage?.provider === 'telegram' || file.provider === 'telegram',
    telegramMessageId: storage?.messageId || null,
    thumbUrl,
    streamUrl: `/api/files/${file._id}/stream`,
    downloadUrl: `/api/files/${file._id}/download`,
    lqip: file.thumb?.lqip || null,
    hasThumb: !!file.thumb?.available,
    previewKind,
    playable: ['video', 'video-conditional', 'video-native-attempt', 'audio', 'image', 'image-preview', 'pdf', 'text'].includes(previewKind),
    needsTranscode: previewKind === 'video-transcode',
    hevc: !!compatibility?.hevc,
    videoCompatibility: compatibility,
    conversionStrategy: compatibility?.strategy || null,
    durationText: media.duration ? formatDuration(media.duration) : null,
    hasPreviewRendition: !!file.preview?.path,
    hasDerivative: Array.isArray(file.derivatives) && file.derivatives.length > 0,
    derivedFrom: file.derivedFrom || null,
  };
}

export { buildFolderTree, thumbPathsFor, deleteThumbnails };

/** Removes stale/abandoned sessions and their partial data. */
export async function cleanupStaleSessions({ olderThanHours = 24 } = {}) {
  const cutoff = new Date(Date.now() - olderThanHours * 3600 * 1000).toISOString();
  const stale = await db.uploads.find({
    status: { $in: ['pending', 'receiving', 'assembling'] },
    updatedAt: { $lt: cutoff },
    ...processingScopeQuery(),
  });
  for (const session of stale) {
    await fsp.rm(sessionDir(session.userId, session._id), { recursive: true, force: true }).catch(() => {});
    await db.uploads.updateOne({ _id: session._id }, { $set: { status: 'expired', updatedAt: now() } });
  }
  if (stale.length) log.info(`expired ${stale.length} abandoned upload session(s)`);
  return stale.length;
}

/**
 * After a restart, files stuck in "processing" still have their payload on
 * disk — resume them automatically. Anything without payload is marked failed.
 */
export async function recoverOnBoot() {
  const scoped = await db.files.find({
    status: { $in: ['processing', 'assembling', 'uploading'] },
    ...processingScopeQuery(),
  });
  // Upgrade path for files created before processing scopes existed: only the
  // deployment that still has the temporary payload may atomically claim it.
  const legacy = await db.files.find({
    status: { $in: ['processing', 'assembling', 'uploading'] },
    processingScope: { $exists: false },
  });
  for (const file of legacy) {
    if (!file.localPayloadPath || !fs.existsSync(file.localPayloadPath)) continue;
    const claimed = await db.files.updateOne(
      { _id: file._id, processingScope: { $exists: false } },
      { $set: { processingScope: PROCESSING_SCOPE, updatedAt: now() } },
    );
    if (claimed.matchedCount) scoped.push({ ...file, processingScope: PROCESSING_SCOPE });
  }
  const stuck = scoped;
  let resumed = 0;
  for (const file of stuck) {
    if (file.localPayloadPath && fs.existsSync(file.localPayloadPath)) {
      resumed += 1;
      void processFile(file._id).catch(() => {});
    } else {
      await db.files.updateOne(
        { _id: file._id },
        { $set: { status: 'failed', error: 'Interrupted by a server restart — please upload again.', updatedAt: now() } },
      );
    }
  }
  if (stuck.length) log.info(`recovered ${resumed}/${stuck.length} interrupted upload(s) after restart`);
  return { found: stuck.length, resumed };
}

export default {
  createSession,
  writeChunk,
  completeSession,
  sessionState,
  ingestLocalFile,
  processFile,
  retryFile,
  cancelUpload,
  deleteSession,
  publicFile,
  cleanupStaleSessions,
  recoverOnBoot,
};
