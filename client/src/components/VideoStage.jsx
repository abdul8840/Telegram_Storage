/**
 * Video playback stage.
 *
 * iPhone recordings are HEVC/H.265 inside a .mov container, which most
 * browsers cannot decode. This component:
 *   1. plays the file natively when it can,
 *   2. offers a one-click server-side convert to H.264 MP4 when it cannot,
 *   3. streams live job progress while the convert runs,
 *   4. automatically switches to the browser-friendly copy when it is ready.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Download,
  Film,
  Play,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { Files, getToken, urls } from '../lib/api.js';
import { useDrive } from '../store/drive.js';
import { useJobs } from '../store/jobs.js';
import { useUi } from '../store/ui.js';
import { Progress, Spinner } from './common.jsx';
import { formatBytes } from '../lib/format.js';

export function VideoStage({ file, onConvert, onDownload }) {
  const capabilities = useDrive((s) => s.capabilities);
  const jobs = useJobs((s) => s.jobs);
  const toast = useUi((s) => s.toast);

  const [alts, setAlts] = useState([]);
  const [doc, setDoc] = useState(file);
  const [playError, setPlayError] = useState(false);
  const [forceTry, setForceTry] = useState(false);
  const videoRef = useRef(null);

  const derivativeKey = useMemo(() => (file.derivatives || []).join(','), [file.derivatives]);
  const canTranscode = !!capabilities?.media?.transcode;

  // Keep in step with the parent's copy of the file (SSE refreshes).
  useEffect(() => {
    setDoc((current) => (current.id === file.id && current.updatedAt === file.updatedAt ? current : file));
  }, [file]);

  // Load derivative documents once, and pick the browser-friendly one.
  useEffect(() => {
    let alive = true;
    const ids = derivativeKey ? derivativeKey.split(',').filter(Boolean) : [];
    if (!ids.length) {
      setAlts([]);
      return undefined;
    }
    (async () => {
      const docs = await Promise.all(ids.map((id) => Files.get(id).catch(() => null)));
      if (!alive) return;
      const ready = docs.filter((d) => d && d.status === 'ready');
      setAlts(ready);
      const friendly = ready.find((d) => d.previewKind === 'video');
      if (friendly) {
        setDoc((current) => (current.previewKind === 'video' ? current : friendly));
      }
    })();
    return () => {
      alive = false;
    };
  }, [derivativeKey, file.id]);

  const job = useMemo(
    () => jobs.find((j) => j.fileId === file.id && ['queued', 'running', 'pending'].includes(j.status)),
    [jobs, file.id],
  );
  const finishedJob = useMemo(
    () => jobs.find((j) => j.fileId === file.id && j.status === 'done' && j.output?.fileId),
    [jobs, file.id],
  );

  // When a transcode finishes, jump straight onto the new H.264 copy.
  const lastApplied = useRef(null);
  useEffect(() => {
    const outputId = finishedJob?.output?.fileId;
    if (!outputId || lastApplied.current === outputId) return;
    lastApplied.current = outputId;
    (async () => {
      const created = await Files.get(outputId).catch(() => null);
      if (!created) return;
      setAlts((prev) => [created, ...prev.filter((a) => a.id !== created.id)]);
      setDoc(created);
      setPlayError(false);
      toast({
        kind: 'success',
        title: 'H.264 copy ready',
        message: `${created.name} — playing the browser-friendly version`,
        timeout: 6000,
      });
    })();
  }, [finishedJob, toast]);

  const playable = doc.previewKind === 'video' && !playError;
  const showConvertPrompt = !playable;
  const media = doc.media || {};

  const convert = () => {
    if (onConvert) onConvert(file);
    else toast({ kind: 'info', title: 'Conversion unavailable', message: 'ffmpeg is not available on this server' });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, width: '100%' }}>
      {alts.length ? (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
          {[file, ...alts].map((option) => {
            const isOriginal = option.id === file.id;
            const friendly = option.previewKind === 'video';
            return (
              <button
                key={option.id}
                className="chip"
                data-active={doc.id === option.id}
                onClick={() => {
                  setPlayError(false);
                  setForceTry(false);
                  setDoc(option);
                }}
                title={option.name}
              >
                {friendly ? <Play size={12} /> : <Film size={12} />}
                {isOriginal ? `Original${file.hevc ? ' (HEVC)' : ''}` : 'H.264 copy'}
                <span className="tiny faint">{formatBytes(option.size || 0)}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {playable || forceTry ? (
        <video
          ref={videoRef}
          className="preview-video"
          src={urls.stream(doc.id, getToken())}
          poster={doc.hasThumb ? urls.thumbnail(doc.id, getToken()) : undefined}
          controls
          autoPlay
          playsInline
          preload="metadata"
          onError={() => {
            if (!forceTry) setPlayError(true);
            else toast({ kind: 'warn', title: 'Your browser cannot decode this video', message: 'Convert it to H.264 to play it here', timeout: 6000 });
          }}
        />
      ) : null}

      {job ? (
        <div className="hevc-banner">
          <Spinner />
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <div className="callout-title" style={{ fontSize: 13 }}>
              <Wand2 /> Converting to H.264… {job.progress ? `${Math.round(job.progress)}%` : ''}
            </div>
            <Progress percent={job.progress || 0} thin />
            <p className="tiny faint" style={{ marginTop: 6 }}>
              {job.phase === 'downloading'
                ? 'Fetching the original from Telegram…'
                : job.phase === 'transcoding'
                  ? 'Re-encoding video and audio…'
                  : job.phase === 'saving'
                    ? 'Saving the new copy to your cloud…'
                    : 'Working…'}{' '}
              You can keep browsing — this runs in the background.
            </p>
          </div>
        </div>
      ) : null}

      {showConvertPrompt && !job ? (
        <div className="hevc-banner">
          <span style={{ color: 'var(--violet, #a855f7)', display: 'grid', placeItems: 'center' }}>
            <AlertTriangle />
          </span>
          <div style={{ flex: '1 1 240px', minWidth: 0 }}>
            <div className="callout-title" style={{ fontSize: 13.5 }}>
              {playError ? 'Your browser could not play this video' : 'HEVC (H.265) video — not playable in browsers'}
            </div>
            <p className="small" style={{ marginTop: 5, color: 'var(--text-soft)' }}>
              {doc.name}
              {media.vcodec ? ` · ${media.vcodec}` : ''}
              {media.width ? ` · ${media.width}×${media.height}` : ''}
              {media.duration ? ` · ${Math.round(media.duration)}s` : ''}. Convert it once and the H.264 MP4 copy plays
              instantly on any device, keeps the original safe, and stays in your Telegram cloud.
            </p>
            <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              {canTranscode ? (
                <button className="btn btn-primary btn-sm" onClick={convert}>
                  <Sparkles /> Convert &amp; play
                </button>
              ) : (
                <span className="badge badge-warn">
                  <AlertTriangle size={12} /> ffmpeg unavailable on this server
                </span>
              )}
              <button className="btn btn-outline btn-sm" onClick={() => setForceTry(true)}>
                <Play /> Try anyway
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => (onDownload ? onDownload(doc) : Files.get(doc.id))}>
                <Download /> Download
              </button>
            </div>
            {!canTranscode ? (
              <p className="tiny faint" style={{ marginTop: 8 }}>
                Downloading still works — the file is stored intact in Telegram. Install ffmpeg on the server to enable
                in-browser conversion.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default VideoStage;
