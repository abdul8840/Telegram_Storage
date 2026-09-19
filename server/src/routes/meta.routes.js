/** Server metadata: health, media capabilities, storage status, public config. */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import config from '../config.js';
import { dbInfo, db } from '../db/index.js';
import { asyncHandler } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { getCapabilities } from '../services/media.js';
import { storageStatus } from '../storage/index.js';
import { publicAccount, getAccount } from '../storage/telegramClient.js';

const router = express.Router();
const startedAt = Date.now();

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    database: dbInfo(),
    node: process.version,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});

/** What the browser is allowed to know without authentication. */
router.get('/config', (_req, res) => {
  res.json({
    version: readVersion(),
    maxUploadSize: config.limits.maxUploadSize,
    defaultChunkSize: config.limits.defaultChunkSize,
    defaultProvider: config.storage.defaultProvider,
    telegramEnvConfigured: !!(config.telegram.apiId && config.telegram.apiHash),
    defaultChatTarget: config.telegram.chatTarget,
    trashAutoPurgeDays: config.trash.autoPurgeDays,
    allowSignup: process.env.ALLOW_SIGNUP !== 'false',
  });
});

router.get(
  '/capabilities',
  requireAuth,
  asyncHandler(async (req, res) => {
    const [media, storage, account] = await Promise.all([
      getCapabilities(),
      storageStatus(req.userId),
      getAccount(req.userId),
    ]);
    res.json({
      media: {
        ffmpeg: media.ffmpeg.available,
        ffmpegVersion: media.ffmpeg.version || null,
        ffprobe: media.ffprobe.available,
        sharp: media.sharp,
        heic: media.heic,
        transcode: media.transcode,
        thumbnails: media.thumbnails,
        videoThumbnails: media.videoThumbnails,
        webPreviews: media.webPreviews,
      },
      storage,
      telegram: publicAccount(account),
      server: {
        node: process.version,
        platform: `${os.type()} ${os.release()}`,
        cpus: os.cpus().length,
        freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
        version: readVersion(),
      },
    });
  }),
);

/** Quick counters for the header badge (files, size, pending jobs). */
router.get(
  '/summary',
  requireAuth,
  asyncHandler(async (req, res) => {
    const [files, size, trashed, jobs] = await Promise.all([
      db.files.countDocuments({ userId: req.userId, trashed: false }),
      db.files.find({ userId: req.userId, trashed: false, status: 'ready' }, { projection: { size: 1 } }),
      db.files.countDocuments({ userId: req.userId, trashed: true }),
      db.jobs.countDocuments({ userId: req.userId, status: { $in: ['queued', 'running'] } }),
    ]);
    res.json({
      files,
      trashed,
      activeJobs: jobs,
      totalSize: size.reduce((sum, f) => sum + (Number(f.size) || 0), 0),
    });
  }),
);

export default router;
