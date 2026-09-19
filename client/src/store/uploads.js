/** Upload store: mirrors the framework-agnostic UploadQueue into React state. */
import { create } from 'zustand';
import uploadQueue from '../lib/uploadQueue.js';
import { Folders } from '../lib/api.js';

let started = false;
const folderCache = new Map();

/** Resolves "a/b/c" → folder id once per path (cached for the session). */
async function resolveFolderPath(folderPath) {
  if (folderCache.has(folderPath)) return folderCache.get(folderPath);
  const promise = Folders.ensurePath(folderPath).then((r) => r.folderId);
  folderCache.set(folderPath, promise);
  try {
    return await promise;
  } catch (err) {
    folderCache.delete(folderPath);
    throw err;
  }
}

export const useUploads = create((set, get) => ({
  tasks: [],
  initialised: false,

  init() {
    if (started) return;
    started = true;
    uploadQueue.subscribe((tasks) => set({ tasks }));
    set({ tasks: uploadQueue.getState(), initialised: true });
  },

  /** @param {Array<{file:File,path?:string}>|FileList|File[]} entries */
  async add(entries, { folderId = null } = {}) {
    get().init();
    const list = Array.from(entries || []);
    if (!list.length) return [];
    const ids = await uploadQueue.add(list, { folderId, resolveFolder: resolveFolderPath });
    return ids;
  },

  addFiles(fileList, opts) {
    return get().add(Array.from(fileList || []).map((file) => ({ file })), opts);
  },

  pause: (id) => uploadQueue.pause(id),
  pauseAll: () => uploadQueue.pauseAll(),
  resume: (id) => uploadQueue.retry(id),
  resumeAll: () => uploadQueue.resumeAll(),
  retryAll: () => uploadQueue.retryAll(),
  cancel: (id) => uploadQueue.cancel(id),
  remove: (id) => uploadQueue.remove(id),
  clearFinished: () => uploadQueue.clearFinished(),
  setConcurrency: (opts) => uploadQueue.setConcurrency(opts),

  // SSE bridges
  markFileProgress: (fileId, payload) => uploadQueue.markFileProgress(fileId, payload),
  markFileReady: (fileId, file) => uploadQueue.markFileReady(fileId, file),
  markFileError: (fileId, message) => uploadQueue.markFileError(fileId, message),
  markFileCancelled: (fileId) => uploadQueue.markFileCancelled(fileId),

  active() {
    return get().tasks.filter((t) => ['queued', 'uploading', 'processing'].includes(t.status));
  },
  summary() {
    const tasks = get().tasks;
    const active = tasks.filter((t) => ['queued', 'uploading', 'processing'].includes(t.status));
    const done = tasks.filter((t) => t.status === 'ready');
    const failed = tasks.filter((t) => t.status === 'error');
    const totalBytes = active.reduce((sum, t) => sum + (t.size || 0), 0);
    const sentBytes = active.reduce((sum, t) => sum + (t.sent || 0), 0);
    return {
      count: tasks.length,
      activeCount: active.length,
      doneCount: done.length,
      failedCount: failed.length,
      totalBytes,
      sentBytes,
      percent: totalBytes ? Math.round((sentBytes / totalBytes) * 100) : 0,
      speed: active.reduce((sum, t) => sum + (t.speed || 0), 0),
    };
  },
}));

export default useUploads;
