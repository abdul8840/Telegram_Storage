/**
 * Subscribes to the server's SSE stream and fans events out to the stores:
 * upload progress, processing state, transcode jobs and library mutations.
 * EventSource reconnects on its own, so a flaky network self-heals.
 */
import { useEffect, useRef, useState } from 'react';
import { getToken, urls } from '../lib/api.js';
import { useDrive } from '../store/drive.js';
import { useUploads } from '../store/uploads.js';
import { useJobs } from '../store/jobs.js';
import { useUi } from '../store/ui.js';

export function useEvents(enabled = true) {
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef(null);

  useEffect(() => {
    const token = getToken();
    if (!enabled || !token) {
      setConnected(false);
      return undefined;
    }

    const drive = useDrive.getState();
    const uploads = useUploads.getState();
    const jobs = useJobs.getState();
    const ui = useUi.getState();

    let es;
    try {
      es = new EventSource(urls.events(token));
    } catch {
      setConnected(false);
      return undefined;
    }
    sourceRef.current = es;

    const refreshSoon = (() => {
      let timer = null;
      return () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          useDrive.getState().load({ force: true });
          useDrive.getState().loadStats();
        }, 700);
      };
    })();

    es.addEventListener('connected', () => setConnected(true));
    es.onerror = () => setConnected(false);

    es.addEventListener('file:created', (e) => {
      const { file } = JSON.parse(e.data);
      drive.upsertFile(file);
    });

    es.addEventListener('file:progress', (e) => {
      const payload = JSON.parse(e.data);
      uploads.markFileProgress(payload.fileId, payload);
    });

    es.addEventListener('file:ready', (e) => {
      const { file } = JSON.parse(e.data);
      uploads.markFileReady(file.id, file);
      drive.upsertFile(file);
      drive.loadStats();
      drive.loadFolders();
      ui.toast({ kind: 'success', title: 'Saved to cloud', message: file.name, timeout: 3800 });
    });

    es.addEventListener('file:error', (e) => {
      const { fileId, name, error } = JSON.parse(e.data);
      uploads.markFileError(fileId, error);
      ui.toast({ kind: 'error', title: `Upload failed: ${name || 'file'}`, message: error, timeout: 9000 });
      drive.markStale();
    });

    es.addEventListener('file:cancelled', (e) => {
      const { fileId } = JSON.parse(e.data);
      uploads.markFileCancelled(fileId);
      drive.removeFiles([fileId]);
    });

    es.addEventListener('file:updated', (e) => {
      const { file } = JSON.parse(e.data);
      drive.upsertFile(file);
    });

    ['files:updated', 'files:moved', 'files:trashed', 'files:restored'].forEach((name) => {
      es.addEventListener(name, () => {
        drive.markStale();
        refreshSoon();
      });
    });

    es.addEventListener('file:deleted', (e) => {
      const { fileId } = JSON.parse(e.data);
      drive.removeFiles([fileId]);
      drive.loadStats();
    });

    es.addEventListener('job:created', (e) => {
      const { job } = JSON.parse(e.data);
      jobs.upsert(job);
    });
    es.addEventListener('job:progress', (e) => {
      const payload = JSON.parse(e.data);
      jobs.patch(payload.jobId, { status: 'running', progress: payload.percent, phase: payload.phase });
    });
    es.addEventListener('job:done', (e) => {
      const payload = JSON.parse(e.data);
      jobs.patch(payload.jobId, { status: 'done', progress: 100, phase: 'done', output: payload.output });
      ui.toast({
        kind: 'success',
        title: payload.output?.skipped ? 'Already browser-ready' : 'Conversion complete',
        message: payload.output?.skipped
          ? `${payload.output?.name || 'This video'} was not converted again.`
          : payload.output?.name || 'Your browser-friendly video is ready.',
        timeout: 6000,
      });
      refreshSoon();
    });
    es.addEventListener('job:failed', (e) => {
      const payload = JSON.parse(e.data);
      jobs.patch(payload.jobId, { status: 'failed', error: payload.error });
      ui.toast({ kind: 'error', title: 'Conversion failed', message: payload.error, timeout: 9000 });
    });
    es.addEventListener('job:cancelled', (e) => {
      const payload = JSON.parse(e.data);
      jobs.patch(payload.jobId, { status: 'cancelled' });
    });
    es.addEventListener('jobs:snapshot', (e) => {
      const { jobs: list } = JSON.parse(e.data);
      (list || []).forEach((j) => jobs.upsert(j));
    });

    return () => {
      try {
        es.close();
      } catch {
        /* ignore */
      }
      sourceRef.current = null;
      setConnected(false);
    };
  }, [enabled]);

  return { connected };
}

export default useEvents;
