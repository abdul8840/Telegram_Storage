/**
 * Central configuration.
 *
 * Every value can be overridden with environment variables (see /.env.example).
 * The app can boot without MongoDB configuration by using an embedded
 * database. When MONGODB_URI is provided, MongoDB is required and a connection
 * failure stops startup. File uploads always require a connected Telegram
 * account; there is no permanent local-disk fallback.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.resolve(__dirname, '..');
export const ROOT_DIR = path.resolve(SERVER_DIR, '..');

// Load .env from the repository root first, then the server folder.
for (const candidate of [path.join(ROOT_DIR, '.env'), path.join(SERVER_DIR, '.env')]) {
  if (fs.existsSync(candidate)) dotenv.config({ path: candidate, override: false });
}

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};
const int = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};
const oneOf = (value, allowed, fallback) => (allowed.includes(String(value || '').toLowerCase()) ? String(value).toLowerCase() : fallback);
const abs = (p, base = ROOT_DIR) => (p ? path.resolve(base, p) : base);

const dataDir = abs(process.env.DATA_DIR || './data');

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  port: int(process.env.PORT, 5000),
  host: process.env.HOST || '0.0.0.0',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  corsOrigins: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  jwt: {
    // Keep the legacy development fallback so existing local sessions remain readable.
    secret: process.env.JWT_SECRET || 'telegram-cloud-dev-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
    cookieName: 'tgc_token',
  },

  // Key used to encrypt Telegram session strings at rest.
  encryptionKey: process.env.SESSION_ENCRYPTION_KEY || process.env.JWT_SECRET || 'telegram-cloud-dev-secret-change-me',

  db: {
    uri: process.env.MONGODB_URI || '',
    name: process.env.MONGODB_DB || 'telegram_cloud',
    // embedded (zero-config) fallback
    embeddedPath: path.join(dataDir, 'db'),
  },

  storage: {
    defaultProvider: 'telegram',
    // Legacy local objects remain readable, but new uploads never use this.
    localStoragePath: abs(process.env.LOCAL_STORAGE_PATH || './data/storage'),
  },

  telegram: {
    apiId: int(process.env.TG_API_ID, 0) || undefined,
    apiHash: process.env.TG_API_HASH || undefined,
    phone: process.env.TG_PHONE || undefined,
    chatTarget: process.env.TG_CHAT_TARGET || 'me',
    uploadWorkers: int(process.env.TG_UPLOAD_WORKERS, 3),
    uploadPartKb: int(process.env.TG_UPLOAD_PART_KB, 512),
    maxConcurrentUploads: int(process.env.TG_MAX_CONCURRENT_UPLOADS, 2),
    maxConcurrentDownloads: int(process.env.TG_MAX_CONCURRENT_DOWNLOADS, 4),
    // seconds of idleness before a Telegram client is disconnected
    clientIdleTimeoutMs: int(process.env.TG_CLIENT_IDLE_MS, 10 * 60 * 1000),
    sessionName: process.env.TG_SESSION_NAME || 'ZoZoCloud',
    deviceModel: process.env.TG_DEVICE_MODEL || 'ZoZoCloud',
  },

  media: {
    ffmpegPath: process.env.FFMPEG_PATH || '',
    ffprobePath: process.env.FFPROBE_PATH || '',
    enableTranscode: bool(process.env.ENABLE_TRANSCODE, true),
    // Fast browser-preview copies: the untouched original remains in Telegram.
    transcodePreset: oneOf(
      process.env.TRANSCODE_PRESET,
      ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'],
      'superfast',
    ),
    transcodeCrf: Math.max(18, Math.min(32, int(process.env.TRANSCODE_CRF, 24))),
    transcodeMaxDimension: Math.max(720, Math.min(3840, int(process.env.TRANSCODE_MAX_DIMENSION, 1920))),
    maxConcurrentTranscodes: Math.max(1, Math.min(4, int(process.env.MAX_CONCURRENT_TRANSCODES, 1))),
    thumbPath: abs(process.env.THUMB_PATH || './data/thumbs'),
    thumbWidth: int(process.env.THUMB_WIDTH, 480),
    lqipWidth: int(process.env.LQIP_WIDTH, 24),
  },

  paths: {
    data: dataDir,
    tmp: abs(process.env.TMP_PATH || './data/tmp'),
    uploads: abs(process.env.UPLOAD_TMP_PATH || './data/uploads'),
    clientDist: abs(process.env.CLIENT_DIST || './client/dist'),
  },

  limits: {
    maxUploadSize: int(process.env.MAX_UPLOAD_SIZE, 4 * 1024 * 1024 * 1024),
    defaultChunkSize: int(process.env.UPLOAD_CHUNK_SIZE, 8 * 1024 * 1024),
    maxTextPreviewBytes: int(process.env.MAX_TEXT_PREVIEW, 512 * 1024),
  },

  trash: {
    // days before trashed files are purged automatically (0 = never)
    autoPurgeDays: int(process.env.TRASH_AUTO_PURGE_DAYS, 30),
  },
};

// Make sure runtime directories exist.
for (const dir of [
  config.paths.data,
  config.paths.tmp,
  config.paths.uploads,
  config.media.thumbPath,
  config.db.embeddedPath,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

export default config;
