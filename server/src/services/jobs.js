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
import { getCapabilities, remuxToMp4, transcodeToH264, probe, ensureWebPreview, generateThumbnails } from './media.js';
import { ingestLocalFile, publicFile } from './uploadManager.js';

const log = createLogger('jobs');
const now = () => new Date().toISOString();
const controllers = new Map();
const transcodeQueue = [];
let activeTranscodes = 0;

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
  const job = await db.jobs.findOne({ _id: jobId, userId });
  if (!job) throw ApiError.notFound('Job not found');
  return job;
}

export async function listJobs(userId, { limit = 25 } = {}) {
  return db.jobs.find({ userId }, { sort: { createdAt: 'desc' }, limit });
}

/**
 * Creates a browser-playable H.264/AAC MP4 copy of a video and stores it in the
 * drive next to the original (which is never modified).
 */
export async function enqueueTranscode({ userId, fileId, maxDimension = config.media.transcodeMaxDimension, replace = false }) {
  const caps = await getCapabilities();
  if (!caps.transcode) {
    throw ApiError.badRequest('Transcoding needs ffmpeg on the server. Install ffmpeg (or set FFMPEG_PATH) and ENABLE_TRANSCODE=1.');
  }
  const file = await db.files.findOne({ _id: fileId, userId });
  if (!file) throw ApiError.notFound('File not found');
  if (file.status !== 'ready') throw ApiError.badRequest('This file is not ready yet');
  if (file.kind !== 'video') throw ApiError.badRequest('Only video files can be converted');

  const running = await db.jobs.findOne({ userId, fileId, type: 'transcode', status: { $in: ['queued', 'running'] } });
  if (running) return running;

  const job = {
    _id: randomId(10),
    userId,
    fileId,
    type: 'transcode',
    status: 'queued',
    progress: 0,
    phase: 'queued',
    name: file.name,
    size: file.size,
    options: { maxDimension, replace, strategy: videoCompatibility(file.name, file.media || {}).strategy || 'transcode' },
    output: null,
    error: null,
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
    const outName = sanitizeFileName(`${base} (${strategy === 'remux' ? 'Web MP4' : 'H.264'}).mp4`);
    const outPath = path.join(workDir, outName);
    const processingPhase = strategy === 'remux' ? 'remuxing' : 'transcoding';

    await update(jobId, { phase: processingPhase, progress: 16, options: { ...(job.options || {}), strategy } });
    emit(userId, 'job:progress', { jobId, fileId, phase: processingPhase, percent: 16, name: job.name });

    // 3) ffmpeg → browser-compatible MP4 with faststart (seekable immediately).
    const processor = strategy === 'remux' ? remuxToMp4 : transcodeToH264;
    const result = await processor({
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
    });

    if (controller.signal.aborted) throw new Error('Cancelled');

    // 4) Store the result like any other upload (probe, thumbs, Telegram).
    await update(jobId, { phase: 'saving', progress: 93 });
    emit(userId, 'job:progress', { jobId, fileId, phase: 'saving', percent: 93, name: outName });

    const created = await ingestLocalFile({
      userId,
      filePath: outPath,
      name: outName,
      size: result.size,
      mime: 'video/mp4',
      folderId: file.folderId || null,
      derivedFrom: fileId,
    });

    await db.files.updateOne({ _id: fileId }, { $addToSet: { derivatives: created._id } });
    await update(jobId, {
      status: 'done',
      phase: 'done',
      progress: 100,
      finishedAt: now(),
      output: {
        fileId: created._id,
        name: outName,
        size: result.size,
        originalSize: file.size,
        savedBytes: (file.size || 0) - result.size,
        strategy,
      },
    });
    emit(userId, 'job:done', { jobId, fileId, output: { fileId: created._id, name: outName, size: result.size, strategy }, name: job.name });
    log.info(`${strategy === 'remux' ? 'remuxed' : 'transcoded'} ${file.name} → ${outName} (${formatBytes(file.size)} → ${formatBytes(result.size)})`);
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

/** Marks jobs left "running" by a previous process as interrupted. */
export async function recoverOnBoot() {
  const running = await db.jobs.find({ status: { $in: ['running', 'queued'] } });
  for (const job of running) {
    await update(job._id, { status: 'failed', error: 'Interrupted by a server restart', finishedAt: now(), phase: 'failed' });
  }
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
