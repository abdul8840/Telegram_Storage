/**
 * Video playback stage.
 *
 * A single native HTML video player for MP4/MOV, WebM and MKV. The server
 * provides authenticated byte-range streaming from Telegram. This component:
 *   1. tries every supported/conditionally-supported container directly,
 *   2. offers an MP4/H.264 fallback only after a real playback error,
 *   3. streams live job progress while the convert runs,
 *   4. automatically switches to the browser-friendly result when it is ready.
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

const DIRECT_VIDEO_KINDS = new Set(['video', 'video-conditional', 'video-native-attempt']);

export function VideoStage({ file, onConvert, onDownload }) {
  const capabilities = useDrive((s) => s.capabilities);
  const jobs = useJobs((s) => s.jobs);
  const toast = useUi((s) => s.toast);

  const [alts, setAlts] = useState([]);
  const [doc, setDoc] = useState(file);
  const [playError, setPlayError] = useState(null);
  const [forceTry, setForceTry] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [networkRetries, setNetworkRetries] = useState(0);
  const [startingConversion, setStartingConversion] = useState(false);
  const videoRef = useRef(null);
  const autoConvertRef = useRef(null);

  const derivativeKey = useMemo(() => (file.derivatives || []).join(','), [file.derivatives]);
  const canTranscode = !!capabilities?.media?.transcode;

  // Keep in step with the parent's copy of the file (SSE refreshes).
  useEffect(() => {
    setDoc((current) => (current.id === file.id && current.updatedAt === file.updatedAt ? current : file));
  }, [file]);

  useEffect(() => {
    setPlayError(null);
    setForceTry(false);
    setStreamAttempt(0);
    setNetworkRetries(0);
    setStartingConversion(false);
    autoConvertRef.current = null;
  }, [file.id]);

  // Load legacy derivative documents once, and pick the browser-friendly one.
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
  const failedJob = useMemo(
    () => jobs.find((j) => j.fileId === file.id && ['failed', 'cancelled'].includes(j.status)),
    [jobs, file.id],
  );

  // When a legacy transcode finishes, jump straight onto the replaced H.264 file.
  const lastApplied = useRef(null);
  useEffect(() => {
    const outputId = finishedJob?.output?.fileId;
    if (!outputId || lastApplied.current === outputId) return;
    lastApplied.current = outputId;
    (async () => {
      const created = await Files.get(outputId).catch(() => null);
      if (!created) return;
      if (finishedJob?.output?.replaced) setAlts([]);
      else setAlts((prev) => [created, ...prev.filter((a) => a.id !== created.id)]);
      setDoc(created);
      setPlayError(null);
      setStreamAttempt((attempt) => attempt + 1);
      setNetworkRetries(0);
      toast({
        kind: 'success',
        title: finishedJob?.output?.strategy === 'remux' ? 'Web MP4 ready' : 'Browser video ready',
        message: `${created.name} — playing the optimized file`,
        timeout: 6000,
      });
    })();
  }, [finishedJob, toast]);

  const playable = DIRECT_VIDEO_KINDS.has(doc.previewKind) && !playError;
  const showConvertPrompt = !playable;
  const media = doc.media || {};
  const compatibility = doc.videoCompatibility || file.videoCompatibility || {};
  const canTryOriginal = ['conditional', 'attempt'].includes(compatibility.mode) || compatibility.reasonCode !== 'container';
  const isRemux = compatibility.strategy === 'remux';
  const conversionJob = job || (startingConversion ? { phase: 'queued', progress: 0 } : null);
  const baseStreamUrl = urls.stream(doc.id, getToken());
  const streamUrl = `${baseStreamUrl}${baseStreamUrl.includes('?') ? '&' : '?'}play_attempt=${streamAttempt}`;

  const retryPlayback = ({ force = false } = {}) => {
    setPlayError(null);
    setForceTry(force);
    setNetworkRetries(0);
    setStreamAttempt((attempt) => attempt + 1);
  };

  const handleVideoError = (event) => {
    const mediaError = event.currentTarget.error;
    const code = Number(mediaError?.code || 0);
    const message = mediaError?.message || '';

    // MEDIA_ERR_ABORTED is expected when React changes the selected rendition.
    if (code === 1) return;

    // Telegram/host connections can occasionally be interrupted. Retry with a
    // fresh request before presenting a format/decoder failure to the user.
    if (code === 2 && networkRetries < 2) {
      setNetworkRetries((count) => count + 1);
      setStreamAttempt((attempt) => attempt + 1);
      return;
    }

    setPlayError({ code, message });
    setForceTry(false);
  };

  const convert = () => {
    if (onConvert) onConvert(file);
    else toast({ kind: 'info', title: 'Conversion unavailable', message: 'ffmpeg is not available on this server' });
  };

  // Browsers cannot decode formats such as 10-bit HEVC in MKV. Start a single
  // compatibility job automatically after a decoder rejection, or immediately
  // for files already known to require conversion. A failed/cancelled job is
  // left for manual retry so an unhealthy worker cannot create a retry loop.
  useEffect(() => {
    const decoderRejected = playError && [3, 4].includes(playError.code);
    const knownIncompatible = doc.id === file.id && doc.previewKind === 'video-transcode';
    const alreadyHasCopy = Boolean(file.derivatives?.length || alts.some((item) => item.previewKind === 'video'));
    if (!onConvert || !canTranscode || conversionJob || finishedJob || failedJob || alreadyHasCopy) return;
    if (!decoderRejected && !knownIncompatible) return;
    const key = `${file.id}:${file.updatedAt || ''}`;
    if (autoConvertRef.current === key) return;
    autoConvertRef.current = key;
    setStartingConversion(true);
    Promise.resolve(onConvert(file)).finally(() => setStartingConversion(false));
  }, [alts, canTranscode, conversionJob, doc.id, doc.previewKind, failedJob, file, finishedJob, onConvert, playError]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, width: '100%' }}>
      {alts.length ? (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
          {[file, ...alts].map((option) => {
            const isOriginal = option.id === file.id;
            return (
              <button
                key={option.id}
                className="chip"
                data-active={doc.id === option.id}
                onClick={() => {
                  setPlayError(null);
                  setForceTry(false);
                  setNetworkRetries(0);
                  setStreamAttempt((attempt) => attempt + 1);
                  setDoc(option);
                }}
                title={option.name}
              >
                {DIRECT_VIDEO_KINDS.has(option.previewKind) ? <Play size={12} /> : <Film size={12} />}
                {isOriginal ? 'Original' : 'Browser version'}
                <span className="tiny faint">{formatBytes(option.size || 0)}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {playable || forceTry ? (
        <video
          key={`${doc.id}-${streamAttempt}`}
          ref={videoRef}
          className="preview-video"
          src={streamUrl}
          poster={doc.hasThumb ? urls.thumbnail(doc.id, getToken()) : undefined}
          controls
          autoPlay
          playsInline
          preload="metadata"
          onError={handleVideoError}
        />
      ) : null}

      {conversionJob ? (
        <div className="hevc-banner">
          <Spinner />
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <div className="callout-title" style={{ fontSize: 13 }}>
              <Wand2 /> Preparing a browser-compatible video…{' '}
              {conversionJob.progress ? `${Math.round(conversionJob.progress)}%` : ''}
            </div>
            <Progress percent={conversionJob.progress || 0} thin />
            <p className="tiny faint" style={{ marginTop: 6 }}>
              {conversionJob.phase === 'queued'
                ? 'Waiting for the media worker…'
                : conversionJob.phase === 'downloading'
                ? 'Fetching the original from Telegram…'
                : conversionJob.phase === 'remuxing'
                  ? 'Copying the video into a browser-compatible MP4 container…'
                  : conversionJob.phase === 'transcoding'
                    ? 'Creating a fast H.264/AAC video…'
                    : conversionJob.phase === 'saving'
                      ? 'Replacing the stored video safely…'
                      : 'Working…'}{' '}
              The Telegram file is replaced only after the optimized upload succeeds. You can keep browsing while this finishes.
            </p>
          </div>
        </div>
      ) : null}

      {showConvertPrompt && !conversionJob ? (
        <div className="hevc-banner">
          <span style={{ color: 'var(--violet, #a855f7)', display: 'grid', placeItems: 'center' }}>
            <AlertTriangle />
          </span>
          <div style={{ flex: '1 1 240px', minWidth: 0 }}>
            <div className="callout-title" style={{ fontSize: 13.5 }}>
              {playError
                ? playError.code === 2
                  ? 'The video stream was interrupted'
                  : playError.code === 3
                    ? 'Your browser could not decode this video'
                    : `Your browser could not play this ${compatibility.containerLabel || 'video'}`
                : compatibility.reasonCode === 'container'
                  ? `${compatibility.containerLabel || 'This container'} needs browser preparation`
                  : 'This video needs browser preparation'}
            </div>
            <p className="small" style={{ marginTop: 5, color: 'var(--text-soft)' }}>
              {doc.name}
              {media.vcodec ? ` · ${media.vcodec}` : ''}
              {media.width ? ` · ${media.width}×${media.height}` : ''}
              {media.duration ? ` · ${Math.round(media.duration)}s` : ''}.{' '}
              {playError?.code === 2
                ? 'The connection to Telegram ended before playback completed. Retry playback; converting the file will not fix a network interruption.'
                : failedJob?.error
                  ? `The previous conversion did not finish: ${failedJob.error}`
                  : compatibility.reason || 'The container or codec is not supported reliably by this browser.'}
            </p>
            <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              {playError ? (
                <button className="btn btn-primary btn-sm" onClick={() => retryPlayback()}>
                  <Play /> Retry playback
                </button>
              ) : null}
              {canTranscode && playError?.code !== 2 ? (
                <button className="btn btn-primary btn-sm" onClick={convert}>
                  <Sparkles /> {isRemux ? 'Prepare MP4 & play' : 'Convert to H.264 & play'}
                </button>
              ) : !canTranscode && playError?.code !== 2 ? (
                <span className="badge badge-warn">
                  <AlertTriangle size={12} /> ffmpeg unavailable on this server
                </span>
              ) : null}
              {canTryOriginal && !playError ? (
                <button className="btn btn-outline btn-sm" onClick={() => retryPlayback({ force: true })}>
                  <Play /> Try original
                </button>
              ) : null}
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
