/**
 * Range-aware streaming.
 *
 * This is the piece that makes a Telegram-backed drive feel like a real cloud:
 * browsers ask for `bytes=1234-5678` when the user scrubs a video, and we fetch
 * exactly that window from Telegram (MTProto supports arbitrary offsets) and
 * pipe it straight through — no buffering the whole file, no temp copies.
 *
 * Also handles:
 *   • correct Content-Type overrides (.mov H.264/HEVC → video/mp4 so Chrome and
 *     Safari will actually attempt playback instead of downloading)
 *   • ETag / If-None-Match / If-Range so players can resume efficiently
 *   • attachment vs inline disposition for downloads
 *   • abort propagation (closing the tab stops the Telegram download)
 */
import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import { createLogger } from '../lib/logger.js';
import { ApiError } from '../lib/errors.js';
import { extOf } from '../lib/fileTypes.js';
import { getProviderForFile } from '../storage/index.js';

const log = createLogger('stream');

/** Containers that are really MP4 under a different name. */
const MP4_ALIASES = new Set(['mov', 'm4v', 'mp4', 'qt']);

export function contentTypeFor(file) {
  const ext = extOf(file.name || '');
  const vcodec = String(file.media?.vcodec || '').toLowerCase();
  const acodec = String(file.media?.acodec || '').toLowerCase();

  // A QuickTime .mov holding H.264/HEVC+AAC is byte-compatible with MP4. Serving
  // it as video/mp4 lets Chrome/Edge/Firefox/Safari play (or attempt) it inline
  // instead of forcing a download.
  if (MP4_ALIASES.has(ext) && file.kind === 'video') {
    const videoOk = ['h264', 'avc1', 'hevc', 'hvc1', 'hev1', 'h265', 'vp9', 'av1', ''].some((c) => vcodec.includes(c));
    const audioOk = ['aac', 'mp3', 'opus', 'ac3', 'eac3', 'alac', 'pcm', ''].some((c) => acodec.includes(c));
    if (videoOk && audioOk) return 'video/mp4';
  }
  if (ext === 'mkv' && vcodec.includes('h264')) return 'video/x-matroska';
  if (['heic', 'heif'].includes(ext)) return 'image/heic';
  const looked = mime.lookup(file.name || '');
  return looked || file.mime || 'application/octet-stream';
}

