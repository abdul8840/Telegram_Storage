/**
 * Media pipeline: ffprobe/ffmpeg + sharp (+ libheif for iPhone HEIC).
 *
 * Responsibilities
 *   • probe()               → codec, dimensions, duration, rotation, HEVC flag
 *   • generateThumbnails()  → 480px grid thumbnail, 320px Telegram thumbnail,
 *                             tiny base64 blur-up placeholder (LQIP)
 *   • webPreview()          → browser-viewable JPEG rendition for formats the
 *                             web cannot show (HEIC/HEIF, RAW, TIFF, BMP…)
 *   • transcodeToH264()     → HEVC/ProRes/odd-container → streamable H.264 MP4
 *                             with faststart, reporting progress and honouring
 *                             cancellation.
 *
 * Every binary is optional and detected at runtime: if ffmpeg or sharp is
 * missing the drive keeps working and simply reports reduced capabilities.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import config from '../config.js';
import { createSemaphore } from '../lib/concurrency.js';
import { createLogger } from '../lib/logger.js';
import { extOf, isHeicImage, kindOf, KIND } from '../lib/fileTypes.js';

const log = createLogger('media');
const videoProcessingSemaphore = createSemaphore(config.media.maxConcurrentTranscodes);

/** Shares the CPU-heavy media limit across new uploads and legacy jobs. */
export function runVideoProcessing(task) {
  return videoProcessingSemaphore.run(task);
}

// ── binary detection ───────────────────────────────────────────────────────

let capabilities = null;

async function tryVersion(bin, args = ['-version']) {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve(null);
    }, 6000);
    proc.stdout.on('data', (d) => {
      out += d.toString();
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out ? out.split('\n')[0].trim() : null);
    });
  });
}

function resolveFromOptionalPackage(pkg) {
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const mod = require(pkg);
    const p = mod?.path || mod?.default?.path;
    if (p && fs.existsSync(p)) return { path: p, source: pkg };
  } catch {
    /* optional dependency not installed */
  }
  return null;
}

// ESM cannot use require(); use createRequire for the optional installer packages.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

async function resolveBinary(name, configured) {
  if (configured) {
    const version = await tryVersion(configured);
    if (version) return { path: configured, version, source: 'env' };
    log.warn(`${name} at ${configured} is not executable — continuing the search`);
  }
  const fromPackage = resolveFromOptionalPackage(name === 'ffmpeg' ? '@ffmpeg-installer/ffmpeg' : '@ffprobe-installer/ffprobe');
  if (fromPackage) {
    const version = await tryVersion(fromPackage.path);
    if (version) return { ...fromPackage, version };
  }
  const onPath = await tryVersion(name);
  if (onPath) return { path: name, version: onPath, source: 'PATH' };
  return null;
}

async function detectSharp() {
  try {
    const mod = await import('sharp');
    const sharp = mod.default || mod;
    const buffer = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#3366cc' } }).png().toBuffer();
    return buffer.length > 0 ? sharp : null;
  } catch (err) {
    log.warn(`sharp unavailable (${err.message}) — image thumbnails will use ffmpeg only`);
    return null;
  }
}

async function detectHeic() {
  try {
    const mod = await import('heic-convert');
    return mod.default || mod;
  } catch {
    return null;
  }
}

let sharpRef = null;
let heicRef = null;

export async function getCapabilities({ refresh = false } = {}) {
  if (capabilities && !refresh) return capabilities;
  const [ffmpeg, ffprobe] = await Promise.all([
    resolveBinary('ffmpeg', config.media.ffmpegPath),
    resolveBinary('ffprobe', config.media.ffprobePath),
  ]);
  sharpRef = await detectSharp();
  heicRef = await detectHeic();

  capabilities = {
    ffmpeg: ffmpeg ? { available: true, path: ffmpeg.path, version: ffmpeg.version, source: ffmpeg.source } : { available: false },
    ffprobe: ffprobe ? { available: true, path: ffprobe.path, version: ffprobe.version, source: ffprobe.source } : { available: false },
    sharp: !!sharpRef,
    heic: !!heicRef,
    transcode: !!(ffmpeg && config.media.enableTranscode),
    thumbnails: !!(ffmpeg || sharpRef),
    videoThumbnails: !!ffmpeg,
    webPreviews: !!(heicRef || ffmpeg || sharpRef),
  };
  log.info(
    `media capabilities: ffmpeg=${capabilities.ffmpeg.available ? capabilities.ffmpeg.source : 'no'} ffprobe=${
      capabilities.ffprobe.available ? capabilities.ffprobe.source : 'no'
    } sharp=${capabilities.sharp} heic=${capabilities.heic}`,
  );
  return capabilities;
}

