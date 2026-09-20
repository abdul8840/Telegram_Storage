/**
 * Background jobs: the long-running, cancellable work that must not block a
 * request — chiefly HEVC/ProRes → H.264 transcoding, but structured so new job
 * types (bulk download, re-thumbnailing, imports) slot in easily.
 *
 * Jobs persist in the database and stream progress to the browser over SSE, so
 * a page reload does not lose track of a 20-minute transcode.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import config from '../config.js';
import { db } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import { ApiError } from '../lib/errors.js';
import { userBus } from '../lib/events.js';
import { randomId, randomHex } from '../lib/crypto.js';
import { splitName, sanitizeFileName, formatBytes, videoCompatibility } from '../lib/fileTypes.js';
import { getProviderForFile } from '../storage/index.js';
import { getCapabilities, remuxToMp4, transcodeToH264, probe, ensureWebPreview, generateThumbnails, runVideoProcessing } from './media.js';
import { ingestLocalFile, publicFile } from './uploadManager.js';

const log = createLogger('jobs');
const now = () => new Date().toISOString();
const controllers = new Map();
const transcodeQueue = [];
let activeTranscodes = 0;
const WORKER_SCOPE = config.telegram.sessionScope;

function workerScopeQuery() {
  return { workerScope: WORKER_SCOPE };
}

function isConfirmedBrowserReady(file, compatibility = videoCompatibility(file?.name || '', file?.media || {})) {
  if (!file || file.kind !== 'video' || compatibility.mode !== 'native') return false;
  // Do not trust an MP4 extension by itself. A detected browser-safe codec, or
  // our own successful pre-upload preparation marker, makes this conclusive.
  return Boolean(compatibility.videoCodec || file.preparedFrom);
}

function pumpTranscodeQueue() {
  while (activeTranscodes < config.media.maxConcurrentTranscodes && transcodeQueue.length) {
    const job = transcodeQueue.shift();
    activeTranscodes += 1;
    void (async () => {
      // A queued job may have been cancelled before a worker became available.
      const current = await db.jobs.findOne({ _id: job._id });
      if (current?.status === 'queued') await runTranscode(current);
    })()
      .catch((err) => log.error(`transcode job ${job._id} crashed: ${err.message}`))
      .finally(() => {
        activeTranscodes -= 1;
        pumpTranscodeQueue();
      });
  }
}

function emit(userId, event, payload) {
  userBus(String(userId)).emit(event, payload);
}

async function update(jobId, patch) {
  await db.jobs.updateOne({ _id: jobId }, { $set: { ...patch, updatedAt: now() } });
}

export async function getJob(userId, jobId) {
  const job = await db.jobs.findOne({ _id: jobId, userId, ...workerScopeQuery() });
  if (!job) throw ApiError.notFound('Job not found');
  return job;
}

export async function listJobs(userId, { limit = 25 } = {}) {
  return db.jobs.find({ userId, ...workerScopeQuery() }, { sort: { createdAt: 'desc' }, limit });
}

/**
 * Creates a browser-playable H.264/AAC MP4. By default it atomically replaces
 * the legacy source record/storage object so the library keeps one video.
 */
export async function enqueueTranscode({ userId, fileId, maxDimension = config.media.transcodeMaxDimension, replace = true }) {
  const file = await db.files.findOne({ _id: fileId, userId });
  if (!file) throw ApiError.notFound('File not found');
  if (file.status !== 'ready') throw ApiError.badRequest('This file is not ready yet');
  if (file.kind !== 'video') throw ApiError.badRequest('Only video files can be converted');

  const running = await db.jobs.findOne({
    userId,
    fileId,
    type: 'transcode',
    status: { $in: ['queued', 'running'] },
    ...workerScopeQuery(),
  });
  if (running) return running;

  const compatibility = videoCompatibility(file.name, file.media || {});
  if (isConfirmedBrowserReady(file, compatibility)) {
    throw ApiError.conflict('This video is already browser-ready. Retry playback instead of converting it again.');
  }

  const caps = await getCapabilities();
  if (!caps.transcode) {
    throw ApiError.badRequest('Transcoding needs ffmpeg on the server. Install ffmpeg (or set FFMPEG_PATH) and ENABLE_TRANSCODE=1.');
  }

  const job = {
    _id: randomId(10),
    userId,
    workerScope: WORKER_SCOPE,
    fileId,
    type: 'transcode',
    status: 'queued',
    progress: 0,
    phase: 'queued',
    name: file.name,
    size: file.size,
    options: { maxDimension, replace, strategy: compatibility.strategy || 'transcode' },
    output: null,
    error: null,
    restartCount: 0,
    createdAt: now(),
    updatedAt: now(),
    finishedAt: null,
  };
  await db.jobs.insertOne(job);
  emit(userId, 'job:created', { job });

  transcodeQueue.push(job);
  pumpTranscodeQueue();
  return job;
}

