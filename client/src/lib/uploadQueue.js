/**
 * Resumable chunked uploader (client side).
 *
 * A big iPhone video is sliced into fixed-size parts and pushed with limited
 * parallelism; each part is acknowledged by the server, so:
 *   • a dropped connection resumes from the last acknowledged part
 *   • pausing/cancelling is instant (in-flight parts are aborted)
 *   • the tab can be closed and the same file re-added to continue
 *
 * The queue is framework-agnostic: it notifies listeners on every change and
 * the zustand store mirrors that into React state.
 */
import { Files, Uploads } from './api.js';

let seq = 0;
const newId = () => `up_${Date.now().toString(36)}_${(seq += 1).toString(36)}`;

class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function pool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export class UploadQueue {
  constructor({ fileConcurrency = 2, chunkConcurrency = 3 } = {}) {
    this.tasks = [];
    this.listeners = new Set();
    this.fileConcurrency = fileConcurrency;
    this.chunkConcurrency = chunkConcurrency;
    this.running = 0;
    this.pumpBound = () => this.#pump();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    const snapshot = this.getState();
    this.listeners.forEach((l) => l(snapshot));
  }

  getState() {
    return this.tasks.map((t) => ({
      id: t.id,
      name: t.name,
      size: t.size,
      kind: t.kind,
      folderId: t.folderId,
      folderPath: t.folderPath || null,
      status: t.status,
      phase: t.phase,
      percent: t.percent,
      sent: t.sent,
      speed: t.speed,
      etaSeconds: t.etaSeconds,
      error: t.error,
      fileId: t.fileId,
      uploadId: t.uploadId,
      chunksDone: t.chunksDone.size,
      chunksTotal: t.chunksTotal,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      canResume: t.status === 'paused' || t.status === 'error',
    }));
  }

  setConcurrency({ fileConcurrency, chunkConcurrency }) {
    if (fileConcurrency) this.fileConcurrency = Math.max(1, Math.min(6, fileConcurrency));
    if (chunkConcurrency) this.chunkConcurrency = Math.max(1, Math.min(6, chunkConcurrency));
    this.#pump();
  }

  /**
   * @param {Array<{file: File, path?: string}>} entries
   * @param {{folderId?: string|null, onNeedFolder?: Function}} options
   */
  async add(entries, { folderId = null, resolveFolder = null } = {}) {
    const added = [];
    for (const entry of entries) {
      const file = entry.file || entry;
      if (!file) continue;
      const relativePath = entry.path || file.webkitRelativePath || '';
      const dirPart = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '';

      // De-duplicate: same file object or same name+size already queued.
      const dupe = this.tasks.find(
        (t) =>
          t.file === file ||
          (t.name === file.name && t.size === file.size && ['queued', 'uploading', 'processing'].includes(t.status)),
      );
      if (dupe) {
        added.push(dupe.id);
        continue;
      }

      let targetFolder = folderId;
      if (dirPart && resolveFolder) {
        try {
          targetFolder = await resolveFolder(dirPart);
        } catch {
          targetFolder = folderId;
        }
      }

      const task = {
        id: newId(),
        file,
        name: file.name,
        size: file.size,
        kind: (file.type || '').split('/')[0] || 'other',
        folderId: targetFolder,
        folderPath: dirPart || null,
        status: 'queued',
        phase: 'queued',
        percent: 0,
        sent: 0,
        speed: 0,
        etaSeconds: null,
        error: null,
        fileId: null,
        uploadId: null,
        chunkSize: null,
        chunksTotal: 0,
        chunksDone: new Set(),
        chunkProgress: new Map(),
        controller: null,
        startedAt: null,
        finishedAt: null,
        samples: [],
      };
      this.tasks.unshift(task);
      added.push(task.id);
    }
    this.emit();
    this.#pump();
    return added;
  }