function run(bin, args, { timeoutMs = 120_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${path.basename(bin)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = () => {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 1500).unref?.();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Cancelled'));
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(bin)} exited with ${code}: ${stderr.slice(-500)}`));
    });
  });
}

// ── probing ────────────────────────────────────────────────────────────────

function parseRotation(stream) {
  const displayMatrix = (stream?.side_data_list || []).find((s) => s.rotation !== undefined);
  if (displayMatrix) return Number(displayMatrix.rotation) || 0;
  const tag = stream?.tags?.rotate || stream?.tags?.ROTATE;
  return tag ? Number(tag) || 0 : 0;
}

/**
 * Returns a normalised media descriptor, or null when nothing could be learned.
 */
export async function probe(localPath, { mime = '', name = '' } = {}) {
  const caps = await getCapabilities();
  const kind = kindOf(name || localPath, mime);
  const result = {
    kind,
    duration: null,
    width: null,
    height: null,
    vcodec: null,
    acodec: null,
    codecTag: null,
    pixFmt: null,
    fps: null,
    bitrate: null,
    channels: null,
    sampleRate: null,
    hasVideo: false,
    hasAudio: false,
    hevc: false,
    rotation: 0,
    format: null,
    title: null,
    artist: null,
    probedAt: new Date().toISOString(),
  };

  if (caps.ffprobe.available) {
    try {
      const { stdout } = await run(caps.ffprobe.path, [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        localPath,
      ], { timeoutMs: 60_000 });
      const data = JSON.parse(stdout);
      const streams = data.streams || [];
      const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
      const attachedPic = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1);
      const audio = streams.find((s) => s.codec_type === 'audio');

      if (video) {
        result.hasVideo = true;
        result.vcodec = video.codec_name || null;
        result.codecTag = video.codec_tag_string || null;
        result.pixFmt = video.pix_fmt || null;
        result.width = video.width || null;
        result.height = video.height || null;
        result.rotation = parseRotation(video);
        const [num, den] = String(video.avg_frame_rate || '').split('/').map(Number);
        result.fps = num && den ? Math.round((num / den) * 100) / 100 : null;
        result.duration = Number(video.duration || data.format?.duration || 0) || null;
        result.bitrate = Number(video.bit_rate || data.format?.bit_rate || 0) || null;
      } else if (attachedPic) {
        result.width = attachedPic.width || null;
        result.height = attachedPic.height || null;
        result.vcodec = attachedPic.codec_name || null;
      }
      if (audio) {
        result.hasAudio = true;
        result.acodec = audio.codec_name || null;
        result.channels = audio.channels || null;
        result.sampleRate = audio.sample_rate ? Number(audio.sample_rate) : null;
        if (!result.duration) result.duration = Number(audio.duration || data.format?.duration || 0) || null;
      }
      if (data.format) {
        result.format = data.format.format_name || null;
        result.duration = result.duration || (Number(data.format.duration) || null);
        result.bitrate = result.bitrate || (Number(data.format.bit_rate) || null);
        const tags = data.format.tags || {};
        result.title = tags.title || tags.TITLE || null;
        result.artist = tags.artist || tags.ARTIST || tags.album_artist || null;
      }
      const v = String(result.vcodec || '').toLowerCase();
      result.hevc = ['hevc', 'h265', 'hvc1', 'hev1'].some((c) => v.includes(c)) || String(result.codecTag || '').toLowerCase() === 'hvc1';
      // A still image reported through ffprobe has no meaningful duration.
      if (kind === KIND.IMAGE) result.duration = null;
    } catch (err) {
      log.debug(`ffprobe failed for ${path.basename(localPath)}: ${err.message}`);
    }
  }

  // Image dimensions/orientation: sharp is faster and reads EXIF properly.
  if (kind === KIND.IMAGE && sharpRef && !isHeicImage(name || localPath, mime)) {
    try {
      const meta = await sharpRef(localPath).metadata();
      result.width = result.width || meta.width || null;
      result.height = result.height || meta.height || null;
      result.format = result.format || meta.format || null;
      if (meta.orientation && meta.orientation !== 1) result.rotation = result.rotation || [0, 0, 180, 180, 90, -90, -90, 90][meta.orientation - 1] || 0;
      if (!result.vcodec) result.vcodec = meta.format === 'heif' ? meta.codec || 'hevc' : null;
    } catch (err) {
      log.debug(`sharp metadata failed: ${err.message}`);
    }
  }

  const learned = result.width || result.height || result.duration || result.vcodec || result.acodec || result.format;
  return learned ? result : null;
}

// ── HEIC / HEIF decoding ───────────────────────────────────────────────────

/**
 * Decodes HEIC/HEIF (iPhone photos) to a JPEG buffer.
 * Order: libheif (heic-convert) → ffmpeg (v7+ can demux HEIC) → unavailable.
 */
export async function heifToJpeg(inputPath, { quality = 0.92, maxWidth = 4096 } = {}) {
  const caps = await getCapabilities();
  if (heicRef) {
    try {
      const buffer = await fsp.readFile(inputPath);
      const out = await heicRef({ buffer, format: 'JPEG', quality });
      const jpeg = Buffer.from(out);
      if (jpeg.length) {
        if (sharpRef) {
          try {
            return await sharpRef(jpeg).rotate().resize({ width: maxWidth, withoutEnlargement: true }).jpeg({ quality: Math.round(quality * 100) }).toBuffer();
          } catch {
            return jpeg;
          }
        }
        return jpeg;
      }
    } catch (err) {
      log.warn(`libheif HEIC decode failed (${err.message}) — trying ffmpeg`);
    }
  }
  if (caps.ffmpeg.available) {
    const out = `${inputPath}.heic.jpg`;
    try {
      await run(
        caps.ffmpeg.path,
        ['-nostdin', '-y', '-i', inputPath, '-frames:v', '1', '-vf', `scale='min(${maxWidth},iw)':-2`, '-q:v', '3', out],
        { timeoutMs: 120_000 },
      );
      const jpeg = await fsp.readFile(out);
      await fsp.unlink(out).catch(() => {});
      if (jpeg.length) return jpeg;
    } catch (err) {
      log.debug(`ffmpeg HEIC decode failed: ${err.message}`);
    }
  }
  return null;
}

// ── thumbnails ─────────────────────────────────────────────────────────────

function thumbPathsFor(fileId) {
  const dir = path.join(config.media.thumbPath, String(fileId).slice(0, 2));
  return {
    dir,
    main: path.join(dir, `${fileId}.jpg`),
    telegram: path.join(dir, `${fileId}-tg.jpg`),
    preview: path.join(dir, `${fileId}-preview.jpg`),
  };
}

export { thumbPathsFor };

async function ffmpegThumbnail({ ffmpegPath, inputPath, outPath, atSeconds, width }) {
  const vf = `scale=${width}:-2:force_original_aspect_ratio=decrease`;
  const attempts = atSeconds > 0 ? [atSeconds, 0] : [0];
  let lastError = null;
  for (const at of attempts) {
    try {
      await run(
        ffmpegPath,
        ['-nostdin', '-y', at > 0 ? '-ss' : null, at > 0 ? String(at) : null, '-i', inputPath, '-frames:v', '1', '-vf', vf, '-q:v', '4', outPath].filter(
          (a) => a !== null,
        ),
        { timeoutMs: 120_000 },
      );
      if (fs.existsSync(outPath) && (await fsp.stat(outPath)).size > 0) return true;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) log.debug(`ffmpeg thumbnail failed: ${lastError.message}`);
  return false;
}

async function sharpThumbnail({ inputPath, outPath, width, buffer }) {
  if (!sharpRef) return false;
  try {
    let pipeline = buffer ? sharpRef(buffer) : sharpRef(inputPath, { failOn: 'none' });
    pipeline = pipeline.rotate(); // honour EXIF orientation
    await pipeline.resize({ width, withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toFile(outPath);
    return (await fsp.stat(outPath)).size > 0;
  } catch (err) {
    log.debug(`sharp thumbnail failed: ${err.message}`);
    return false;
  }
}

async function makeTelegramThumb(mainThumb, tgPath) {
  if (!sharpRef || !fs.existsSync(mainThumb)) return null;
  try {
    for (const quality of [70, 55, 40, 28]) {
      await sharpRef(mainThumb)
        .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toFile(tgPath);
      const stats = await fsp.stat(tgPath);
      // Telegram only accepts document thumbnails below ~20 kB / 320×320.
      if (stats.size > 0 && stats.size <= 20_000) return tgPath;
    }
    return tgPath;
  } catch (err) {
    log.debug(`telegram thumbnail failed: ${err.message}`);
    return null;
  }
}

async function makeLqip(mainThumb) {
  if (!sharpRef || !fs.existsSync(mainThumb)) return null;
  try {
    const buf = await sharpRef(mainThumb)
      .resize({ width: config.media.lqipWidth, withoutEnlargement: true })
      .blur(0.6)
      .jpeg({ quality: 38, mozjpeg: true })
      .toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch (err) {
    log.debug(`lqip failed: ${err.message}`);
    return null;
  }
}

/** Extracts embedded cover art from audio files (mp3/m4a/flac). */
async function audioCover({ ffmpegPath, inputPath, outPath }) {
  try {
    await run(ffmpegPath, ['-nostdin', '-y', '-i', inputPath, '-an', '-vcodec', 'copy', outPath], { timeoutMs: 60_000 });
    if (fs.existsSync(outPath)) {
      const stats = await fsp.stat(outPath);
      if (stats.size > 1024) return true;
      await fsp.unlink(outPath).catch(() => {});
    }
  } catch {
    /* no cover art — perfectly normal */
  }
  return false;
}

/**
 * Generates every derived image we keep for a file.
 * Returns { thumbPath, tgThumbPath, lqip, width, height, generatedAt }.
 */
export async function generateThumbnails({ localPath, fileId, kind, media = {}, name = '', mime = '' }) {
  const caps = await getCapabilities();
  const paths = thumbPathsFor(fileId);
  await fsp.mkdir(paths.dir, { recursive: true });
  const width = config.media.thumbWidth;
  const out = { thumbPath: null, tgThumbPath: null, lqip: null, width: null, height: null, generatedAt: new Date().toISOString() };

  try {
    let made = false;

    if (kind === KIND.VIDEO || kind === KIND.IMAGE || kind === KIND.AUDIO) {
      if (kind === KIND.IMAGE && isHeicImage(name, mime)) {
        const jpeg = await heifToJpeg(localPath, { maxWidth: 2048 });
        made = jpeg ? await sharpThumbnail({ inputPath: null, buffer: jpeg, outPath: paths.main, width }) : false;
      } else if (kind === KIND.VIDEO && caps.ffmpeg.available) {
        const at = media?.duration ? Math.min(Math.max(0.5, media.duration * 0.08), Math.max(0.5, media.duration - 0.5)) : 0;
        made = await ffmpegThumbnail({ ffmpegPath: caps.ffmpeg.path, inputPath: localPath, outPath: paths.main, atSeconds: at, width });
      } else if (kind === KIND.AUDIO && caps.ffmpeg.available) {
        made = await audioCover({ ffmpegPath: caps.ffmpeg.path, inputPath: localPath, outPath: paths.main });
      } else if (kind === KIND.IMAGE) {
        made = await sharpThumbnail({ inputPath: localPath, outPath: paths.main, width });
        if (!made && caps.ffmpeg.available) {
          made = await ffmpegThumbnail({ ffmpegPath: caps.ffmpeg.path, inputPath: localPath, outPath: paths.main, atSeconds: 0, width });
        }
      }
    }

    if (!made) {
      // Nothing to show — remove any stale artefacts and report gracefully.
      await fsp.unlink(paths.main).catch(() => {});
      return out;
    }

    const stats = await fsp.stat(paths.main);
    out.thumbPath = paths.main;
    out.size = stats.size;
    if (sharpRef) {
      try {
        const meta = await sharpRef(paths.main).metadata();
        out.width = meta.width || null;
        out.height = meta.height || null;
      } catch {
        /* ignore */
      }
    }
    out.tgThumbPath = await makeTelegramThumb(paths.main, paths.telegram);
    out.lqip = await makeLqip(paths.main);
    return out;
  } catch (err) {
    log.warn(`thumbnail generation failed for ${fileId}: ${err.message}`);
    return out;
  }
}

/**
 * Creates (or refreshes) a browser-viewable JPEG rendition for formats the web
 * cannot display natively — HEIC/HEIF, RAW, TIFF, BMP, and HEVC video covers.
 */
export async function ensureWebPreview({ localPath, fileId, kind, name = '', mime = '', media = {}, maxWidth = 2560 }) {
  const caps = await getCapabilities();
  const paths = thumbPathsFor(fileId);
  await fsp.mkdir(paths.dir, { recursive: true });
  if (fs.existsSync(paths.preview)) return { path: paths.preview, cached: true };

  try {
    if (kind === KIND.IMAGE && (isHeicImage(name, mime) || ['tiff', 'tif', 'dng', 'cr2', 'nef', 'arw', 'raf', 'rw2'].includes(extOf(name)))) {
      let source = null;
      if (isHeicImage(name, mime)) source = await heifToJpeg(localPath, { maxWidth, quality: 0.92 });
      if (!source && sharpRef) {
        source = await sharpRef(localPath, { failOn: 'none' })
          .rotate()
          .resize({ width: maxWidth, withoutEnlargement: true })
          .jpeg({ quality: 88, mozjpeg: true })
          .toBuffer();
      }
      if (!source && caps.ffmpeg.available) {
        const ok = await ffmpegThumbnail({ ffmpegPath: caps.ffmpeg.path, inputPath: localPath, outPath: paths.preview, atSeconds: 0, width: maxWidth });
        if (ok) return { path: paths.preview, cached: false };
      }
      if (source) {
        await fsp.writeFile(paths.preview, source);
        return { path: paths.preview, cached: false };
      }
      return null;
    }
    if (kind === KIND.VIDEO && caps.ffmpeg.available) {
      // Poster frame at full preview width — used by players that need an image.
      const at = media?.duration ? Math.min(1.5, media.duration * 0.1) : 0;
      const ok = await ffmpegThumbnail({ ffmpegPath: caps.ffmpeg.path, inputPath: localPath, outPath: paths.preview, atSeconds: at, width: maxWidth });
      return ok ? { path: paths.preview, cached: false } : null;
    }
  } catch (err) {
    log.warn(`web preview failed for ${fileId}: ${err.message}`);
  }
  return null;
}

// ── transcoding ────────────────────────────────────────────────────────────

function runFfmpegMediaJob({ ffmpegPath, args, outputPath, duration = 0, onProgress, signal, label = 'Media processing' }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let progressBuffer = '';
    let finished = false;

    const onAbort = () => {
      if (finished) return;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!finished) proc.kill('SIGKILL');
      }, 2000).unref?.();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.stdout.on('data', (chunk) => {
      progressBuffer += chunk.toString();
      const records = progressBuffer.split(/\r?\n/);
      progressBuffer = records.pop() || '';
      let seconds = null;
      let speed = null;
      for (const record of records) {
        const [key, value] = record.split('=', 2);
        if (key === 'out_time_ms') seconds = Number(value) / 1_000_000;
        if (key === 'speed') speed = Number(String(value).replace(/x$/, '')) || null;
      }
      if (seconds !== null) {
        const percent = duration > 0 ? Math.max(0, Math.min(100, Math.round((seconds / duration) * 100))) : null;
        onProgress?.({ percent, seconds: Math.round(seconds), speed });
      }
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    proc.on('error', (err) => {
      finished = true;
      reject(err);
    });
    proc.on('close', async (code) => {
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        await fsp.unlink(outputPath).catch(() => {});
        return reject(new Error(`${label} cancelled`));
      }
      if (code !== 0) {
        await fsp.unlink(outputPath).catch(() => {});
        return reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-600)}`));
      }
      const stats = await fsp.stat(outputPath).catch(() => null);
      if (!stats || stats.size === 0) return reject(new Error(`${label} produced an empty file`));
      onProgress?.({ percent: 100, seconds: duration || null, speed: null, done: true });
      return resolve({ path: outputPath, size: stats.size });
    });
  });
}