async function runTranscode(job) {
  const { _id: jobId, userId, fileId } = job;
  const controller = new AbortController();
  controllers.set(jobId, controller);
  const workDir = path.join(config.paths.tmp, `transcode-${jobId}-${randomHex(3)}`);
  let source = null;
  await fsp.mkdir(workDir, { recursive: true });

  try {
    await update(jobId, { status: 'running', phase: 'downloading', progress: 1 });
    emit(userId, 'job:progress', { jobId, fileId, phase: 'downloading', percent: 1, name: job.name });

    const file = await db.files.findOne({ _id: fileId, userId });
    if (!file) throw new Error('Source file disappeared');

    const storedCompatibility = videoCompatibility(file.name, file.media || {});
    if (isConfirmedBrowserReady(file, storedCompatibility)) {
      const output = {
        fileId: file._id,
        name: file.name,
        size: file.size,
        originalSize: file.size,
        savedBytes: 0,
        strategy: 'none',
        replaced: true,
        skipped: true,
      };
      await update(jobId, {
        status: 'done',
        phase: 'done',
        progress: 100,
        error: null,
        finishedAt: now(),
        output,
      });
      emit(userId, 'job:done', { jobId, fileId, output, name: job.name });
      log.info(`skipped duplicate conversion for already browser-ready video ${file.name}`);
      return { jobId, skipped: true };
    }

    const provider = getProviderForFile(file);

    // 1) Materialise the source locally (Telegram files are streamed down).
    source = await provider.openLocal({
      userId,
      storage: file.storage,
      size: file.size,
      fileId,
      signal: controller.signal,
      onProgress: ({ percent }) => {
        const overall = Math.max(1, Math.min(15, Math.round(percent * 0.15)));
        update(jobId, { progress: overall }).catch(() => {});
        emit(userId, 'job:progress', { jobId, fileId, phase: 'downloading', percent: overall, name: job.name });
      },
    });

    // 2) Re-probe from the real bytes (authoritative codecs/duration).
    let media = file.media;
    try {
      media = (await probe(source.path, { name: file.name, mime: file.mime })) || media;
      await db.files.updateOne({ _id: fileId }, { $set: { media } });
    } catch {
      /* keep whatever we had */
    }

    const compatibility = videoCompatibility(file.name, media || {});
    const strategy = compatibility.strategy === 'remux' ? 'remux' : 'transcode';
    const { base } = splitName(file.name);
    const replace = job.options?.replace !== false;
    const outName = sanitizeFileName(replace ? `${base}.mp4` : `${base} (${strategy === 'remux' ? 'Web MP4' : 'H.264'}).mp4`);
    const outPath = path.join(workDir, outName);
    const processingPhase = strategy === 'remux' ? 'remuxing' : 'transcoding';

    await update(jobId, { phase: processingPhase, progress: 16, options: { ...(job.options || {}), strategy } });
    emit(userId, 'job:progress', { jobId, fileId, phase: processingPhase, percent: 16, name: job.name });

    // 3) ffmpeg → browser-compatible MP4 with faststart (seekable immediately).
    const processor = strategy === 'remux' ? remuxToMp4 : transcodeToH264;
    const result = await runVideoProcessing(() =>
      processor({
        inputPath: source.path,
        outputPath: outPath,
        media: media || {},
        signal: controller.signal,
        ...(strategy === 'transcode' ? { maxDimension: job.options?.maxDimension || config.media.transcodeMaxDimension } : {}),
        onProgress: ({ percent, speed }) => {
          const overall = Math.max(16, Math.min(92, 16 + Math.round((percent || 0) * 0.76)));
          update(jobId, { progress: overall }).catch(() => {});
          emit(userId, 'job:progress', { jobId, fileId, phase: processingPhase, percent: overall, speed, name: job.name });
        },
      }),
    );

    if (controller.signal.aborted) throw new Error('Cancelled');

    // 4) Store the result. Replacement uploads directly and then swaps the
    // source record, avoiding even a temporary second library entry.
    await update(jobId, { phase: 'saving', progress: 93 });
    emit(userId, 'job:progress', { jobId, fileId, phase: 'saving', percent: 93, name: outName });

    let outputFile;
    if (replace) {
      const outputMedia = (await probe(outPath, { name: outName, mime: 'video/mp4' })) || {
        ...(media || {}),
        vcodec: 'h264',
        acodec: 'aac',
        pixFmt: 'yuv420p',
        hevc: false,
      };
      const uploaded = await provider.upload({
        userId,
        fileId,
        filePath: outPath,
        fileName: outName,
        size: result.size,
        mimeType: 'video/mp4',
        kind: 'video',
        media: outputMedia,
        thumbPath: file.thumb?.path || null,
        folderPath: null,
        signal: controller.signal,
        onProgress: ({ percent = 0 }) => {
          const overall = Math.max(93, Math.min(99, 93 + Math.round((percent / 100) * 6)));
          update(jobId, { progress: overall }).catch(() => {});
          emit(userId, 'job:progress', { jobId, fileId, phase: 'saving', percent: overall, name: outName });
        },
      });
      const replacement = {
        name: outName,
        originalName: file.originalName || file.name,
        ext: 'mp4',
        mime: 'video/mp4',
        kind: 'video',
        size: result.size,
        provider: provider.name,
        storage: uploaded.storage,
        // Kept only until the old remote object is confirmed deleted. If the
        // process restarts between the swap and cleanup, recoverOnBoot retries.
        staleStorage: file.storage,
        media: outputMedia,
        status: 'ready',
        progress: 100,
        error: null,
        checksum: null,
        preparedFrom: {
          name: file.name,
          size: file.size,
          videoCodec: media?.vcodec || null,
          pixelFormat: media?.pixFmt || null,
          strategy,
        },
        uploadedAt: now(),
        updatedAt: now(),
      };
      try {
        await db.files.updateOne({ _id: fileId, userId }, { $set: replacement, $unset: { localPayloadPath: true } });
      } catch (databaseError) {
        // The library still points to the old object, so remove the newly
        // uploaded orphan and leave the source record untouched.
        await provider.delete({ userId, storage: uploaded.storage, fileId }).catch((cleanupError) => {
          log.warn(`could not clean up replacement upload after database failure: ${cleanupError.message}`);
        });
        throw databaseError;
      }
      outputFile = { ...file, ...replacement };
      emit(userId, 'file:updated', { file: publicFile(outputFile) });
      try {
        await provider.delete({ userId, storage: file.storage, fileId });
        await db.files.updateOne({ _id: fileId, userId }, { $unset: { staleStorage: true } });
        delete outputFile.staleStorage;
      } catch (cleanupError) {
        log.warn(`replacement saved; old Telegram cleanup will retry after restart for ${file.name}: ${cleanupError.message}`);
      }
    } else {
      const created = await ingestLocalFile({
        userId,
        filePath: outPath,
        name: outName,
        size: result.size,
        mime: 'video/mp4',
        folderId: file.folderId || null,
        derivedFrom: fileId,
        awaitReady: true,
      });
      await db.files.updateOne({ _id: fileId }, { $addToSet: { derivatives: created._id } });
      outputFile = created;
    }

    await update(jobId, {
      status: 'done',
      phase: 'done',
      progress: 100,
      finishedAt: now(),
      output: {
        fileId: outputFile._id,
        name: outName,
        size: result.size,
        originalSize: file.size,
        savedBytes: (file.size || 0) - result.size,
        strategy,
        replaced: replace,
      },
    });
    emit(userId, 'job:done', {
      jobId,
      fileId,
      output: { fileId: outputFile._id, name: outName, size: result.size, strategy, replaced: replace },
      name: job.name,
    });
    log.info(
      `${strategy === 'remux' ? 'remuxed' : 'transcoded'} ${file.name} → ${outName} (${formatBytes(file.size)} → ${formatBytes(
        result.size,
      )})${replace ? ' · replaced original' : ''}`,
    );
    return { jobId };
  } catch (err) {
    const cancelled = controller.signal.aborted || /cancel/i.test(err?.message || '');
    await update(jobId, {
      status: cancelled ? 'cancelled' : 'failed',
      phase: cancelled ? 'cancelled' : 'failed',
      error: cancelled ? 'Cancelled' : err.message,
      finishedAt: now(),
    });
    emit(userId, cancelled ? 'job:cancelled' : 'job:failed', { jobId, fileId, error: cancelled ? 'Cancelled' : err.message, name: job.name });
    log.warn(`transcode ${jobId} ${cancelled ? 'cancelled' : `failed: ${err.message}`}`);
    return null;
  } finally {
    controllers.delete(jobId);
    if (source?.cleanup) await source.cleanup().catch(() => {});
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function cancelJob({ userId, jobId }) {
  const job = await getJob(userId, jobId);
  if (!['queued', 'running'].includes(job.status)) throw ApiError.badRequest(`Job is already ${job.status}`);
  controllers.get(jobId)?.abort();
  await update(jobId, { status: 'cancelled', phase: 'cancelled', error: 'Cancelled', finishedAt: now() });
  emit(userId, 'job:cancelled', { jobId, fileId: job.fileId, name: job.name });
  return { ok: true };
}

/**
 * Regenerates thumbnails / web preview for an existing file (e.g. after
 * installing ffmpeg, or when a HEIC preview is missing).
 */
export async function enqueueRegenerate({ userId, fileId }) {
  const caps = await getCapabilities();
  const file = await db.files.findOne({ _id: fileId, userId });
  if (!file) throw ApiError.notFound('File not found');
  if (file.status !== 'ready') throw ApiError.badRequest('File is not ready');
  if (!caps.thumbnails && !caps.webPreviews) throw ApiError.badRequest('No media tooling available (install ffmpeg or sharp)');

  const job = {
    _id: randomId(10),
    userId,
    workerScope: WORKER_SCOPE,
    fileId,
    type: 'regenerate',
    status: 'running',
    progress: 5,
    phase: 'downloading',
    name: file.name,
    size: file.size,
    options: {},
    output: null,
    error: null,
    createdAt: now(),
    updatedAt: now(),
    finishedAt: null,
  };
  await db.jobs.insertOne(job);
  emit(userId, 'job:created', { job });

  void (async () => {
    const controller = new AbortController();
    controllers.set(job._id, controller);
    try {
      const provider = getProviderForFile(file);
      const source = await provider.openLocal({
        userId,
        storage: file.storage,
        size: file.size,
        fileId,
        signal: controller.signal,
        onProgress: ({ percent }) => {
          const overall = Math.max(5, Math.min(45, Math.round(percent * 0.45)));
          update(job._id, { progress: overall }).catch(() => {});
          emit(userId, 'job:progress', { jobId: job._id, fileId, phase: 'downloading', percent: overall, name: file.name });
        },
      });
      const media = (await probe(source.path, { name: file.name, mime: file.mime })) || file.media;
      const thumbs = await generateThumbnails({ localPath: source.path, fileId, kind: file.kind, media: media || {}, name: file.name, mime: file.mime });
      const preview = await ensureWebPreview({ localPath: source.path, fileId, kind: file.kind, name: file.name, mime: file.mime, media: media || {} });
      await source.cleanup?.();
      await db.files.updateOne(
        { _id: fileId },
        {
          $set: {
            media,
            thumb: thumbs.thumbPath
              ? { available: true, path: thumbs.thumbPath, width: thumbs.width, height: thumbs.height, lqip: thumbs.lqip || null, generatedAt: thumbs.generatedAt }
              : file.thumb,
            preview: preview ? { path: preview.path, generatedAt: now() } : file.preview,
            updatedAt: now(),
          },
        },
      );
      await update(job._id, { status: 'done', phase: 'done', progress: 100, finishedAt: now() });
      emit(userId, 'job:done', { jobId: job._id, fileId, name: file.name });
      const updated = await db.files.findOne({ _id: fileId });
      emit(userId, 'file:updated', { file: publicFile(updated) });
    } catch (err) {
      await update(job._id, { status: 'failed', phase: 'failed', error: err.message, finishedAt: now() });
      emit(userId, 'job:failed', { jobId: job._id, fileId, error: err.message, name: file.name });
    } finally {
      controllers.delete(job._id);
    }
  })();

  return job;
}

/**
 * Re-queues transcodes interrupted by a deploy/restart. Their temporary files
 * are ephemeral, so the worker safely restarts from the Telegram original.
 * Other job types cannot currently be resumed and are marked failed.
 */
export async function recoverOnBoot() {
  // Finish any old-object deletion interrupted after a safe replacement swap.
  const staleFiles = await db.files.find({ staleStorage: { $exists: true } });
  for (const file of staleFiles) {
    if (!file.staleStorage) continue;
    try {
      const provider = getProviderForFile({ ...file, storage: file.staleStorage });
      await provider.delete({ userId: file.userId, storage: file.staleStorage, fileId: file._id });
      await db.files.updateOne({ _id: file._id, userId: file.userId }, { $unset: { staleStorage: true } });
    } catch (err) {
      log.warn(`deferred cleanup still pending for ${file.name}: ${err.message}`);
    }
  }

  const running = await db.jobs.find({ status: { $in: ['running', 'queued'] }, ...workerScopeQuery() });
  for (const job of running) {
    if (job.type === 'transcode') {
      const file = await db.files.findOne({ _id: job.fileId, userId: job.userId });
      const compatibility = file?.kind === 'video' ? videoCompatibility(file.name, file.media || {}) : null;
      // A restart may happen after the safe file swap but before the job's
      // final status update. Do not encode the already-prepared replacement a
      // second time.
      if (file?.status === 'ready' && isConfirmedBrowserReady(file, compatibility)) {
        const originalSize = file.preparedFrom?.size || job.size || file.size;
        await update(job._id, {
          status: 'done',
          phase: 'done',
          progress: 100,
          error: null,
          finishedAt: now(),
          output: {
            fileId: file._id,
            name: file.name,
            size: file.size,
            originalSize,
            savedBytes: (originalSize || 0) - (file.size || 0),
            strategy: 'none',
            replaced: true,
            skipped: true,
          },
        });
        continue;
      }
    }
    const restartCount = Number(job.restartCount || 0) + (job.status === 'running' ? 1 : 0);
    if (job.type === 'transcode' && restartCount <= 3) {
      const resumed = {
        ...job,
        status: 'queued',
        phase: 'queued',
        progress: 0,
        error: null,
        restartCount,
        finishedAt: null,
        updatedAt: now(),
      };
      await update(job._id, {
        status: resumed.status,
        phase: resumed.phase,
        progress: resumed.progress,
        error: resumed.error,
        restartCount: resumed.restartCount,
        finishedAt: resumed.finishedAt,
      });
      transcodeQueue.push(resumed);
      continue;
    }
    await update(job._id, {
      status: 'failed',
      error: job.type === 'transcode' ? 'Conversion was interrupted by repeated server restarts' : 'Interrupted by a server restart',
      restartCount,
      finishedAt: now(),
      phase: 'failed',
    });
  }
  pumpTranscodeQueue();
  return running.length;
}

export function jobHasController(jobId) {
  return controllers.has(jobId);
}

export async function purgeFinishedJobs({ olderThanDays = 7 } = {}) {
  const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
  const res = await db.jobs.deleteMany({ status: { $in: ['done', 'failed', 'cancelled'] }, updatedAt: { $lt: cutoff } });
  return res.deletedCount || 0;
}
export default { enqueueTranscode, enqueueRegenerate, cancelJob, listJobs, getJob, recoverOnBoot, purgeFinishedJobs };
