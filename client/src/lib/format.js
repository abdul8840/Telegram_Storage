/** Display helpers: sizes, dates, durations, labels, colours. */

export function formatBytes(bytes = 0, decimals = 1) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(k)), units.length - 1);
  const value = n / Math.pow(k, i);
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : decimals)} ${units[i]}`;
}

export function formatDuration(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (!s) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

export function formatDate(value, { relative = true } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const now = Date.now();
  const diff = now - date.getTime();
  if (relative) {
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hr${hours > 1 ? 's' : ''} ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`;
  }
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function extLabel(name = '') {
  const ext = String(name).split('.').pop();
  if (!ext || ext === name) return 'FILE';
  return ext.toUpperCase().slice(0, 5);
}

/** Accent colour per file kind — used for icons and the storage breakdown bar. */
export const KIND_COLOR = {
  image: '#4cc2ff',
  video: '#a855f7',
  audio: '#35d07f',
  doc: '#ffb547',
  text: '#7fd4ff',
  archive: '#ff8d97',
  other: '#94a0c4',
};

export const KIND_LABEL = {
  image: 'Photos',
  video: 'Videos',
  audio: 'Audio',
  doc: 'Documents',
  text: 'Text & code',
  archive: 'Archives',
  other: 'Other',
};

export function timeAgoShort(value) {
  if (!value) return '';
  const diff = Date.now() - new Date(value).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return formatDate(value, { relative: false });
}

/** Rough remaining time from a byte rate. */
export function eta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return `${Math.round(seconds)}s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m left`;
  return `${Math.round(seconds / 3600)}h left`;
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export default { formatBytes, formatDate, formatDateTime, formatDuration, formatSpeed, initials, extLabel };