/** Copies a compatible H.264 video stream into MP4 without re-encoding it. */
export async function remuxToMp4({ inputPath, outputPath, media = {}, onProgress, signal }) {
  const caps = await getCapabilities();
  if (!caps.ffmpeg.available) throw new Error('MP4 remuxing is unavailable: install ffmpeg or set FFMPEG_PATH');
  const duration = Number(media?.duration) || 0;
  const copyAudio = ['aac', 'mp3'].includes(String(media?.acodec || '').toLowerCase());
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const args = [
    '-nostdin', '-y', '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'copy',
    '-c:a', copyAudio ? 'copy' : 'aac',
    ...(copyAudio ? [] : ['-b:a', '128k', '-ac', '2']),
    '-movflags', '+faststart',
    '-avoid_negative_ts', 'make_zero',
    '-progress', 'pipe:1', '-nostats', outputPath,
  ];
  return runFfmpegMediaJob({
    ffmpegPath: caps.ffmpeg.path,
    args,
    outputPath,
    duration,
    onProgress,
    signal,
    label: 'MP4 preparation',
  });
}

/**
 * Re-encodes a video to a browser-friendly H.264/AAC MP4 with the moov atom at
 * the front (faststart) so playback can begin and seek immediately.
 *
 * @param {object} opts
 * @param {string} opts.inputPath   source file on local disk
 * @param {string} opts.outputPath  destination .mp4
 * @param {object} opts.media       probe() result (used for duration/progress)
 * @param {Function} opts.onProgress ({percent, seconds, speed}) => void
 * @param {AbortSignal} opts.signal
 */
