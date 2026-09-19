/** Grid view: media-first cards with blur-up thumbnails and status overlays. */
import { memo } from 'react';
import clsx from 'clsx';
import { Check, Cloud, Film, Folder as FolderIcon, MoreVertical, Play, Star, TriangleAlert } from 'lucide-react';
import { Thumbnail } from './FileIcon.jsx';
import { Progress } from './common.jsx';
import { KIND_COLOR, formatBytes, formatDate, formatDuration } from '../lib/format.js';

export const FolderCard = memo(function FolderCard({ folder, selected, onOpen, onToggle, onContextMenu }) {
  return (
    <div
      className="folder-card"
      data-selected={selected}
      role="button"
      tabIndex={0}
      onClick={(e) => (e.metaKey || e.ctrlKey ? onToggle(`folder:${folder._id}`) : onOpen(folder))}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(folder)}
      onContextMenu={(e) => onContextMenu(folder, e)}
    >
      <span className="folder-icon">
        <FolderIcon />
      </span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="truncate" style={{ fontSize: 13.5, fontWeight: 600 }}>
          {folder.name}
        </div>
        <div className="tiny muted" style={{ marginTop: 2 }}>
          Folder{folder.fileCount ? ` · ${folder.fileCount} item${folder.fileCount === 1 ? '' : 's'}` : ''}
        </div>
      </div>
      <button
        className="checkbox"
        data-checked={selected}
        aria-label={`Select ${folder.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(`folder:${folder._id}`);
        }}
      >
        <Check />
      </button>
    </div>
  );
});

const StatusOverlay = ({ file }) => {
  if (file.status === 'ready') return null;
  const label =
    {
      processing: file.progress > 20 ? 'Saving to cloud…' : 'Analyzing…',
      uploading: 'Uploading…',
      assembling: 'Assembling…',
      failed: 'Failed',
      cancelled: 'Cancelled',
    }[file.status] || 'Working…';

  return (
    <div className="file-card-thumb" style={{ position: 'relative' }}>
      <div className="thumb-fallback">
        {file.status === 'failed' ? <TriangleAlert style={{ color: 'var(--danger)' }} /> : <Cloud />}
      </div>
      <div style={{ position: 'absolute', left: 10, right: 10, bottom: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div className="row-between tiny" style={{ color: '#dfe6f8' }}>
          <span>{label}</span>
          {file.status === 'failed' ? null : <span>{file.progress || 0}%</span>}
        </div>
        <Progress percent={file.status === 'failed' ? 100 : file.progress || 0} state={file.status === 'failed' ? 'error' : 'active'} thin />
        {file.status === 'failed' && file.error ? (
          <div className="tiny clamp-2" style={{ color: '#ffb3b9' }}>
            {file.error}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export const FileCard = memo(function FileCard({ file, selected, selecting, onOpen, onToggle, onContextMenu, style }) {
  const isMedia = ['image', 'video'].includes(file.kind);
  const duration = file.media?.duration ? formatDuration(file.media.duration) : null;

  return (
    <div
      className="file-card"
      data-selected={selected}
      style={{ animationDelay: `${Math.min(style?.delay || 0, 300)}ms` }}
      role="button"
      tabIndex={0}
      title={file.name}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return onToggle(file.id);
        if (e.shiftKey) return onToggle(file.id);
        if (file.status === 'ready') return onOpen(file);
        return onToggle(file.id);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(file);
      }}
      onContextMenu={(e) => onContextMenu(file, e)}
    >
      {file.status === 'ready' ? (
        <div className="file-card-thumb">
          <Thumbnail file={file} />
          {isMedia ? (
            <div className="thumb-overlay">
              <span className="thumb-play">
                <Play fill="currentColor" />
              </span>
            </div>
          ) : null}

          <div className="thumb-badges">
            {duration ? (
              <span className="thumb-badge">
                <Film style={{ width: 11, height: 11 }} /> {duration}
              </span>
            ) : null}
            {file.hevc ? (
              <span className="thumb-badge" data-accent="hevc" title="HEVC / H.265 video codec">
                HEVC
              </span>
            ) : null}
            {file.inTelegram ? (
              <span className="thumb-badge" data-accent="tg" title="Stored in your Telegram account">
                <Cloud style={{ width: 11, height: 11 }} /> TG
              </span>
            ) : null}
            {file.needsTranscode ? (
              <span className="thumb-badge" title={file.videoCompatibility?.reason || 'Needs a browser-compatible copy'}>
                <TriangleAlert style={{ width: 11, height: 11 }} /> {file.conversionStrategy === 'remux' ? 'MP4' : 'convert'}
              </span>
            ) : null}
          </div>

          <button
            className="checkbox thumb-check"
            data-checked={selected}
            aria-label={`Select ${file.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(file.id);
            }}
          >
            <Check />
          </button>

          {file.starred ? (
            <span className="thumb-star">
              <Star fill="currentColor" />
            </span>
          ) : null}

          <button
            className="thumb-menu"
            aria-label={`Actions for ${file.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onContextMenu(file, e, e.currentTarget);
            }}
          >
            <MoreVertical />
          </button>
        </div>
      ) : (
        <StatusOverlay file={file} />
      )}

      <div className="file-card-body">
        <div className="file-card-name">{file.name}</div>
        <div className="file-card-meta">
          <span style={{ color: KIND_COLOR[file.kind] || 'var(--muted)', fontWeight: 600 }}>{formatBytes(file.size)}</span>
          <span className="dot" />
          <span className="truncate">{formatDate(file.uploadedAt || file.createdAt)}</span>
        </div>
        {file.status === 'failed' ? <div className="tiny" style={{ color: 'var(--danger)' }}>Tap for options</div> : null}
      </div>
    </div>
  );
});

export function FileGrid({ files, folders = [], selection = [], onOpen, onOpenFolder, onToggle, onContextMenu }) {
  const selecting = selection.length > 0;
  return (
    <div className={clsx('drive', selecting && 'selecting')}>
      {folders.length ? (
        <div className="file-grid" style={{ marginBottom: 14 }}>
          {folders.map((folder) => (
            <FolderCard
              key={folder._id}
              folder={folder}
              selected={selection.includes(`folder:${folder._id}`)}
              onOpen={onOpenFolder}
              onToggle={onToggle}
              onContextMenu={(f, e) => onContextMenu(f, e, null, { isFolder: true })}
            />
          ))}
        </div>
      ) : null}
      <div className="file-grid">
        {files.map((file, index) => (
          <FileCard
            key={file.id}
            file={file}
            style={{ delay: index * 12 }}
            selected={selection.includes(file.id)}
            selecting={selecting}
            onOpen={onOpen}
            onToggle={onToggle}
            onContextMenu={(f, e, anchor) => onContextMenu(f, e, anchor)}
          />
        ))}
      </div>
    </div>
  );
}

export default FileGrid;
