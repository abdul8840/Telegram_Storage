#!/usr/bin/env node
/**
 * End-to-end smoke test for the ZoZoCloud API.
 *
 * Exercises the full lifecycle against a running server: signup → folders →
 * resumable chunked upload of an iPhone-style HEVC .mov → processing →
 * range-request streaming (video seeking) → thumbnails → HEVC→H.264 transcode
 * → one-shot upload → share links (public + password) → rename/move/star →
 * trash/restore → permanent delete, while listening to the SSE event stream.
 *
 *   node scripts/smoke-test.mjs [--base-url http://127.0.0.1:5000] [--keep]
 *
 * Fixtures are generated on the fly with ffmpeg when available.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argValue('base-url', process.env.BASE_URL || 'http://127.0.0.1:5000').replace(/\/+$/, '');
const KEEP = args.includes('--keep');

let passed = 0;
let failed = 0;
const failures = [];

const c = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[90m', x: '\x1b[0m' };
const ok = (label, extra = '') => {
  passed += 1;
  console.log(`${c.g}  ✔${c.x} ${label}${extra ? ` ${c.d}${extra}${c.x}` : ''}`);
};
const bad = (label, detail) => {
  failed += 1;
  failures.push(`${label}: ${detail}`);
  console.log(`${c.r}  ✘ ${label}${c.x} ${c.d}${String(detail).slice(0, 300)}${c.x}`);
};
const step = (label) => console.log(`\n${c.b}▸ ${label}${c.x}`);
const check = (label, condition, detail = '') => (condition ? ok(label, detail) : bad(label, detail || 'condition false'));

// ── fixtures ───────────────────────────────────────────────────────────────

function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const req = createRequire(path.join(ROOT, 'server', 'package.json'));
    const mod = req('@ffmpeg-installer/ffmpeg');
    if (mod?.path && fs.existsSync(mod.path)) return mod.path;
  } catch {
    /* not installed */
  }
  const which = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  return which.status === 0 ? which.stdout.trim() : null;
}

async function makeFixtures(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const ffmpeg = findFfmpeg();
  const out = {
    hevcMov: path.join(dir, 'iphone-hevc.mov'),
    h264Mp4: path.join(dir, 'clip-h264.mp4'),
    png: path.join(dir, 'photo.png'),
    text: path.join(dir, 'notes.txt'),
  };
  if (!ffmpeg) {
    console.log(`${c.y}  ! ffmpeg not found — using a synthetic payload instead of real media${c.x}`);
    await fsp.writeFile(out.hevcMov, Buffer.alloc(3 * 1024 * 1024, 7));
    await fsp.writeFile(out.h264Mp4, Buffer.alloc(1024 * 1024, 3));
    await fsp.writeFile(out.png, Buffer.alloc(64 * 1024, 9));
  } else {
    const run = (a) => spawnSync(ffmpeg, ['-nostdin', '-y', ...a], { stdio: ['ignore', 'ignore', 'pipe'] });
    // iPhone "High Efficiency" recording: HEVC (hvc1) in a QuickTime container.
    // A target bitrate is set so the fixture is several MB — big enough to
    // exercise a genuinely multi-chunk, resumable upload.
    run([
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=520:duration=6',
      '-c:v', 'libx265', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-b:v', '10M', '-maxrate', '12M',
      '-c:a', 'aac', '-shortest', out.hevcMov,
    ]);
    run([
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out.h264Mp4,
    ]);
    run(['-f', 'lavfi', '-i', 'testsrc2=size=800x600:rate=1:duration=1', '-frames:v', '1', out.png]);
  }
  await fsp.writeFile(out.text, 'ZoZoCloud smoke test\n'.repeat(200));
  return out;
}

// ── http helpers ───────────────────────────────────────────────────────────