  #pump() {
    const startable = this.tasks.filter((t) => t.status === 'queued');
    while (this.running < this.fileConcurrency && startable.length) {
      const task = startable.shift();
      this.running += 1;
      task.status = 'uploading';
      task.startedAt = Date.now();
      task.controller = new AbortController();
      this.#run(task).finally(() => {
        this.running = Math.max(0, this.running - 1);
        this.emit();
        this.#pump();
      });
    }
    this.emit();
  }

  #sampleSpeed(task) {
    const now = Date.now();
    task.samples.push({ t: now, bytes: task.sent });
    // keep a 6-second window
    while (task.samples.length && now - task.samples[0].t > 6000) task.samples.shift();
    if (task.samples.length < 2) return;
    const first = task.samples[0];
    const dt = (now - first.t) / 1000;
    if (dt <= 0.2) return;
    task.speed = Math.max(0, (task.sent - first.bytes) / dt);
    const remaining = task.size - task.sent;
    task.etaSeconds = task.speed > 0 ? remaining / task.speed : null;
  }

  async #run(task) {
    try {
      // 1) Create or resume the server-side session.
      if (!task.uploadId) {
        task.phase = 'starting';
        this.emit();
        const session = await Uploads.create({
          name: task.name,
          size: task.size,
          mime: task.file.type || undefined,
          folderId: task.folderId,
        });
        task.uploadId = session.uploadId;
        task.chunkSize = session.chunkSize;
        task.chunksTotal = session.totalChunks;
        task.chunksDone = new Set(session.receivedChunks || []);
        task.sent = [...task.chunksDone].reduce(
          (sum, index) => sum + Math.min(task.chunkSize, Math.max(0, task.size - index * task.chunkSize)),
          0,
        );
      }

      // 2) Push the missing chunks with bounded parallelism.
      const pending = [];
      for (let i = 0; i < task.chunksTotal; i += 1) if (!task.chunksDone.has(i)) pending.push(i);

      if (pending.length) {
        task.phase = task.chunksDone.size ? 'resuming' : 'uploading';
        task.percent = task.size ? Math.round((task.sent / task.size) * 100) : 0;
        this.emit();

        await pool(pending, this.chunkConcurrency, async (index) => {
          if (task.controller?.signal.aborted) throw new CancelledError();
          const start = index * task.chunkSize;
          const end = Math.min(start + task.chunkSize, task.size);
          const blob = task.file.slice(start, end);
          const result = await Uploads.chunk(task.uploadId, index, blob, { signal: task.controller?.signal });
          if (task.controller?.signal.aborted) throw new CancelledError();
          task.chunksDone.add(index);
          task.sent = Math.min(task.size, task.sent + (result?.bytes || end - start));
          task.percent = task.size ? Math.round((task.sent / task.size) * 100) : 100;
          this.#sampleSpeed(task);
          this.emit();
        });
      }

      if (task.controller?.signal.aborted) throw new CancelledError();

      // 3) Ask the server to assemble + push to storage.
      task.phase = 'processing';
      task.percent = 100;
      this.emit();
      const { fileId } = await Uploads.complete(task.uploadId);
      task.fileId = fileId;
      task.status = 'processing';
      task.phase = 'saving';
      this.emit();
      // From here the server drives progress (probe → thumbnail → Telegram),
      // reported over SSE via markFileProgress()/markFileReady().
    } catch (err) {
      if (err?.name === 'CancelledError' || task.controller?.signal.aborted) {
        task.status = 'paused';
        task.phase = 'paused';
        task.speed = 0;
        this.emit();
        return;
      }
      task.status = 'error';
      task.phase = 'error';
      task.error = err?.message || 'Upload failed';
      task.speed = 0;
      this.emit();
    }
  }

  /** Retries (or resumes) a paused/failed task. */
  retry(id) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    if (!['paused', 'error', 'cancelled'].includes(task.status)) return;
    task.status = 'queued';
    task.phase = 'queued';
    task.error = null;
    task.controller = null;
    this.emit();
    this.#pump();
  }

  retryAll() {
    this.tasks.filter((t) => ['paused', 'error'].includes(t.status)).forEach((t) => this.retry(t.id));
  }

  pause(id) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    if (!['uploading', 'queued'].includes(task.status)) return;
    task.controller?.abort();
    task.status = 'paused';
    task.phase = 'paused';
    task.speed = 0;
    this.emit();
  }

  pauseAll() {
    this.tasks.filter((t) => ['uploading', 'queued'].includes(t.status)).forEach((t) => this.pause(t.id));
  }

  resumeAll() {
    this.tasks.filter((t) => t.status === 'paused').forEach((t) => this.retry(t.id));
  }

  /** Cancels and tells the server to throw away the partial data. */
  async cancel(id) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    task.controller?.abort();
    try {
      // If the server already turned it into a library file, cancel that job;
      // otherwise discard the partial upload session and its chunks.
      if (task.fileId) await Files.cancel(task.fileId);
      else if (task.uploadId) await Uploads.remove(task.uploadId);
    } catch {
      /* best effort */
    }
    task.status = 'cancelled';
    task.phase = 'cancelled';
    task.speed = 0;
    this.emit();
  }

  remove(id) {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index >= 0) {
      const task = this.tasks[index];
      if (['uploading', 'queued'].includes(task.status)) task.controller?.abort();
      this.tasks.splice(index, 1);
      this.emit();
    }
  }

  clearFinished() {
    this.tasks = this.tasks.filter((t) => !['ready', 'cancelled', 'error'].includes(t.status));
    this.emit();
  }

  // ── SSE hooks ────────────────────────────────────────────────────────────

  #byFileId(fileId) {
    return this.tasks.find((t) => t.fileId === fileId);
  }

  markFileProgress(fileId, payload = {}) {
    const task = this.#byFileId(fileId);
    if (!task || task.status === 'ready') return;
    task.status = 'processing';
    task.phase = payload.phase || task.phase;
    if (typeof payload.percent === 'number') task.percent = Math.max(0, Math.min(100, payload.percent));
    if (typeof payload.providerPercent === 'number') task.serverPercent = payload.providerPercent;
    if (payload.speed) task.serverSpeed = payload.speed;
    this.emit();
  }

  markFileReady(fileId, file) {
    const task = this.#byFileId(fileId);
    if (!task) return;
    task.status = 'ready';
    task.phase = 'ready';
    task.percent = 100;
    task.speed = 0;
    task.finishedAt = Date.now();
    if (file?.id) task.fileId = file.id;
    this.emit();
  }

  markFileError(fileId, message) {
    const task = this.#byFileId(fileId);
    if (!task) return;
    task.status = 'error';
    task.phase = 'error';
    task.error = message || 'Processing failed';
    task.speed = 0;
    this.emit();
  }

  markFileCancelled(fileId) {
    const task = this.#byFileId(fileId);
    if (!task) return;
    task.status = 'cancelled';
    task.phase = 'cancelled';
    this.emit();
  }
}

export const uploadQueue = new UploadQueue();
export default uploadQueue;
