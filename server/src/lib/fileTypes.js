/**
 * File-type classification helpers shared by the API and the media pipeline.
 * Covers the formats people actually throw at a cloud drive — including the
 * iPhone/HEVC cases (HEIC stills, HEVC .mov videos, ProRes).
 */
import path from 'node:path';
import mime from 'mime-types';

export const KIND = {
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOC: 'doc',
  ARCHIVE: 'archive',
  TEXT: 'text',
  OTHER: 'other',
};

const EXT_KIND = {
  // images
  jpg: KIND.IMAGE, jpeg: KIND.IMAGE, jpe: KIND.IMAGE, png: KIND.IMAGE, gif: KIND.IMAGE, webp: KIND.IMAGE,
  avif: KIND.IMAGE, bmp: KIND.IMAGE, tiff: KIND.IMAGE, tif: KIND.IMAGE, svg: KIND.IMAGE, ico: KIND.IMAGE,
  heic: KIND.IMAGE, heif: KIND.IMAGE, heics: KIND.IMAGE, heifs: KIND.IMAGE, dng: KIND.IMAGE, cr2: KIND.IMAGE,
  nef: KIND.IMAGE, arw: KIND.IMAGE, raf: KIND.IMAGE, rw2: KIND.IMAGE, jxl: KIND.IMAGE,
  // video
  mp4: KIND.VIDEO, m4v: KIND.VIDEO, mov: KIND.VIDEO, mkv: KIND.VIDEO, webm: KIND.VIDEO, avi: KIND.VIDEO,
  wmv: KIND.VIDEO, flv: KIND.VIDEO, mpeg: KIND.VIDEO, mpg: KIND.VIDEO, m2ts: KIND.VIDEO, mts: KIND.VIDEO,
  ts: KIND.VIDEO, '3gp': KIND.VIDEO, '3g2': KIND.VIDEO, ogv: KIND.VIDEO, vob: KIND.VIDEO, mxf: KIND.VIDEO,
  // audio
  mp3: KIND.AUDIO, wav: KIND.AUDIO, flac: KIND.AUDIO, m4a: KIND.AUDIO, aac: KIND.AUDIO, ogg: KIND.AUDIO,
  oga: KIND.AUDIO, opus: KIND.AUDIO, wma: KIND.AUDIO, aiff: KIND.AUDIO, aif: KIND.AUDIO, alac: KIND.AUDIO,
  amr: KIND.AUDIO, mid: KIND.AUDIO, midi: KIND.AUDIO,
  // documents
  pdf: KIND.DOC, doc: KIND.DOC, docx: KIND.DOC, xls: KIND.DOC, xlsx: KIND.DOC, ppt: KIND.DOC, pptx: KIND.DOC,
  odt: KIND.DOC, ods: KIND.DOC, odp: KIND.DOC, rtf: KIND.DOC, txt: KIND.TEXT, md: KIND.TEXT, csv: KIND.TEXT,
  epub: KIND.DOC, mobi: KIND.DOC, pages: KIND.DOC, numbers: KIND.DOC, key: KIND.DOC, djvu: KIND.DOC,
  // code / text-ish
  json: KIND.TEXT, xml: KIND.TEXT, yml: KIND.TEXT, yaml: KIND.TEXT, toml: KIND.TEXT, ini: KIND.TEXT,
  js: KIND.TEXT, mjs: KIND.TEXT, cjs: KIND.TEXT, ts: KIND.TEXT, tsx: KIND.TEXT, jsx: KIND.TEXT,
  html: KIND.TEXT, htm: KIND.TEXT, css: KIND.TEXT, scss: KIND.TEXT, less: KIND.TEXT, py: KIND.TEXT,
  rb: KIND.TEXT, go: KIND.TEXT, rs: KIND.TEXT, java: KIND.TEXT, kt: KIND.TEXT, swift: KIND.TEXT,
  c: KIND.TEXT, h: KIND.TEXT, cpp: KIND.TEXT, hpp: KIND.TEXT, cs: KIND.TEXT, php: KIND.TEXT, sh: KIND.TEXT,
  bash: KIND.TEXT, zsh: KIND.TEXT, sql: KIND.TEXT, log: KIND.TEXT, env: KIND.TEXT, vue: KIND.TEXT, srt: KIND.TEXT, vtt: KIND.TEXT,
  // archives
  zip: KIND.ARCHIVE, rar: KIND.ARCHIVE, '7z': KIND.ARCHIVE, tar: KIND.ARCHIVE, gz: KIND.ARCHIVE,
  tgz: KIND.ARCHIVE, bz2: KIND.ARCHIVE, xz: KIND.ARCHIVE, zst: KIND.ARCHIVE, iso: KIND.ARCHIVE, dmg: KIND.ARCHIVE,
  apk: KIND.ARCHIVE, deb: KIND.ARCHIVE, rpm: KIND.ARCHIVE,
};

