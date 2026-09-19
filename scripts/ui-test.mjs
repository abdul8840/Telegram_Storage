/**
 * Headless UI integration test for the React client.
 *
 * There is no browser binary required: the real client source is bundled with
 * esbuild and evaluated inside jsdom against a running server (default
 * http://127.0.0.1:5000). It exercises signup → drive → chunked upload with
 * live SSE progress → HEVC detection → server-side H.264 transcode → public
 * share links → settings → trash/restore, and fails on any console error.
 *
 *   1. start the API:  npm --prefix server start
 *   2. run the test:   npm --prefix client run test:ui
 *
 * Options: BASE_URL=http://host:port node scripts/ui-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// Dev deps (jsdom, esbuild) live in client/node_modules.
const require = createRequire(path.join(ROOT, 'client', 'package.json'));
const requireServer = createRequire(path.join(ROOT, 'server', 'package.json'));
const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5000';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tgc-ui-'));
const FIX = path.join(WORK, 'fixtures');
const BUNDLE = path.join(WORK, 'bundle.js');
fs.mkdirSync(FIX, { recursive: true });

/* ── Test media (generated with the server's ffmpeg) ───────────────────── */
function ffmpeg() {
  try {
    return requireServer('@ffmpeg-installer/ffmpeg').path;
  } catch {
    // Fall back to a system install.
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
      return 'ffmpeg';
    } catch {
      throw new Error('run `npm install` inside server/ first — the test needs ffmpeg to build fixtures');
    }
  }
}

function makeFixtures() {
  const ff = ffmpeg();
  const jobs = [
    [['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '6', '-c:v', 'libx265', '-tag:v', 'hvc1', '-b:v', '9M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k'],
     'IMG_0142.HEVC.mov'],
    [['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '5', '-c:v', 'libx264', '-b:v', '3M', '-pix_fmt', 'yuv420p'],
     'clip-h264.mp4'],
    [['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1024x768:rate=1', '-frames:v', '1'], 'sunset.png'],
    [['-y', '-f', 'lavfi', '-i', 'mandelbrot=size=900x600:rate=1', '-frames:v', '1', '-q:v', '3'], 'mandelbrot.jpg'],
    [['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=8', '-c:a', 'libmp3lame', '-b:a', '128k'], 'tone.mp3'],
  ];
  for (const [args, name] of jobs) {
    const out = path.join(FIX, name);
    execFileSync(ff, [...args, out], { stdio: 'ignore' });
  }
  fs.writeFileSync(path.join(FIX, 'notes.txt'), `Trip packing list\n${'='.repeat(16)}\n\n- Passport\n- Chargers\n- iPhone (HEVC videos are converted on the server)\n\n${'Lorem ipsum dolor sit amet.\n'.repeat(40)}`);
}

/* ── Bundle the real client ────────────────────────────────────────────── */
function buildBundle() {
  const esbuild = require('esbuild');
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'ui-test-entry.jsx')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    outfile: BUNDLE,
    absWorkingDir: path.join(ROOT, 'client'),
    nodePaths: [path.join(ROOT, 'client', 'node_modules')],
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'warning',
  });
}

makeFixtures();
buildBundle();

const results = [];
const consoleErrors = [];
const IGNORE = [
  /Not implemented: HTMLMediaElement/i,
  /Could not parse CSS/i,
  /Not implemented: window\.scroll/i,
  /Error: Not implemented: navigation/i,
  /Download the React DevTools/i,
  // Route updates are intentionally synchronous (we do not opt into
  // v7_startTransition) so a click landing while a view settles is never lost.
  /React Router Future Flag Warning/i,
];

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => {
  const msg = err?.message || String(err);
  if (!IGNORE.some((re) => re.test(msg))) consoleErrors.push(`jsdomError: ${msg}`);
});
virtualConsole.on('error', (...args) => {
  const msg = args.map((a) => (a && a.stack) || String(a)).join(' ');
  if (!IGNORE.some((re) => re.test(msg))) consoleErrors.push(`console.error: ${msg.slice(0, 400)}`);
});
virtualConsole.on('warn', (...args) => {
  const msg = args.map((a) => String(a)).join(' ');
  if (/Warning:/.test(msg) && !IGNORE.some((re) => re.test(msg))) consoleErrors.push(`console.warn: ${msg.slice(0, 300)}`);
});

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  url: `${BASE}/login`,
  pretendToBeVisual: true,
  runScripts: 'dangerously',
  virtualConsole,
});
const { window } = dom;

