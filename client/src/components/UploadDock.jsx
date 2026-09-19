/**
 * Floating dock that shows live upload progress (client chunks + server
 * processing) and background transcode jobs. Everything is driven by the
 * uploads/jobs stores, which the SSE stream keeps current.
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  File as FileIconGeneric,
  FileText,
  Film,
  Image as ImageIcon,
  Music,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  Wand2,
  X,
  XCircle,
} from 'lucide-react';
import { useUploads } from '../store/uploads.js';
import { useJobs } from '../store/jobs.js';
import { useUi } from '../store/ui.js';
import { Progress, Spinner } from './common.jsx';
import { formatBytes, formatSpeed, eta } from '../lib/format.js';

const KIND_ICON = {
  video: Film,
  image: ImageIcon,
  audio: Music,
  doc: FileText,
  archive: Archive,
};

function iconFor(kind) {
  return KIND_ICON[kind] || FileIconGeneric;
}

function statusMeta(task) {
  switch (task.status) {
    case 'queued':
      return { text: 'Waiting…', state: 'active', icon: null };
    case 'uploading': {
      const parts = [`${task.percent || 0}%`];
      if (task.speed) parts.push(formatSpeed(task.speed));
      if (task.etaSeconds) parts.push(eta(task.etaSeconds));
      if (task.chunksTotal) parts.push(`${task.chunksDone}/${task.chunksTotal} parts`);
      return { text: parts.join(' · '), state: 'active', icon: null };
    }
    case 'processing':
      return { text: 'Processing in the cloud…', state: 'active', icon: <Spinner size={12} /> };
    case 'ready':
      return { text: 'Saved to Telegram cloud', state: 'done', icon: <CheckCircle2 size={12} /> };
    case 'paused':
      return { text: 'Paused', state: 'paused', icon: <Pause size={12} /> };
    case 'cancelled':
      return { text: 'Cancelled', state: 'paused', icon: <XCircle size={12} /> };
    case 'error':
      return { text: task.error || 'Upload failed', state: 'error', icon: <TriangleAlert size={12} /> };
    default:
      return { text: task.status, state: 'active', icon: null };
  }
}

export function UploadDock() {
  const navigate = useNavigate();
  const tasks = useUploads((s) => s.tasks);
  const jobs = useJobs((s) => s.jobs);
  const open = useUi((s) => s.uploadDockOpen);
  const toggle = useUi((s) => s.toggleUploadDock);
  const toast = useUi((s) => s.toast);

  const pause = useUploads((s) => s.pause);
  const resume = useUploads((s) => s.resume);
  const cancel = useUploads((s) => s.cancel);
  const remove = useUploads((s) => s.remove);
  const clearFinished = useUploads((s) => s.clearFinished);
  const retryAll = useUploads((s) => s.retryAll);

  const active = useMemo(() => tasks.filter((t) => ['queued', 'uploading', 'processing'].includes(t.status)), [tasks]);
  const summary = useMemo(() => {
    const totalBytes = active.reduce((sum, t) => sum + (t.size || 0), 0);
    const sentBytes = active.reduce((sum, t) => sum + (t.sent || 0), 0);
    return {
      totalBytes,
      sentBytes,
      percent: totalBytes ? Math.round((sentBytes / totalBytes) * 100) : 0,
      speed: active.reduce((sum, t) => sum + (t.speed || 0), 0),
    };
  }, [active]);
  const activeJobs = useMemo(
    () => jobs.filter((j) => ['queued', 'running', 'pending'].includes(j.status)),
    [jobs],
  );

  if (!tasks.length && !activeJobs.length) return null;

  const uploading = tasks.filter((t) => ['queued', 'uploading', 'processing'].includes(t.status));
  const finished = tasks.filter((t) => ['ready', 'error', 'cancelled'].includes(t.status));
  const failed = tasks.filter((t) => t.status === 'error');
  const collapsed = !open;

  const title = uploading.length
    ? `Uploading ${uploading.length} file${uploading.length > 1 ? 's' : ''}`
    : activeJobs.length
      ? 'Working in the background'
      : tasks.length
        ? 'Uploads complete'
        : 'Background jobs';

  const subtitle = uploading.length
    ? `${summary.percent}% · ${formatSpeed(summary.speed)} · ${formatBytes(summary.sentBytes)} of ${formatBytes(summary.totalBytes)}`
    : activeJobs.length
      ? `${activeJobs.length} job${activeJobs.length > 1 ? 's' : ''} running`
      : failed.length
        ? `${failed.length} failed`
        : `${finished.length} finished`;

  return (
    <aside className="dock" data-collapsed={collapsed} aria-label="Uploads">
      <div className="dock-head">
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div className="dock-title ellipsis">{title}</div>
          <div className="dock-sub ellipsis">{subtitle}</div>
        </div>

        {uploading.length > 1 ? (
          <button
            className="btn btn-ghost btn-icon btn-sm"
            title="Pause all"
            onClick={() => useUploads.getState().pauseAll()}
          >
            <Pause />
          </button>
        ) : null}

        <button className="btn btn-ghost btn-icon btn-sm" title={collapsed ? 'Expand' : 'Collapse'} onClick={toggle}>
          {collapsed ? <ChevronUp /> : <ChevronDown />}
        </button>

        <button
          className="btn btn-ghost btn-icon btn-sm"
          title="Dismiss"
          onClick={() => {
            clearFinished();
            if (uploading.length) toast({ kind: 'info', title: 'Uploads continue in the background', timeout: 2600 });
          }}
        >
          <X />
        </button>
      </div>

      {!collapsed ? (
        <div className="dock-body">
          {tasks.map((task) => {
            const Icon = iconFor(task.kind);
            const meta = statusMeta(task);
            return (
              <div className="dock-item" key={task.id}>
                <span className="dock-item-icon" data-kind={task.kind}>
                  <Icon />
                </span>
                <span className="dock-item-main">
                  <span className="dock-item-name ellipsis" title={task.path || task.name}>
                    {task.name}
                  </span>
                  <Progress percent={task.percent || 0} state={meta.state} thin />
                  <span className="dock-item-meta">
                    {meta.icon}
                    <span className="ellipsis">{meta.text}</span>
                    {task.size ? <span>· {formatBytes(task.size)}</span> : null}
                  </span>
                </span>
                <span className="dock-actions">
                  {task.status === 'ready' && task.fileId ? (
                    <button
                      title="Open in cloud"
                      onClick={() => {
                        navigate(`/drive?open=${task.fileId}`);
                        remove(task.id);
                      }}
                    >
                      <ExternalLink />
                    </button>
                  ) : null}
                  {task.status === 'uploading' || task.status === 'processing' ? (
                    <button title="Pause" onClick={() => pause(task.id)}>
                      <Pause />
                    </button>
                  ) : null}
                  {task.status === 'paused' ? (
                    <button title="Resume" onClick={() => resume(task.id)}>
                      <Play />
                    </button>
                  ) : null}
                  {task.status === 'error' ? (
                    <button title="Retry" onClick={() => resume(task.id)}>
                      <RotateCcw />
                    </button>
                  ) : null}
                  {['queued', 'uploading', 'processing', 'paused'].includes(task.status) ? (
                    <button title="Cancel" onClick={() => cancel(task.id)}>
                      <X />
                    </button>
                  ) : null}
                  {['ready', 'error', 'cancelled'].includes(task.status) ? (
                    <button title="Remove" onClick={() => remove(task.id)}>
                      <X />
                    </button>
                  ) : null}
                </span>
              </div>
            );
          })}

          {activeJobs.map((job) => (
            <div className="dock-item" key={job._id || job.id}>
              <span className="dock-item-icon" data-kind="video">
                <Wand2 />
              </span>
              <span className="dock-item-main">
                <span className="dock-item-name ellipsis">{job.fileName || job.title || 'Converting video'}</span>
                <Progress percent={job.progress || 0} state="active" thin />
                <span className="dock-item-meta">
                  <Spinner size={12} />
                  <span className="ellipsis">
                    {job.type === 'transcode' ? 'Making an H.264 copy that plays everywhere' : 'Preparing preview'}
                    {job.progress ? ` · ${Math.round(job.progress)}%` : ''}
                  </span>
                </span>
              </span>
              <span className="dock-actions">
                <button
                  title="Cancel job"
                  onClick={() => useJobs.getState().cancel(job._id || job.id).catch(() => {})}
                >
                  <X />
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {!collapsed && finished.length ? (
        <div className="dock-foot">
          <button className="btn btn-ghost btn-sm" style={{ flex: 1 }} onClick={clearFinished}>
            <RefreshCw /> Clear finished
          </button>
          {failed.length ? (
            <button className="btn btn-ghost btn-sm" style={{ flex: 1 }} onClick={retryAll}>
              <RotateCcw /> Retry {failed.length}
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

export default UploadDock;