let token = null;
async function api(method, urlPath, { body, headers = {}, raw = false, query = {} } = {}) {
  const qs = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString();
  const url = `${BASE}${urlPath}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...(raw ? { 'Content-Type': 'application/octet-stream' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  // JSON → object, text/* → string, anything else (jpeg, mp4, mov…) → Buffer
  let data;
  if (type.includes('application/json')) data = await res.json();
  else if (type.startsWith('text/') || type.includes('xml') || type.includes('event-stream')) data = await res.text();
  else data = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, data };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 120000, intervalMs = 700, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await wait(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (last: ${JSON.stringify(last).slice(0, 200)})` : ''}`);
}

async function chunkedUpload(filePath, { folderId = null, chunkSize = 2 * 1024 * 1024 } = {}) {
  const name = path.basename(filePath);
  const size = (await fsp.stat(filePath)).size;
  const created = await api('POST', '/api/uploads', { body: { name, size, folderId, mime: 'application/octet-stream' } });
  if (created.status !== 201) throw new Error(`create session failed: ${created.status} ${JSON.stringify(created.data)}`);
  const { uploadId } = created.data;
  const fd = await fsp.open(filePath, 'r');
  try {
    for (let index = 0; index < created.data.totalChunks; index += 1) {
      const start = index * created.data.chunkSize;
      const end = Math.min(start + created.data.chunkSize, size);
      const buf = Buffer.alloc(end - start);
      await fd.read(buf, 0, buf.length, start);
      const put = await api('PUT', `/api/uploads/${uploadId}/chunks/${index}`, { body: buf, raw: true });
      if (put.status !== 200) throw new Error(`chunk ${index} failed: ${put.status} ${JSON.stringify(put.data)}`);
    }
  } finally {
    await fd.close();
  }
  const complete = await api('POST', `/api/uploads/${uploadId}/complete`);
  if (![200, 201].includes(complete.status)) throw new Error(`complete failed: ${complete.status} ${JSON.stringify(complete.data)}`);
  return { uploadId, fileId: complete.data.fileId, totalChunks: created.data.totalChunks };
}

async function waitFileReady(fileId, { timeoutMs = 120000 } = {}) {
  return waitFor(
    async () => {
      const r = await api('GET', `/api/files/${fileId}`);
      if (r.status !== 200) return null;
      if (r.data.status === 'failed') throw new Error(`processing failed: ${r.data.error}`);
      return r.data.status === 'ready' ? r.data : null;
    },
    { timeoutMs, label: `file ${fileId} to become ready` },
  );
}

// ── SSE listener ───────────────────────────────────────────────────────────

function listenToEvents(onEvent) {
  const controller = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${BASE}/api/events?access_token=${encodeURIComponent(token)}`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const event = /^event:\s*(.+)$/m.exec(frame)?.[1];
          const dataLine = /^data:\s*(.+)$/m.exec(frame)?.[1];
          if (!event || !dataLine) continue;
          try {
            onEvent(event, JSON.parse(dataLine));
          } catch {
            /* ignore malformed frame */
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') console.log(`${c.d}    (sse closed: ${err.message})${c.x}`);
    }
  })();
  return () => controller.abort();
}