export async function transcodeToH264({
  inputPath,
  outputPath,
  media = {},
  onProgress,
  signal,
  maxDimension = config.media.transcodeMaxDimension,
}) {
  const caps = await getCapabilities();
  if (!caps.transcode) throw new Error('Transcoding is unavailable: install ffmpeg (or set FFMPEG_PATH) and ENABLE_TRANSCODE=1');

  const duration = Number(media?.duration) || 0;
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  const sourceLargestDimension = Math.max(Number(media?.width) || 0, Number(media?.height) || 0);
  const videoFilter = sourceLargestDimension > maxDimension || !sourceLargestDimension
    ? [`scale='min(${maxDimension},iw)':'min(${maxDimension},ih)':force_original_aspect_ratio=decrease`, 'format=yuv420p'].join(',')
    : 'format=yuv420p';
  const args = [
    '-nostdin',
    '-y',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    config.media.transcodePreset,
    '-crf',
    String(config.media.transcodeCrf),
    '-profile:v',
    'main',
    '-level',
    '4.1',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '60',
    '-keyint_min',
    '30',
    '-vf',
    videoFilter,
    '-c:a',
    'aac',
    '-profile:a',
    'aac_low',
    '-b:a',
    '128k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-max_muxing_queue_size',
    '2048',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    outputPath,
  ];

  return runFfmpegMediaJob({
    ffmpegPath: caps.ffmpeg.path,
    args,
    outputPath,
    duration,
    onProgress,
    signal,
    label: 'Transcode',
  });
}

export async function deleteThumbnails(fileId) {
  const paths = thumbPathsFor(fileId);
  await Promise.all([paths.main, paths.telegram, paths.preview].map((p) => fsp.unlink(p).catch(() => {})));
}

export default {
  getCapabilities,
  probe,
  generateThumbnails,
  ensureWebPreview,
  remuxToMp4,
  transcodeToH264,
  runVideoProcessing,
  heifToJpeg,
  thumbPathsFor,
  deleteThumbnails,
};
