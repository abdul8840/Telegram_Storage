/** List view: dense, sortable table of files and folders. */
import { memo } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Check, Cloud, Folder as FolderIcon, MoreVertical, Star, TriangleAlert } from 'lucide-react';
import { FileIcon, Thumbnail } from './FileIcon.jsx';
import { Progress } from './common.jsx';
import { KIND_COLOR, KIND_LABEL, formatBytes, formatDate } from '../lib/format.js';

const COLUMNS = [
  { key: 'name', label: 'Name', className: '' },
  { key: 'size', label: 'Size', className: 'list-col-size' },
  { key: 'kind', label: 'Type', className: 'list-col-kind' },
  { key: 'createdAt', label: 'Added', className: 'list-col-date' },
];

export function ListHeader({ sort, order, onSort, onToggleAll, allSelected }) {
  return (
    <div className="list-head">
      <button className="checkbox" data-checked={allSelected} onClick={onToggleAll} aria-label="Select all">
        <Check />
      </button>
      {COLUMNS.map((col) => (
        <button key={col.key} onClick={() => onSort(col.key)} className={col.className} style={{ justifyContent: 'flex-start' }}>
          {col.label}
          {sort === col.key ? order === 'asc' ? <ArrowUp /> : <ArrowDown /> : null}
        </button>
      ))}
      <span />
    </div>
  );
}

export const FileRow = memo(function FileRow({ file, selected, onOpen, onToggle, onContextMenu, index }) {
  const failing = file.status === 'failed';
  return (
    <div
      className="list-row"
      data-selected={selected}
      style={{ animationDelay: `${Math.min(index * 8, 240)}ms` }}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return onToggle(file.id);
        if (file.status === 'ready') return onOpen(file);
        return onToggle(file.id);
      }}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(file)}
      onContextMenu={(e) => onContextMenu(file, e)}
    >
      <button
        className="checkbox"
        data-checked={selected}
        aria-label={`Select ${file.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(file.id);
        }}
      >
        <Check />
      </button>

      <div className="list-name">
        {file.hasThumb ? (
          <img className="list-thumb" src={file.thumbUrl} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className="list-thumb-fallback">
            <FileIcon file={file} />
          </span>
        )}
        <div style={{ minWidth: 0 }}>
          <div className="truncate" style={{ fontSize: 13.2, fontWeight: 550 }}>
            {file.name}
            {file.starred ? <Star size={12} style={{ display: 'inline', marginLeft: 6, color: 'var(--warn)' }} fill="currentColor" /> : null}
          </div>
          <div className="tiny muted truncate list-meta-mobile" style={{ display: 'none' }}>
            {formatBytes(file.size)} · {KIND_LABEL[file.kind] || file.kind} · {formatDate(file.uploadedAt || file.createdAt)}
          </div>
          {file.media?.width ? (
            <div className="tiny faint truncate" style={{ marginTop: 1 }}>
              {file.media.width}×{file.media.height}
              {file.media.vcodec ? ` · ${file.media.vcodec.toUpperCase()}` : ''}
              {file.media.duration ? ` · ${Math.round(file.media.duration)}s` : ''}
            </div>
          ) : null}
        </div>
      </div>

      <div className="list-meta list-col-size">{formatBytes(file.size)}</div>
      <div className="list-meta list-col-kind" style={{ color: KIND_COLOR[file.kind] }}>
        {KIND_LABEL[file.kind] || file.kind}
      </div>
      <div className="list-meta list-col-date">{formatDate(file.uploadedAt || file.createdAt)}</div>

      <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
        {failing ? <TriangleAlert size={14} style={{ color: 'var(--danger)' }} /> : null}
        {file.inTelegram ? <Cloud size={13} style={{ color: 'var(--brand)', opacity: 0.8 }} /> : null}
        <button
          className="btn btn-ghost btn-icon btn-sm"
          aria-label={`Actions for ${file.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onContextMenu(file, e, e.currentTarget);
          }}
        >
          <MoreVertical size={15} />
        </button>
      </div>

      {['processing', 'uploading', 'assembling'].includes(file.status) ? (
        <div style={{ gridColumn: '1 / -1', marginTop: -2 }}>
          <Progress percent={file.progress || 0} thin />
        </div>
      ) : null}
    </div>
  );
});

export function FileList({ files, folders = [], selection = [], sort, order, onSort, onOpen, onOpenFolder, onToggle, onToggleAll, onContextMenu }) {
  const allIds = [...folders.map((f) => `folder:${f._id}`), ...files.map((f) => f.id)];
  const allSelected = allIds.length > 0 && allIds.every((id) => selection.includes(id));

  return (
    <div className={clsx('drive', selection.length > 0 && 'selecting')}>
      <ListHeader sort={sort} order={order} onSort={onSort} onToggleAll={onToggleAll} allSelected={allSelected} />
      <div className="file-list">
        {folders.map((folder, index) => (
          <div
            className="list-row"
            key={folder._id}
            data-selected={selection.includes(`folder:${folder._id}`)}
            style={{ animationDelay: `${index * 8}ms` }}
            role="button"
            tabIndex={0}
            onClick={(e) => (e.metaKey || e.ctrlKey ? onToggle(`folder:${folder._id}`) : onOpenFolder(folder))}
            onKeyDown={(e) => e.key === 'Enter' && onOpenFolder(folder)}
            onContextMenu={(e) => onContextMenu({ ...folder, isFolder: true }, e)}
          >
            <button
              className="checkbox"
              data-checked={selection.includes(`folder:${folder._id}`)}
              aria-label={`Select ${folder.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggle(`folder:${folder._id}`);
              }}
            >
              <Check />
            </button>
            <div className="list-name">
              <span className="list-thumb-fallback">
                <FolderIcon />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="truncate" style={{ fontSize: 13.2, fontWeight: 600 }}>
                  {folder.name}
                </div>
                <div className="tiny faint">Folder</div>
              </div>
            </div>
            <div className="list-meta list-col-size">—</div>
            <div className="list-meta list-col-kind">Folder</div>
            <div className="list-meta list-col-date">{formatDate(folder.createdAt)}</div>
            <button
              className="btn btn-ghost btn-icon btn-sm"
              aria-label={`Actions for ${folder.name}`}
              style={{ justifySelf: 'end' }}
              onClick={(e) => {
                e.stopPropagation();
                onContextMenu({ ...folder, isFolder: true }, e, e.currentTarget);
              }}
            >
              <MoreVertical size={15} />
            </button>
          </div>
        ))}

        {files.map((file, index) => (
          <FileRow
            key={file.id}
            file={file}
            index={index}
            selected={selection.includes(file.id)}
            onOpen={onOpen}
            onToggle={onToggle}
            onContextMenu={(f, e, anchor) => onContextMenu(f, e, anchor)}
          />
        ))}
      </div>
    </div>
  );
}

export default FileList;