/* ── Browser APIs jsdom lacks ─────────────────────────────────────────── */
window.matchMedia = (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
});
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};
window.URL.createObjectURL = () => `blob:mock/${Math.random().toString(36).slice(2)}`;
window.URL.revokeObjectURL = () => {};
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
for (const fn of ['play', 'pause', 'load']) {
  window.HTMLMediaElement.prototype[fn] = function stub() {
    return fn === 'play' ? Promise.resolve() : undefined;
  };
}
Object.defineProperty(window.HTMLMediaElement.prototype, 'canPlayType', {
  value: (type) => (/mp4|h264|avc1|mpeg|wav|ogg|webm/i.test(type) ? 'probably' : ''),
  writable: true,
});
window.navigator.clipboard = { writeText: async () => {} };
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? new URL(input, BASE).href : input instanceof URL ? input.href : input?.url;
  return fetch(url, init);
};

/** Minimal EventSource backed by Node fetch so real SSE events arrive. */
class MockEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.onmessage = null;
    this.onerror = null;
    this.onopen = null;
    this.controller = new AbortController();
    this.#connect();
  }

  async #connect() {
    try {
      const res = await fetch(new URL(this.url, BASE), {
        headers: { Accept: 'text/event-stream' },
        signal: this.controller.signal,
      });
      this.readyState = 1;
      this.onopen?.({});
      this.#emit('open', {});
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let event = 'message';
          const data = [];
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
          }
          if (!data.length) continue;
          const payload = { type: event, data: data.join('\n') };
          if (event === 'message') this.onmessage?.(payload);
          this.#emit(event, payload);
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        this.readyState = 2;
        this.onerror?.(err);
        this.#emit('error', err);
      }
    }
  }

  #emit(type, payload) {
    for (const fn of this.listeners[type] || []) {
      try {
        fn(payload);
      } catch (err) {
        consoleErrors.push(`SSE handler for ${type}: ${err.message}`);
      }
    }
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }

  close() {
    this.readyState = 2;
    this.controller.abort();
  }
}
window.EventSource = MockEventSource;

/* ── Helpers ──────────────────────────────────────────────────────────── */
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const doc = () => window.document;
const q = (sel) => doc().querySelector(sel);
const qa = (sel) => [...doc().querySelectorAll(sel)];
const labelOf = (el) =>
  `${el.textContent || ''} ${el.getAttribute?.('title') || ''} ${el.getAttribute?.('aria-label') || ''}`.replace(/\s+/g, ' ').trim();
const byText = (sel, re) => qa(sel).find((el) => re.test(el.textContent || ''));
const byLabel = (sel, re) => qa(sel).find((el) => re.test(labelOf(el)));
const cardNames = () => qa('.file-card').map((c) => c.querySelector('.file-card-name')?.textContent || c.textContent.slice(0, 40));
const findCard = (re) => {
  const card = qa('.file-card').find((c) => re.test(c.textContent));
  if (!card) throw new Error(`no card matching ${re} — cards: ${JSON.stringify(cardNames())}`);
  return card;
};
const click = (el, label = '') => {
  if (!el) throw new Error(`nothing to click (${label || 'element'})`);
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
};
const setValue = (el, value) => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
};