// `ts` is both TypeScript and an MPEG transport stream — prefer the text kind
// because the drive shows code files inline; the media probe still detects video.
export function extOf(name = '') {
  const ext = path.extname(String(name)).toLowerCase().replace(/^\./, '');
  return ext;
}

export function kindOf(name = '', mimeType = '') {
  const ext = extOf(name);
  if (EXT_KIND[ext]) return EXT_KIND[ext];
  const mt = (mimeType || mime.lookup(name) || '').toLowerCase();
  if (mt.startsWith('image/')) return KIND.IMAGE;
  if (mt.startsWith('video/')) return KIND.VIDEO;
  if (mt.startsWith('audio/')) return KIND.AUDIO;
  if (mt.startsWith('text/')) return KIND.TEXT;
  if (mt.includes('pdf') || mt.includes('word') || mt.includes('excel') || mt.includes('powerpoint') || mt.includes('document')) return KIND.DOC;
  if (mt.includes('zip') || mt.includes('compressed') || mt.includes('tar') || mt.includes('rar')) return KIND.ARCHIVE;
  return KIND.OTHER;
}

export function mimeOf(name = '', fallback = '') {
  return mime.lookup(name) || fallback || 'application/octet-stream';
}

/** Formats that browsers can generally play natively inside <video>. */
const MP4_VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov']);
const H264_CODECS = ['h264', 'avc1', 'avc'];
const HEVC_CODECS = ['hevc', 'h265', 'hvc1', 'hev1'];
const WEB_AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'webm']);

const includesCodec = (value, names) => names.some((codec) => String(value || '').toLowerCase().includes(codec));

/**
 * Describes container and codec compatibility separately. An extension such as
 * .mkv identifies the container, not the video codec stored inside it.
 */
export function videoCompatibility(name, media = {}) {
  const ext = extOf(name);
  const vcodec = String(media?.vcodec || media?.videoCodec || '').toLowerCase();
  const acodec = String(media?.acodec || media?.audioCodec || '').toLowerCase();
  const pixelFormat = String(media?.pixFmt || media?.pixelFormat || '').toLowerCase();
  const hevc = includesCodec(vcodec, HEVC_CODECS) || String(media?.codecTag || '').toLowerCase() === 'hvc1';
  const h264 = includesCodec(vcodec, H264_CODECS);
  const label = ext === 'mkv' ? 'Matroska (MKV)' : ext ? ext.toUpperCase() : 'Unknown';
  const base = {
    container: ext || null,
    containerLabel: label,
    videoCodec: vcodec || null,
    audioCodec: acodec || null,
    pixelFormat: pixelFormat || null,
    hevc,
  };

  if (MP4_VIDEO_EXTS.has(ext)) {
    if (hevc) {
      return {
        ...base,
        mode: 'conditional',
        strategy: 'transcode',
        reasonCode: 'conditional-codec',
        reason: `${label} container with HEVC video; playback depends on the browser, operating system and installed codec.`,
      };
    }
    const videoOk = !vcodec || h264 || includesCodec(vcodec, ['av1']);
    const audioOk = !acodec || includesCodec(acodec, ['aac', 'mp3', 'opus']);
    if (videoOk && audioOk) return { ...base, mode: 'native', strategy: null, reasonCode: null, reason: null };
    return {
      ...base,
      mode: 'convert',
      strategy: h264 ? 'remux' : 'transcode',
      reasonCode: videoOk ? 'audio-codec' : 'video-codec',
      reason: videoOk
        ? `${acodec || 'The audio codec'} is not reliably supported in an ${label} browser video.`
        : `${vcodec || 'The video codec'} is not supported reliably in an ${label} browser video.`,
    };
  }

  if (ext === 'webm') {
    const videoOk = !vcodec || includesCodec(vcodec, ['vp8', 'vp9', 'av1']);
    const audioOk = !acodec || includesCodec(acodec, ['opus', 'vorbis']);
    if (videoOk && audioOk) return { ...base, mode: 'native', strategy: null, reasonCode: null, reason: null };
    return {
      ...base,
      mode: 'convert',
      strategy: 'transcode',
      reasonCode: videoOk ? 'audio-codec' : 'video-codec',
      reason: `This WebM contains ${vcodec || 'a video codec'}${acodec ? ` with ${acodec} audio` : ''}, which is not a browser-safe WebM combination.`,
    };
  }

  if (ext === 'ogv' && (!vcodec || includesCodec(vcodec, ['theora']))) {
    return { ...base, mode: 'native', strategy: null, reasonCode: null, reason: null };
  }

  if (ext === 'mkv') {
    if (hevc) {
      const highBitDepth = /(?:p10|10le|10be|p12|12le|12be)/.test(pixelFormat);
      return {
        ...base,
        mode: 'convert',
        strategy: 'transcode',
        reasonCode: highBitDepth ? 'high-bit-depth-hevc' : 'hevc-mkv',
        reason: highBitDepth
          ? `${label} contains 10/12-bit HEVC video, which web browsers cannot reliably decode. ZoZoCloud will prepare a browser-safe H.264/AAC video.`
          : `${label} contains HEVC video, which is not a reliable HTML video combination. ZoZoCloud will prepare a browser-safe H.264/AAC video.`,
      };
    }
    return {
      ...base,
      // Chromium/Android and other platform media stacks vary here. Let the
      // actual HTML media element decide instead of rejecting every MKV on the
      // server solely because of its container.
      mode: 'attempt',
      strategy: h264 ? 'remux' : 'transcode',
      reasonCode: 'platform-dependent-container',
      reason: `${label} contains ${vcodec ? `${vcodec.toUpperCase()} video` : 'video'}${acodec ? ` with ${acodec.toUpperCase()} audio` : ''}. Native playback depends on this browser and device.`,
    };
  }

  return {
    ...base,
    mode: 'convert',
    // H.264 can be copied into MP4 without re-encoding the video stream.
    strategy: h264 ? 'remux' : 'transcode',
    reasonCode: 'container',
    reason: `${label} is the container${vcodec ? ` and its video stream is ${vcodec.toUpperCase()}` : ''}. This container is not supported reliably by HTML video.`,
  };
}