function encodeDisposition(fileName, download) {
  const type = download ? 'attachment' : 'inline';
  const ascii = String(fileName).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(String(fileName)).replace(/['()]/g, escape);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

function parseRange(header, size) {
  if (!header || !header.startsWith('bytes=') || !size) return null;
  const spec = header.slice(6).split(',')[0].trim();
  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  let start;
  let end;
  if (!rawStart && !rawEnd) return null;
  if (!rawStart) {
    // suffix range: last N bytes
    const suffix = Number(rawEnd);
    if (!suffix) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return { invalid: true, start, end };
  return { start, end: Math.min(end, size - 1) };
}

export function etagFor(file, size) {
  return `W/"${file._id}-${size}-${file.updatedAt || file.createdAt || ''}"`;
}

/**
 * Streams a file (or one of its derived renditions) to the response.
 *
 * @param {object} req express request
 * @param {object} res express response
 * @param {object} opts
 * @param {object} opts.file        file document (must have `storage`)
 * @param {string} opts.userId      owner id (used for provider auth)
 * @param {boolean} opts.download   force Content-Disposition: attachment
 * @param {'original'|'preview'|'thumbnail'} opts.rendition
 */
export async function streamFile(req, res, { file, userId, download = false, rendition = 'original' }) {
  if (!file) throw ApiError.notFound('File not found');

  // ── derived renditions live on local disk ────────────────────────────────
  if (rendition === 'thumbnail' || rendition === 'preview') {
    const localPath =
      rendition === 'thumbnail'
        ? file.thumb?.available && fs.existsSync(file.thumb.path)
          ? file.thumb.path
          : null
        : file.preview?.path && fs.existsSync(file.preview.path)
          ? file.preview.path
          : null;
    if (!localPath) throw ApiError.notFound(rendition === 'thumbnail' ? 'No thumbnail for this file' : 'No preview rendition for this file');
    return sendLocalFile(req, res, localPath, {
      contentType: rendition === 'thumbnail' ? 'image/jpeg' : 'image/jpeg',
      fileName: rendition === 'thumbnail' ? `${file._id}.jpg` : `${file.name}.jpg`,
      cache: 'private, max-age=604800, immutable',
      download: false,
    });
  }

  if (file.status !== 'ready' || !file.storage) {
    if (file.status === 'failed') throw ApiError.badRequest(file.error || 'This upload failed and has no stored bytes');
    throw ApiError.conflict(`This file is still ${file.status}; it is not downloadable yet`);
  }

  const provider = getProviderForFile(file);
  const size = Number(file.size) || 0;
  const contentType = contentTypeFor(file);
  const etag = etagFor(file, size);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', etag);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', encodeDisposition(file.name, download));
  res.setHeader('Cache-Control', download ? 'private, no-cache' : 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (file.media?.duration) res.setHeader('X-Media-Duration', String(Math.round(file.media.duration)));
  if (file.media?.width && file.media?.height) {
    res.setHeader('X-Media-Width', String(file.media.width));
    res.setHeader('X-Media-Height', String(file.media.height));
  }

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  if (req.method === 'HEAD') {
    res.setHeader('Content-Length', String(size));
    res.status(200).end();
    return;
  }

  // If-Range: ignore the range header when the entity changed since the client
  // last saw it (so a player holding a partial response re-fetches fully).
  let rangeHeader = req.headers.range;
  if (rangeHeader && req.headers['if-range'] && req.headers['if-range'] !== etag) rangeHeader = undefined;
  const range = parseRange(rangeHeader, size);
  if (range?.invalid) {
    res.setHeader('Content-Range', `bytes */${size}`);
    res.status(416).end();
    return;
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : Math.max(0, size - 1);
  const length = Math.max(0, end - start + 1);

  const controller = new AbortController();
  res.on('close', () => controller.abort());

  try {
    const stream = await provider.createReadStream({
      userId,
      storage: file.storage,
      start,
      end,
      size,
      signal: controller.signal,
      fileId: file._id,
    });

    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    } else {
      res.status(200);
    }
    res.setHeader('Content-Length', String(length));

    stream.on('error', (err) => {
      log.warn(`stream error for ${file.name}: ${err.message}`);
      if (!res.headersSent) res.status(502).json({ error: `Storage error: ${err.message}` });
      else res.destroy();
    });
    stream.pipe(res);
  } catch (err) {
    controller.abort();
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof ApiError) throw err;
    log.warn(`could not open stream for ${file.name}: ${err.message}`);
    throw ApiError.upstream(`Could not read this file from storage: ${err.message}`);
  }
}

/** Sends a plain local file with range support (thumbnails, previews). */
export async function sendLocalFile(req, res, filePath, { contentType, fileName, cache = 'private, max-age=3600', download = false }) {
  const stats = await fspStat(filePath);
  if (!stats) throw ApiError.notFound('File is missing on the server');
  const size = stats.size;
  const etag = `W/"${path.basename(filePath)}-${size}-${Math.round(stats.mtimeMs)}"`;
  res.setHeader('Content-Type', contentType || mime.lookup(filePath) || 'application/octet-stream');
  res.setHeader('Cache-Control', cache);
  res.setHeader('ETag', etag);
  res.setHeader('Accept-Ranges', 'bytes');
  if (fileName) res.setHeader('Content-Disposition', encodeDisposition(fileName, download));
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  if (req.method === 'HEAD') {
    res.setHeader('Content-Length', String(size));
    return res.status(200).end();
  }
  const range = parseRange(req.headers.range, size);
  if (range?.invalid) {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Content-Length', String(end - start + 1));
  const stream = fs.createReadStream(filePath, { start, end });
  res.on('close', () => stream.destroy());
  stream.on('error', (err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy();
  });
  return stream.pipe(res);
}

async function fspStat(p) {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

export default { streamFile, sendLocalFile, contentTypeFor, parseRange, etagFor };