async function waitFor(fn, { timeout = 25000, interval = 120, label = 'condition' } = {}) {
  const started = Date.now();
  let lastError = null;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() - started > timeout) {
      throw new Error(`timed out after ${timeout}ms waiting for ${label}${lastError ? ` (${lastError.message})` : ''}`);
    }
    await tick(interval);
  }
}

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ ok: true, name, ms: Date.now() - started });
    console.log(`✓ ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ ok: false, name, error: err.message });
    console.log(`✗ ${name}\n    ${err.message}`);
  }
}

const authHeaders = (token, json = true) => ({
  Authorization: `Bearer ${token}`,
  ...(json ? { 'Content-Type': 'application/json' } : {}),
});

/** Real chunked upload from Node (exact bytes, no jsdom Blob conversion). */
async function seedUpload(token, file, name, mime) {
  const buf = fs.readFileSync(file);
  const created = await fetch(`${BASE}/api/uploads`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ name, size: buf.length, mime }),
  });
  if (!created.ok) throw new Error(`upload session failed: ${created.status} ${await created.text()}`);
  const { uploadId, chunkSize, totalChunks } = await created.json();
  for (let i = 0; i < totalChunks; i += 1) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, buf.length);
    const res = await fetch(`${BASE}/api/uploads/${uploadId}/chunks/${i}`, {
      method: 'PUT',
      headers: authHeaders(token, false),
      body: buf.subarray(start, end),
    });
    if (!res.ok) throw new Error(`chunk ${i} failed: ${res.status}`);
  }
  const done = await fetch(`${BASE}/api/uploads/${uploadId}/complete`, { method: 'POST', headers: authHeaders(token) });
  if (!done.ok) throw new Error(`complete failed: ${done.status} ${await done.text()}`);
  const { fileId } = await done.json();
  await waitFor(
    async () => {
      const res = await fetch(`${BASE}/api/files/${fileId}`, { headers: authHeaders(token) });
      const data = await res.json();
      return data.file?.status === 'ready' || data.status === 'ready';
    },
    { timeout: 60000, label: `${name} to finish processing` },
  );
  return fileId;
}

/* ── Boot the app ─────────────────────────────────────────────────────── */
window.eval(fs.readFileSync(BUNDLE, 'utf8'));
const T = window.__tgc;
if (!T) throw new Error('bundle did not expose window.__tgc');

const email = `ui+${Date.now()}@example.com`;
const password = 'cloud-drive-123';
let token = null;

const root = T.createRoot(doc().getElementById('root'));
root.render(T.React.createElement(T.App));
await tick(400);

console.log('\n── Telegram Cloud Drive · jsdom integration test ─────────────────────\n');

await check('app boots and shows the login form', async () => {
  await waitFor(() => q('#auth-email'), { label: '#auth-email' });
  if (!/Sign in/i.test(doc().body.textContent)) throw new Error('login card did not render');
  if (!/Telegram as your cloud drive|unlimited cloud drive/i.test(doc().body.textContent)) {
    throw new Error('marketing copy missing');
  }
});

await check('sign up creates an account and lands on the drive', async () => {
  click(byText('.tab', /create account/i), 'Create account tab');
  await waitFor(() => q('#auth-name'), { label: 'signup form' });
  setValue(q('#auth-name'), 'Abdul');
  setValue(q('#auth-email'), email);
  setValue(q('#auth-password'), password);
  click(q('.auth-form button[type=submit]'), 'submit');
  await waitFor(() => q('.sidebar'), { timeout: 30000, label: '.sidebar after signup' });
  await waitFor(() => window.location.pathname.startsWith('/drive'), { label: '/drive route' });
  token = window.localStorage.getItem('tgc_token');
  if (!token) throw new Error('no JWT stored after signup');
});

await check('empty drive shows the first-run empty state', async () => {
  await waitFor(() => q('.empty') || qa('.file-card').length, { label: 'empty state or cards' });
  if (!q('.empty')) throw new Error('expected the empty state on a fresh account');
  if (!/Nothing here yet|Drop files/i.test(doc().body.textContent)) throw new Error('empty state copy missing');
});

await check('sidebar, topbar, search and storage meter render', async () => {
  for (const sel of ['.sidebar-brand', '.nav-item', '#global-search', '.storage-meter', '.topbar-actions']) {
    if (!q(sel)) throw new Error(`missing ${sel}`);
  }
  if (!/Connect Telegram/i.test(q('.storage-meter').textContent)) {
    throw new Error('storage meter should invite the user to connect Telegram');
  }
});

/* ── Uploads through the real client queue ────────────────────────────── */
await check('client upload queue uploads a text file end to end', async () => {
  const notes = fs.readFileSync(`${FIX}/notes.txt`);
  const file = new window.File([new Uint8Array(notes)], 'notes.txt', { type: 'text/plain' });
  await T.useUploads.getState().add([{ file }], { folderId: null });
  await waitFor(() => q('.dock'), { timeout: 15000, label: '.dock to appear' });
  await waitFor(
    () => T.useUploads.getState().tasks.some((t) => t.status === 'ready'),
    { timeout: 45000, label: 'task to reach ready (SSE file:ready)' },
  );
  const task = T.useUploads.getState().tasks[0];
  if (!task.fileId) throw new Error('task has no fileId');
  await waitFor(() => qa('.file-card').length >= 1, { timeout: 20000, label: 'file card in the grid' });
  if (!/notes\.txt/.test(doc().body.textContent)) throw new Error('notes.txt not listed in the drive');
});

await check('dock shows progress metadata and can be dismissed', async () => {
  const dockText = q('.dock').textContent;
  if (!/Saved to Telegram cloud|Uploads complete/i.test(dockText)) throw new Error(`unexpected dock text: ${dockText.slice(0, 120)}`);
  click(byText('.dock-head button', /Dismiss/i) || qa('.dock-head button').pop(), 'dock dismiss');
  await waitFor(() => !q('.dock'), { timeout: 8000, label: 'dock to close' });
});

/* ── Seed a realistic library (binary files via the API) ──────────────── */
const seeded = {};
await check('seed HEVC mov, H.264 mp4, png, jpg and mp3 into the library', async () => {
  seeded.hevc = await seedUpload(token, `${FIX}/IMG_0142.HEVC.mov`, 'IMG_0142.HEVC.mov', 'video/quicktime');
  seeded.h264 = await seedUpload(token, `${FIX}/clip-h264.mp4`, 'clip-h264.mp4', 'video/mp4');
  seeded.png = await seedUpload(token, `${FIX}/sunset.png`, 'sunset.png', 'image/png');
  seeded.jpg = await seedUpload(token, `${FIX}/mandelbrot.jpg`, 'mandelbrot.jpg', 'image/jpeg');
  seeded.mp3 = await seedUpload(token, `${FIX}/tone.mp3`, 'tone.mp3', 'audio/mpeg');
  await T.useDrive.getState().load({ force: true });
  await waitFor(() => qa('.file-card').length >= 6, { timeout: 25000, label: '6 file cards' });
});

await check('server-probed metadata surfaces as badges (HEVC, duration)', async () => {
  await waitFor(() => qa('.thumb-badge').some((b) => /HEVC/i.test(b.textContent)), { timeout: 20000, label: 'HEVC badge' });
  const badges = qa('.thumb-badge').map((b) => b.textContent.trim());
  if (!badges.some((b) => /\d+:\d+/.test(b))) throw new Error(`no duration badge: ${badges.join(' | ')}`);
});

/* ── Views ────────────────────────────────────────────────────────────── */
await check('videos view warns about HEVC and offers Convert all', async () => {
  click(byText('.nav-item', /^videos/i), 'Videos nav');
  await waitFor(() => window.location.pathname === '/videos', { label: '/videos route' });
  await waitFor(() => q('.callout-warn'), { timeout: 15000, label: 'HEVC callout' });
  if (!/HEVC video/i.test(q('.callout-warn').textContent)) throw new Error('callout copy missing HEVC wording');
  if (!byLabel('.callout-warn button', /convert all/i)) throw new Error('no Convert all button');
  await waitFor(() => qa('.file-card').length === 2 && cardNames().every((n) => /\.mov|\.mp4/i.test(n)), {
    timeout: 20000,
    label: `2 video cards (got ${qa('.file-card').length}: ${JSON.stringify(cardNames())})`,
  });
});

await check('photos, music, documents and starred views filter correctly', async () => {
  const cases = [
    ['photos', /^photos/i, 2],
    ['music', /^music/i, 1],
    ['documents', /^documents/i, 1],
  ];
  for (const [path, re, expected] of cases) {
    click(byText('.nav-item', re), `${path} nav`);
    await waitFor(() => window.location.pathname === `/${path}`, { label: `/${path} route` });
    await waitFor(() => qa('.file-card').length === expected, { timeout: 15000, label: `${expected} cards in ${path}` });
  }
  click(byText('.nav-item', /^starred/i), 'Starred nav');
  await waitFor(() => window.location.pathname === '/starred', { label: '/starred route' });
  await waitFor(() => q('.empty'), { timeout: 15000, label: 'empty starred view' });
});

/* ── Preview + HEVC transcode ─────────────────────────────────────────── */
await check('opening the HEVC video offers server-side conversion', async () => {
  click(byText('.nav-item', /^videos/i), 'Videos nav');
  await waitFor(() => window.location.pathname === '/videos', { label: '/videos' });
  await waitFor(() => qa('.file-card').length === 2, { timeout: 20000, label: '2 video cards' });
  click(findCard(/IMG_0142\.HEVC\.mov/i), 'HEVC card');
  await waitFor(() => q('.preview-backdrop'), { timeout: 15000, label: 'preview overlay' });
  await waitFor(() => q('.hevc-banner'), { timeout: 20000, label: 'HEVC banner' });
  const banner = q('.hevc-banner').textContent;
  if (!/HEVC|H\.265/i.test(banner)) throw new Error('banner copy missing HEVC explanation');
  if (!byText('.hevc-banner button', /convert/i)) throw new Error('no Convert & play button');
  if (!/IMG_0142\.HEVC\.mov/.test(q('.preview-title').textContent)) throw new Error('preview title wrong');
});

let derivativeId = null;
await check('Convert & play runs a job and switches to the H.264 copy', async () => {
  click(byText('.hevc-banner button', /convert/i), 'Convert & play');
  await waitFor(() => T.useJobs.getState().jobs.some((j) => ['queued', 'running'].includes(j.status)), {
    timeout: 20000,
    label: 'transcode job to start',
  });
  await waitFor(() => q('.preview-video'), { timeout: 240000, interval: 500, label: 'playable <video> after transcode' });
  const src = q('.preview-video').getAttribute('src') || '';
  if (!/\/api\/files\//.test(src)) throw new Error(`unexpected video src: ${src}`);
  derivativeId = src.match(/\/api\/files\/([^/]+)\/stream/)?.[1];
  if (!derivativeId || derivativeId === seeded.hevc) throw new Error('player did not switch to the derivative');
  const chips = qa('.chip').map((c) => c.textContent.trim());
  if (!chips.some((c) => /H\.264 copy/i.test(c))) throw new Error(`no derivative switcher chips: ${chips.join(' | ')}`);
});

await check('details panel lists codecs, size and storage location', async () => {
  click(byLabel('.preview-actions button', /details/i), 'details toggle');
  await waitFor(() => q('.preview-side'), { timeout: 10000, label: '.preview-side' });
  const text = q('.preview-side').textContent;
  for (const needle of ['Type', 'Size', 'Video codec', 'Stored in']) {
    if (!text.includes(needle)) throw new Error(`details panel missing “${needle}”`);
  }
  if (!/hevc|hvc1|h264|avc1/i.test(text)) throw new Error(`expected a codec row, got: ${text.slice(0, 200)}`);
  if (!/Dimensions|Frame rate/.test(text)) throw new Error('expected probed video geometry in the details panel');
});

await check('Escape closes the preview', async () => {
  doc().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor(() => !q('.preview-backdrop'), { timeout: 8000, label: 'preview to close' });
});

/* ── Sharing ──────────────────────────────────────────────────────────── */
let shareUrl = null;
await check('file menu creates a public share link', async () => {
  click(byText('.nav-item', /^my drive/i), 'My Drive nav');
  await waitFor(() => window.location.pathname === '/drive', { label: '/drive' });
  await waitFor(
    () =>
      T.useDrive.getState().view === 'folder' &&
      !T.useDrive.getState().loading &&
      T.useDrive.getState().items.length >= 6 &&
      !!findCard(/clip-h264\.mp4/i),
    { timeout: 25000, label: 'settled drive view with clip-h264 card' },
  );
  const card = findCard(/clip-h264\.mp4/i);
  click(card.querySelector('.thumb-menu'), 'card menu button');
  await tick(120);
  await waitFor(() => q('.menu'), { timeout: 8000, label: 'context menu' });
  const labels = qa('.menu-item').map((i) => i.textContent.trim());
  for (const expected of ['Download', 'Copy share link', 'Rename', 'Move to Trash']) {
    if (!labels.some((l) => l.startsWith(expected))) throw new Error(`menu missing “${expected}”: ${labels.join(' | ')}`);
  }
  click(byLabel('.menu-item', /^share/i), 'Share…');
  await waitFor(() => q('.modal'), { timeout: 10000, label: 'share dialog' });
  click(byLabel('.modal button', /create link/i), 'Create link');
  await waitFor(() => /\/s\//.test(q('.modal').textContent), { timeout: 20000, label: 'link to render' });
  shareUrl = qa('.modal .mono').map((m) => m.textContent.trim()).find((t) => /\/s\//.test(t));
  if (!shareUrl) throw new Error('could not read the share URL');
  click(byLabel('.modal-foot button', /^done$/i), 'Done');
  await waitFor(() => !q('.modal'), { timeout: 8000, label: 'dialog to close' });
});

await check('public share page serves the file without auth', async () => {
  const tokenPath = shareUrl.split('/s/')[1];
  const meta = await fetch(`${BASE}/api/public/${tokenPath}`);
  if (!meta.ok) throw new Error(`GET /api/public/${tokenPath} → ${meta.status}`);
  const data = await meta.json();
  if (data.file?.name !== 'clip-h264.mp4') throw new Error(`wrong shared file: ${data.file?.name}`);
  const stream = await fetch(`${BASE}/api/public/${tokenPath}/stream`, { headers: { Range: 'bytes=0-1023' } });
  if (![200, 206].includes(stream.status)) throw new Error(`public stream → ${stream.status}`);
  const spa = await fetch(`${BASE}/s/${tokenPath}`);
  if (!spa.ok) throw new Error(`SPA route /s/:token → ${spa.status}`);
  if (!/<div id="root">/.test(await spa.text())) throw new Error('SPA fallback did not return index.html');
});

await check('shared links page lists the link with stats', async () => {
  click(byText('.nav-item', /^shared/i), 'Shared nav');
  await waitFor(() => window.location.pathname === '/shared', { label: '/shared' });
  await waitFor(() => qa('.list-row').length >= 1, { timeout: 15000, label: 'share rows' });
  const row = qa('.list-row')[0];
  if (!/clip-h264\.mp4/.test(row.textContent)) throw new Error(`wrong row content: ${row.textContent.slice(0, 140)}`);
  if (!/no expiry/i.test(row.textContent)) throw new Error('expiry not shown');
});

/* ── Library operations ───────────────────────────────────────────────── */
await check('selection bar trashes a file and trash restores it', async () => {
  click(byText('.nav-item', /^my drive/i), 'My Drive');
  await waitFor(
    () => T.useDrive.getState().view === 'folder' && !T.useDrive.getState().loading && qa('.file-card').length >= 6,
    { timeout: 25000, label: 'settled drive with 6 cards' },
  );
  click(findCard(/notes\.txt/i).querySelector('.thumb-check'), 'card checkbox');
  await waitFor(() => q('.selection-bar'), { timeout: 8000, label: '.selection-bar' });
  if (!/1 selected/.test(q('.selection-bar').textContent)) throw new Error('selection count wrong');
  click(byLabel('.selection-bar button', /trash/i), 'trash action');
  await waitFor(() => !/notes\.txt/.test(q('.content-narrow')?.textContent || ''), { timeout: 15000, label: 'file to leave the drive' });

  click(byText('.nav-item', /^trash/i), 'Trash nav');
  await waitFor(() => window.location.pathname === '/trash', { label: '/trash' });
  await waitFor(() => /notes\.txt/.test(doc().body.textContent), { timeout: 15000, label: 'file in trash' });
  click(findCard(/notes\.txt/i).querySelector('.thumb-menu'), 'trashed card menu');
  await waitFor(() => byText('.menu-item', /^restore/i), { timeout: 8000, label: 'Restore item' });
  click(byLabel('.menu-item', /^restore/i), 'Restore');
  await waitFor(() => !/notes\.txt/.test(doc().body.textContent), { timeout: 15000, label: 'file to leave trash' });
});

await check('rename dialog updates the file name', async () => {
  click(byText('.nav-item', /^my drive/i), 'My Drive');
  await waitFor(() => qa('.file-card').length >= 6, { label: 'cards' });
  T.useDrive.getState().clearSelection();
  click(findCard(/notes\.txt/i).querySelector('.thumb-menu'), 'card menu');
  await waitFor(() => q('.menu'), { label: 'menu' });
  click(byLabel('.menu-item', /^rename/i), 'Rename');
  await waitFor(() => q('#rename-input'), { timeout: 8000, label: 'rename input' });
  setValue(q('#rename-input'), 'packing-list.txt');
  click(byLabel('.modal-foot button', /^save$/i), 'Save');
  await waitFor(() => /packing-list\.txt/.test(doc().body.textContent), { timeout: 15000, label: 'renamed file' });
});

await check('new folder dialog creates a folder and navigation enters it', async () => {
  T.useDrive.getState().clearSelection();
  click(byLabel('.page-head button', /new folder/i), 'New folder');
  await waitFor(() => q('#new-folder-name'), { timeout: 8000, label: 'folder dialog' });
  setValue(q('#new-folder-name'), 'Vacation 2026');
  click(byLabel('.modal-foot button', /^create$/i), 'Create');
  await waitFor(() => /\/drive\/f\//.test(window.location.pathname), { timeout: 15000, label: 'navigate into the folder' });
  await waitFor(() => /Vacation 2026/.test(q('.crumbs')?.textContent || ''), { timeout: 10000, label: 'breadcrumb' });
});

await check('search view finds files by name', async () => {
  setValue(q('#global-search'), 'clip');
  await waitFor(() => window.location.pathname === '/search', { timeout: 15000, label: '/search route' });
  await waitFor(() => qa('.file-card').length >= 1, { timeout: 15000, label: 'search results' });
  if (!/clip-h264\.mp4/.test(doc().body.textContent)) throw new Error('search missed the clip');
  if (!/Results for “clip”/.test(doc().body.textContent)) throw new Error('search heading wrong');
});

/* ── Settings ─────────────────────────────────────────────────────────── */
await check('settings page reports storage, media pipeline and library stats', async () => {
  window.history.pushState({}, '', '/settings');
  click(byLabel('.sidebar-foot .nav-item', /settings|abdul/i) || q('.sidebar-foot .nav-item'), 'Settings link');
  await waitFor(() => window.location.pathname === '/settings', { timeout: 15000, label: '/settings route' });
  await waitFor(() => q('.settings-grid'), { timeout: 15000, label: '.settings-grid' });
  await waitFor(() => /ffmpeg/i.test(doc().body.textContent), { timeout: 20000, label: 'capabilities' });
  const text = doc().body.textContent;
  for (const needle of [
    'Where your files live',
    'Media pipeline',
    'HEVC → H.264',
    'Your library',
    'Defaults & appearance',
    'Change password',
    'Keyboard shortcuts',
  ]) {
    if (!text.includes(needle)) throw new Error(`settings missing “${needle}”`);
  }
  if (!qa('.stat').length) throw new Error('library stats not rendered');
  if (!/Ready|Enabled/.test(text)) throw new Error('capability badges not rendered');
});

await check('connect-Telegram dialog renders the wizard', async () => {
  click(byLabel('.panel button', /connect telegram/i), 'Connect Telegram');
  await waitFor(() => q('.modal'), { timeout: 8000, label: 'telegram dialog' });
  await waitFor(() => /api_id/.test(q('.modal')?.textContent || ''), { timeout: 20000, label: 'wizard form' });
  const text = q('.modal').textContent;
  if (!/api_id/.test(text) || !/my\.telegram\.org/.test(text)) throw new Error('wizard missing api_id guidance');
  if (!q('#tg-phone')) throw new Error('no phone field');
  click(byLabel('.modal-foot button', /^close$/i), 'Close');
  await waitFor(() => !q('.modal'), { timeout: 8000, label: 'dialog to close' });
});

await check('theme and view preferences persist to the profile', async () => {
  const before = doc().documentElement.dataset.theme;
  click(byLabel('.setting-row .segmented button', /light/i), 'Light theme');
  await waitFor(() => doc().documentElement.dataset.theme === 'light', { timeout: 8000, label: 'theme switch' });
  await waitFor(
    async () => {
      const me = await (await fetch(`${BASE}/api/auth/me`, { headers: authHeaders(token) })).json();
      return me.user?.settings?.theme === 'light';
    },
    { timeout: 15000, label: 'theme to persist to the profile' },
  );
  click(byLabel('.setting-row .segmented button', /dark/i), 'Dark theme');
  await waitFor(() => doc().documentElement.dataset.theme === (before || 'dark'), { timeout: 8000, label: 'theme restore' });

  click(byLabel('.setting-row .segmented button', /list/i), 'List view');
  await waitFor(() => T.useAuth.getState().user?.settings?.view === 'list', { timeout: 8000, label: 'view setting' });
  click(byLabel('.setting-row .segmented button', /grid/i), 'Grid view');
  await waitFor(() => T.useAuth.getState().user?.settings?.view === 'grid', { timeout: 8000, label: 'view setting back' });
});

await check('list view renders sortable columns', async () => {
  click(byText('.nav-item', /^my drive/i), 'My Drive');
  await waitFor(() => window.location.pathname === '/drive', { label: '/drive' });
  click(byLabel('.segmented button', /list view/i), 'list toggle');
  await waitFor(() => q('.list-row'), { timeout: 15000, label: '.list-row' });
  if (!q('.list-head')) throw new Error('list header missing');
  const headText = q('.list-head').textContent;
  if (!/Name/i.test(headText) || !/Size/i.test(headText)) throw new Error(`list header wrong: ${headText}`);
  click(byLabel('.list-head button', /^size/i), 'sort by size');
  await waitFor(() => T.useDrive.getState().sort === 'size', { timeout: 8000, label: 'sort=size' });
  click(byLabel('.segmented button', /grid view/i), 'grid toggle');
  await waitFor(() => q('.file-card'), { timeout: 10000, label: 'back to grid' });
});

await check('sign out returns to the login page', async () => {
  click(q('.avatar'), 'avatar menu');
  await waitFor(() => q('.menu'), { timeout: 8000, label: 'account menu' });
  const labels = qa('.menu-item').map((i) => i.textContent.trim());
  if (!labels.some((l) => /settings/i.test(l))) throw new Error(`account menu missing Settings: ${labels.join(' | ')}`);
  click(byLabel('.menu-item', /sign out/i), 'Sign out');
  await waitFor(() => window.location.pathname === '/login', { timeout: 15000, label: '/login after sign out' });
  await waitFor(() => q('#auth-email'), { timeout: 10000, label: 'login form' });
  if (window.localStorage.getItem('tgc_token')) throw new Error('token not cleared on sign out');
});

/* ── Report ───────────────────────────────────────────────────────────── */
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log('\n──────────────────────────────────────────────────────────────────────');
console.log(`${passed}/${results.length} UI checks passed${failed ? ` — ${failed} FAILED` : ''}`);

const realErrors = consoleErrors.filter((e) => !/Warning: An update to|not wrapped in act/i.test(e));
if (realErrors.length) {
  console.log(`\n⚠ ${realErrors.length} console/page error(s):`);
  for (const e of [...new Set(realErrors)].slice(0, 25)) console.log(`  - ${e}`);
} else {
  console.log('✓ No console errors or React warnings.');
}

root.unmount();
window.close();
fs.rmSync(WORK, { recursive: true, force: true });
process.exit(failed || realErrors.length ? 1 : 0);