export function isWebPlayableVideo(name, media = {}) {
  return videoCompatibility(name, media).mode === 'native';
}

export function isHevc(name, media = {}) {
  const vcodec = String(media?.vcodec || media?.videoCodec || '').toLowerCase();
  if (vcodec) return includesCodec(vcodec, HEVC_CODECS);
  const ext = extOf(name);
  // iPhone "High Efficiency" recordings
  return ['mov', 'm4v', 'mp4', 'hevc', 'hvc1'].includes(ext) && /hevc|hvc/i.test(String(media?.codecTag || ''));
}

export function isHeicImage(name, mimeType = '') {
  const ext = extOf(name);
  return ['heic', 'heif', 'heics', 'heifs'].includes(ext) || /image\/hei[cf]/i.test(mimeType);
}

export function isPlayableAudio(name, media = {}) {
  const ext = extOf(name);
  if (!WEB_AUDIO_EXTS.has(ext)) return false;
  const acodec = String(media?.acodec || media?.audioCodec || '').toLowerCase();
  if (acodec && ['pcm', 'alac', 'wmav', 'amr'].some((c) => acodec.includes(c))) return false;
  return true;
}

export function isTextPreviewable(name, mimeType = '') {
  return kindOf(name, mimeType) === KIND.TEXT;
}

export function isPdf(name, mimeType = '') {
  return extOf(name) === 'pdf' || /application\/pdf/i.test(mimeType);
}

/** Safe display name: strips path separators but keeps unicode. */
export function sanitizeFileName(name = 'file') {
  const cleaned = String(name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\/\\]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return (cleaned || 'file').slice(0, 240);
}

export function sanitizeFolderName(name = '') {
  const cleaned = String(name).replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\/\\]/g, ' ').trim();
  return cleaned.slice(0, 120);
}

export function splitName(name = '') {
  const ext = path.extname(name);
  return { base: ext ? name.slice(0, -ext.length) : name, ext };
}

export function withSuffix(name, suffix, newExt) {
  const { base, ext } = splitName(name);
  return `${base}${suffix}${newExt ?? ext}`;
}

export function formatBytes(bytes = 0, decimals = 1) {
  if (!bytes || bytes < 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${units[i]}`;
}

export function formatDuration(seconds) {
  if (!seconds || !Number.isFinite(seconds)) return null;
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export default { KIND, extOf, kindOf, mimeOf, formatBytes, formatDuration, sanitizeFileName };