// ── the test ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`${c.b}ZoZoCloud — end-to-end smoke test${c.x}`);
  console.log(`${c.d}target: ${BASE}${c.x}`);

  step('health');
  const health = await fetch(`${BASE}/healthz`).then((r) => r.json()).catch((e) => ({ error: e.message }));
  check('server is up', health?.ok === true, JSON.stringify(health?.database || health?.error || ''));

  const fixtures = await makeFixtures(path.join(os.tmpdir(), 'tgc-fixtures'));
  const hevcSize = (await fsp.stat(fixtures.hevcMov)).size;
  console.log(`${c.d}  fixtures: hevc .mov ${(hevcSize / 1024 / 1024).toFixed(2)} MB${c.x}`);

  step('account');
  const email = `smoke+${Date.now()}@example.com`;
  const password = 'smoke-test-password';
  const signup = await api('POST', '/api/auth/signup', { body: { name: 'Smoke Tester', email, password } });
  check('signup returns 201 + token', signup.status === 201 && !!signup.data.token, `status=${signup.status}`);
  if (signup.status !== 201) throw new Error('cannot continue without an account');
  token = signup.data.token;
  check('password hash never leaves the server', signup.data.user.passwordHash === undefined);
  const dup = await api('POST', '/api/auth/signup', { body: { name: 'Dup', email, password } });
  check('duplicate email rejected with 409', dup.status === 409, `status=${dup.status}`);
  const login = await api('POST', '/api/auth/login', { body: { email, password } });
  check('login works', login.status === 200 && !!login.data.token, `status=${login.status}`);
  const wrong = await api('POST', '/api/auth/login', { body: { email, password: 'nope-nope' } });
  check('wrong password rejected with 401', wrong.status === 401, `status=${wrong.status}`);
  const me = await api('GET', '/api/auth/me');
  check('GET /auth/me returns the profile', me.status === 200 && me.data.user?.email === email);
  const savedOwnerToken = token;
  token = null;
  const unauth = await api('GET', '/api/files');
  check('protected routes require auth (401)', unauth.status === 401, `status=${unauth.status}`);
  token = savedOwnerToken;

  step('capabilities');
  const caps = await api('GET', '/api/meta/capabilities');
  check('capabilities reported', caps.status === 200, `ffmpeg=${caps.data?.media?.ffmpeg} transcode=${caps.data?.media?.transcode}`);
  check('storage backend reported', ['local', 'telegram'].includes(caps.data?.storage?.active), caps.data?.storage?.active);

  step('SSE event stream');
  const events = [];
  const stopEvents = listenToEvents((event, data) => events.push({ event, data }));
  await wait(600);
  check('SSE connection established', events.some((e) => e.event === 'connected'), `${events.length} frame(s)`);

  step('folders');
  const folder = await api('POST', '/api/folders', { body: { name: 'Videos' } });
  check('create folder', folder.status === 201 && !!folder.data._id, folder.data?.name);
  const subFolder = await api('POST', '/api/folders', { body: { name: 'iPhone', parentId: folder.data._id } });
  check('create nested folder', subFolder.status === 201, subFolder.data?.name);
  const dupFolder = await api('POST', '/api/folders', { body: { name: 'videos' } });
  check('duplicate folder name rejected (409)', dupFolder.status === 409, `status=${dupFolder.status}`);
  const tree = await api('GET', '/api/folders');
  check('folder tree returns nested children', tree.data?.tree?.[0]?.children?.length === 1, JSON.stringify(tree.data?.tree?.map((t) => t.path)));

  step('chunked resumable upload (HEVC .mov)');
  const created = await api('POST', '/api/uploads', {
    body: { name: 'iphone-hevc.mov', size: hevcSize, folderId: subFolder.data._id, chunkSize: 2 * 1024 * 1024 },
  });
  check('upload session created', created.status === 201 && created.data.totalChunks > 1, `${created.data?.totalChunks} chunks of ${created.data?.chunkSize}`);
  const uploadId = created.data.uploadId;

  const fd = await fsp.open(fixtures.hevcMov, 'r');
  const firstChunk = Buffer.alloc(Math.min(created.data.chunkSize, hevcSize));
  await fd.read(firstChunk, 0, firstChunk.length, 0);
  const put0 = await api('PUT', `/api/uploads/${uploadId}/chunks/0`, { body: firstChunk, raw: true });
  check('chunk 0 accepted', put0.status === 200 && put0.data.bytes === firstChunk.length, `${put0.data?.bytes} bytes`);
  const badIndex = await api('PUT', `/api/uploads/${uploadId}/chunks/999`, { body: Buffer.alloc(16), raw: true });
  check('out-of-range chunk rejected (400)', badIndex.status === 400, `status=${badIndex.status}`);
  const state = await api('GET', `/api/uploads/${uploadId}`);
  check('resume state reports received chunks', state.data?.receivedChunks?.includes(0), JSON.stringify(state.data?.receivedChunks));
  const earlyComplete = await api('POST', `/api/uploads/${uploadId}/complete`);
  check('incomplete upload cannot complete (400)', earlyComplete.status === 400, `status=${earlyComplete.status}`);

  for (let index = 1; index < created.data.totalChunks; index += 1) {
    const start = index * created.data.chunkSize;
    const end = Math.min(start + created.data.chunkSize, hevcSize);
    const buf = Buffer.alloc(end - start);
    await fd.read(buf, 0, buf.length, start);
    const put = await api('PUT', `/api/uploads/${uploadId}/chunks/${index}`, { body: buf, raw: true });
    if (put.status !== 200) {
      bad(`chunk ${index}`, `status=${put.status}`);
      break;
    }
  }
  await fd.close();
  ok(`all ${created.data.totalChunks} chunks uploaded`);

  const complete = await api('POST', `/api/uploads/${uploadId}/complete`);
  check('complete returns a file id', complete.status === 200 && !!complete.data.fileId, complete.data?.fileId);
  const fileId = complete.data.fileId;

  const ready = await waitFileReady(fileId, { timeoutMs: 90000 });
  check('file processed to "ready"', ready.status === 'ready', `provider=${ready.provider} size=${ready.size}`);
  check('size preserved exactly', ready.size === hevcSize, `${ready.size} vs ${hevcSize}`);
  check('HEVC detected by the media probe', ready.hevc === true || ready.media?.vcodec === 'hevc', `vcodec=${ready.media?.vcodec} tag=${ready.media?.codecTag}`);
  check('video dimensions probed', !!ready.media?.width && !!ready.media?.height, `${ready.media?.width}x${ready.media?.height}`);
  check('duration probed', ready.media?.duration > 1, `${ready.media?.duration?.toFixed?.(2)}s`);
  check('flagged as needing transcode for browsers', ready.needsTranscode === true, `previewKind=${ready.previewKind}`);
  check('thumbnail generated', ready.hasThumb === true && !!ready.thumbUrl, ready.thumb?.width ? `${ready.thumb.width}x${ready.thumb.height}` : '');
  check('blur-up placeholder (LQIP) generated', typeof ready.lqip === 'string' && ready.lqip.startsWith('data:image/jpeg;base64,'), `${(ready.lqip || '').length} chars`);
  check('stored in the nested folder', ready.folderId === subFolder.data._id);
  check('SSE reported file:ready', events.some((e) => e.event === 'file:ready' && e.data?.file?.id === fileId), `${events.filter((e) => e.event.startsWith('file:')).length} file event(s)`);
  check('SSE streamed progress updates', events.filter((e) => e.event === 'file:progress').length > 0, `${events.filter((e) => e.event === 'file:progress').length} tick(s)`);

  step('thumbnail bytes');
  const thumb = await api('GET', `/api/files/${fileId}/thumbnail`);
  check('thumbnail is a JPEG', thumb.status === 200 && thumb.data.subarray(0, 3).toString('hex') === 'ffd8ff', `${thumb.data.length} bytes`);
  const thumbCached = await api('GET', `/api/files/${fileId}/thumbnail`, { headers: { 'If-None-Match': thumb.headers.get('etag') } });
  check('thumbnail honours ETag (304)', thumbCached.status === 304, `status=${thumbCached.status}`);

  step('range streaming (video seeking)');
  const full = await api('GET', `/api/files/${fileId}/stream`);
  check('full stream returns 200 with exact length', full.status === 200 && full.data.length === hevcSize, `${full.data.length} bytes`);
  check('Accept-Ranges advertised', full.headers.get('accept-ranges') === 'bytes');
  check('.mov HEVC served as video/mp4 for browser playback', full.headers.get('content-type') === 'video/mp4', full.headers.get('content-type'));
  const etag = full.headers.get('etag');

  const r1 = await api('GET', `/api/files/${fileId}/stream`, { headers: { Range: 'bytes=0-1023' } });
  check('first 1 KB range → 206', r1.status === 206 && r1.data.length === 1024, `${r1.data.length} bytes`);
  check('Content-Range header correct', r1.headers.get('content-range') === `bytes 0-1023/${hevcSize}`, r1.headers.get('content-range'));

  const seekTo = Math.floor(hevcSize * 0.6);
  const r2 = await api('GET', `/api/files/${fileId}/stream`, { headers: { Range: `bytes=${seekTo}-${seekTo + 4095}` } });
  check('mid-file seek range → 206 with right bytes', r2.status === 206 && r2.data.length === 4096, `offset ${seekTo}`);
  check('seeked bytes match the full download', r2.data.equals(full.data.subarray(seekTo, seekTo + 4096)));

  const r3 = await api('GET', `/api/files/${fileId}/stream`, { headers: { Range: `bytes=${hevcSize - 512}-` } });
  check('open-ended tail range → 206', r3.status === 206 && r3.data.length === 512, `${r3.data.length} bytes`);

  const r4 = await api('GET', `/api/files/${fileId}/stream`, { headers: { Range: `bytes=${hevcSize + 100}-${hevcSize + 500}` } });
  check('unsatisfiable range → 416', r4.status === 416, `status=${r4.status}`);

  const head = await api('HEAD', `/api/files/${fileId}/stream`);
  check('HEAD returns length without a body', head.status === 200 && head.headers.get('content-length') === String(hevcSize), head.headers.get('content-length'));
  const notModified = await api('GET', `/api/files/${fileId}/stream`, { headers: { 'If-None-Match': etag } });
  check('conditional GET → 304 (player resume)', notModified.status === 304, `status=${notModified.status}`);

  const dl = await api('GET', `/api/files/${fileId}/download`);
  check('download sets attachment disposition', /attachment/.test(dl.headers.get('content-disposition') || ''), dl.headers.get('content-disposition')?.slice(0, 60));

  step('library queries');
  const listAll = await api('GET', '/api/files', { query: { view: 'all', limit: 50 } });
  check('view=all lists the file', listAll.data.items.some((f) => f.id === fileId), `${listAll.data.total} total`);
  const listVideos = await api('GET', '/api/files', { query: { view: 'videos' } });
  check('view=videos filters by kind', listVideos.data.items.every((f) => f.kind === 'video') && listVideos.data.items.length >= 1, `${listVideos.data.items.length} video(s)`);
  const listFolder = await api('GET', '/api/files', { query: { folderId: subFolder.data._id } });
  check('folder listing scopes to that folder', listFolder.data.items.length === 1, `${listFolder.data.items.length} item(s)`);
  const search = await api('GET', '/api/files', { query: { view: 'search', q: 'iphone-hevc' } });
  check('search finds the file by name', search.data.items.some((f) => f.id === fileId), `${search.data.total} hit(s)`);
  const searchMiss = await api('GET', '/api/files', { query: { view: 'search', q: 'zzz-no-such-file' } });
  check('search with no match returns empty', searchMiss.data.total === 0);
  const sorted = await api('GET', '/api/files', { query: { view: 'all', sort: 'name', order: 'asc', limit: 5 } });
  check('sorting works', sorted.status === 200, sorted.data.items.map((f) => f.name).join(', '));

  step('HEVC → H.264 transcode');
  const transcode = await api('POST', `/api/files/${fileId}/transcode`, { body: { maxDimension: 1280 } });
  check('transcode job accepted (202)', transcode.status === 202 && !!transcode.data.job?._id, transcode.data?.job?.status);
  if (caps.data?.media?.transcode) {
    const jobId = transcode.data.job._id;
    const job = await waitFor(
      async () => {
        const r = await api('GET', `/api/jobs/${jobId}`);
        return ['done', 'failed', 'cancelled'].includes(r.data?.status) ? r.data : null;
      },
      { timeoutMs: 180000, label: 'transcode job' },
    );
    check('transcode job finished successfully', job.status === 'done', job.error || `${job.output?.name} ${(job.output?.size / 1024 / 1024).toFixed(2)} MB`);
    check('SSE pushed transcode progress', events.some((e) => e.event === 'job:progress' && e.data?.jobId === jobId), `${events.filter((e) => e.event === 'job:progress').length} tick(s)`);
    if (job.status === 'done') {
      const derived = await waitFileReady(job.output.fileId, { timeoutMs: 90000 });
      check('transcoded copy is playable in browsers', derived.previewKind === 'video' && derived.needsTranscode === false, `vcodec=${derived.media?.vcodec}`);
      check('transcoded copy is H.264/AAC MP4', derived.media?.vcodec === 'h264' && derived.media?.acodec === 'aac', `${derived.media?.vcodec}/${derived.media?.acodec}`);
      check('transcoded copy linked to the original', derived.derivedFrom === fileId, derived.derivedFrom);
      const original = await api('GET', `/api/files/${fileId}`);
      check('original still lists its derivative', (original.data.derivatives || []).includes(derived.id), JSON.stringify(original.data.derivatives));
      const dStream = await api('GET', `/api/files/${derived.id}/stream`, { headers: { Range: 'bytes=0-3' } });
      check('transcoded file streams with ranges too', dStream.status === 206 && dStream.data.length === 4);
      // faststart: moov must appear near the beginning for instant seeking
      const head = await api('GET', `/api/files/${derived.id}/stream`, { headers: { Range: 'bytes=0-4095' } });
      const headStr = head.data.toString('latin1');
      check('faststart: moov atom before mdat', headStr.indexOf('moov') > -1 && (headStr.indexOf('mdat') === -1 || headStr.indexOf('moov') < headStr.indexOf('mdat')));
      await api('DELETE', '/api/files', { body: { fileIds: [derived.id] } });
    }
  } else {
    console.log(`${c.y}    (skipped — ffmpeg/transcode unavailable on this server)${c.x}`);
  }

  step('one-shot upload (small file)');
  const pngBytes = await fsp.readFile(fixtures.png);
  const simple = await api('POST', '/api/uploads/simple', { body: pngBytes, raw: true, query: { name: 'photo.png' } });
  check('simple upload accepted (202)', simple.status === 202 && !!simple.data.fileId, simple.data?.status);
  const png = await waitFileReady(simple.data.fileId, { timeoutMs: 60000 });
  check('image classified and thumbnailed', png.kind === 'image' && png.hasThumb === true, `${png.media?.width}x${png.media?.height}`);
  const pngStream = await api('GET', `/api/files/${png.id}/stream`);
  check('image bytes round-trip exactly', pngStream.data.equals(pngBytes), `${pngStream.data.length} bytes`);
  check('image previewKind is "image"', png.previewKind === 'image', png.previewKind);

  step('text preview');
  const textUpload = await api('POST', '/api/uploads/simple', { body: await fsp.readFile(fixtures.text), raw: true, query: { name: 'notes.txt' } });
  const textFile = await waitFileReady(textUpload.data.fileId, { timeoutMs: 60000 });
  check('text file previewable', textFile.previewKind === 'text', textFile.previewKind);
  const textBody = await api('GET', `/api/files/${textFile.id}/text`);
  check('text preview returns content', textBody.status === 200 && textBody.data.content?.includes('smoke test'), `${(textBody.data?.content || '').length} chars`);

  step('rename / move / star');
  const renamed = await api('PATCH', `/api/files/${fileId}`, { body: { name: 'Holiday-clip.mov' } });
  check('rename works', renamed.data?.name === 'Holiday-clip.mov', renamed.data?.name);
  check('extension recomputed on rename', renamed.data?.ext === 'mov');
  const moved = await api('POST', '/api/files/move', { body: { fileIds: [fileId, png.id], folderId: folder.data._id } });
  check('bulk move works', moved.data?.moved === 2, `${moved.data?.moved} moved`);
  const starred = await api('POST', '/api/files/star', { body: { fileIds: [fileId], starred: true } });
  check('star works', starred.data?.files?.[0]?.starred === true);
  const starredList = await api('GET', '/api/files', { query: { view: 'starred' } });
  check('starred view lists it', starredList.data.items.some((f) => f.id === fileId), `${starredList.data.total} starred`);

  step('share links');
  const share = await api('POST', '/api/shares', { body: { fileId, expiresInDays: 7 } });
  check('share link created', share.status === 201 && !!share.data.share?.token, share.data?.share?.url);
  const shareToken = share.data.share.token;
  const savedToken = token;
  token = null;
  const publicMeta = await api('GET', `/api/public/${shareToken}`);
  check('public metadata without auth', publicMeta.status === 200 && publicMeta.data.file?.name === 'Holiday-clip.mov', publicMeta.data?.file?.name);
  const publicStream = await api('GET', `/api/public/${shareToken}/stream`, { headers: { Range: 'bytes=0-99' } });
  check('public range stream works (206)', publicStream.status === 206 && publicStream.data.length === 100, `${publicStream.data.length} bytes`);
  const publicThumb = await api('GET', `/api/public/${shareToken}/thumbnail`);
  check('public thumbnail works', publicThumb.status === 200, `${publicThumb.data.length} bytes`);

  const pwShare = await api('POST', '/api/shares', { body: { fileId: png.id, password: 'letmein' } });
  // needs the owner token again
  token = savedToken;
  const pwShare2 = pwShare.status === 201 ? pwShare : await api('POST', '/api/shares', { body: { fileId: png.id, password: 'letmein' } });
  const pwToken = pwShare2.data?.share?.token;
  token = null;
  const locked = await api('GET', `/api/public/${pwToken}`);
  check('password-protected link is locked (401)', locked.status === 401 && locked.data.code === 'PASSWORD_REQUIRED', `status=${locked.status}`);
  const wrongPw = await api('POST', `/api/public/${pwToken}/unlock`, { body: { password: 'wrong' } });
  check('wrong share password rejected (401)', wrongPw.status === 401, `status=${wrongPw.status}`);
  const unlocked = await api('POST', `/api/public/${pwToken}/unlock`, { body: { password: 'letmein' } });
  check('correct share password unlocks', unlocked.status === 200 && !!unlocked.data.file?.id, unlocked.data?.file?.name);

  token = savedToken;
  const revoked = await api('DELETE', `/api/shares/${shareToken}`);
  check('share can be revoked', revoked.data?.ok === true);
  token = null;
  const afterRevoke = await api('GET', `/api/public/${shareToken}`);
  check('revoked link returns 404', afterRevoke.status === 404, `status=${afterRevoke.status}`);
  token = savedToken;

  step('trash / restore / delete');
  const trashed = await api('POST', '/api/files/trash', { body: { fileIds: [png.id] } });
  check('move to trash', trashed.data?.trashed === 1, `${trashed.data?.trashed} trashed`);
  const trashList = await api('GET', '/api/files', { query: { view: 'trash' } });
  check('trash view lists it', trashList.data.items.some((f) => f.id === png.id), `${trashList.data.total} in trash`);
  const goneFromAll = await api('GET', '/api/files', { query: { view: 'all', limit: 100 } });
  check('trashed file hidden from the library', !goneFromAll.data.items.some((f) => f.id === png.id));
  const restored = await api('POST', '/api/files/restore', { body: { fileIds: [png.id] } });
  check('restore works', restored.data?.restored === 1);
  const deleted = await api('DELETE', '/api/files', { body: { fileIds: [png.id] } });
  check('permanent delete', deleted.data?.deleted === 1, JSON.stringify(deleted.data));
  const afterDelete = await api('GET', `/api/files/${png.id}`);
  check('deleted file is gone (404)', afterDelete.status === 404, `status=${afterDelete.status}`);

  step('stats');
  const stats = await api('GET', '/api/files/stats');
  check('stats aggregate correctly', stats.data?.files >= 2 && stats.data?.totalSize > 0, `${stats.data?.files} files, ${(stats.data?.totalSize / 1024 / 1024).toFixed(2)} MB, ${stats.data?.hevcCount} HEVC`);
  check('stats break down by kind', !!stats.data?.byKind?.video, JSON.stringify(Object.keys(stats.data?.byKind || {})));
  check('stats break down by provider', !!stats.data?.byProvider, JSON.stringify(stats.data?.byProvider));

  step('empty trash + cleanup');
  await api('POST', '/api/files/trash', { body: { fileIds: [fileId, textFile.id] } });
  const emptied = await api('POST', '/api/files/trash/empty');
  check('empty trash removes everything', emptied.status === 200, `${emptied.data?.deleted} deleted`);
  const finalStats = await api('GET', '/api/files/stats');
  check('library is empty afterwards', finalStats.data.files === 0, `${finalStats.data.files} file(s) left`);

  stopEvents();
  check('SSE delivered events for the whole session', events.length > 10, `${events.length} event(s) received`);

  if (!KEEP) {
    const del = await api('DELETE', '/api/auth/me');
    check('account deletion cleans up', del.status === 200, `${del.data?.deletedFiles} file(s) removed`);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${passed} passed${failed ? `, ${c.r}${failed} failed${c.x}` : ''}  ${c.d}(${BASE})${c.x}`);
  if (failed) {
    console.log(`\n${c.r}Failures:${c.x}`);
    failures.forEach((f) => console.log(`  • ${f}`));
    process.exit(1);
  }
  console.log(`${c.g}All checks passed ✔${c.x}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n${c.r}Smoke test crashed:${c.x}`, err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
});
