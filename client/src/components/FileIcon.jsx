/** File-kind icons and blur-up thumbnails (LQIP → real image). */
import { useState } from 'react';
import clsx from 'clsx';
import {
  Archive,
  File as FileIconGeneric,
  FileCode2,
  FileText,
  Film,
  Folder,
  Image as ImageIcon,
  Music,
  Presentation,
  Sheet,
  FileSpreadsheet,
} from 'lucide-react';
import { KIND_COLOR, extLabel } from '../lib/format.js';
import { urls } from '../lib/api.js';

const DOC_EXTS = {
  pdf: FileText,
  doc: FileText,
  docx: FileText,
  rtf: FileText,
  epub: FileText,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  csv: Sheet,
  numbers: Sheet,
  ppt: Presentation,
  pptx: Presentation,
  key: Presentation,
};

export function iconForFile(file) {
  const ext = String(file?.name || '').split('.').pop()?.toLowerCase();
  if (file?.isFolder) return Folder;
  if (DOC_EXTS[ext]) return DOC_EXTS[ext];
  switch (file?.kind) {
    case 'image':
      return ImageIcon;
    case 'video':
      return Film;
    case 'audio':
      return Music;
    case 'archive':
      return Archive;
    case 'text':
      return FileCode2;
    case 'doc':
      return FileText;
    default:
      return FileIconGeneric;
  }
}

export function FileIcon({ file, size = 18, color }) {
  const Icon = iconForFile(file);
  return <Icon size={size} style={{ color: color || KIND_COLOR[file?.kind] || 'var(--muted)' }} aria-hidden />;
}

/**
 * Thumbnail with an instant blur-up placeholder (a ~24px JPEG inlined in the
 * file document) so grids paint immediately even on slow links.
 */
export function Thumbnail({ file, className, rounded = false, size = 'card' }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  const thumbUrl = file?.hasThumb ? urls.thumbnail(file.id) : null;
  // Small images without a generated thumb can be shown directly.
  const directUrl = !thumbUrl && file?.kind === 'image' && file?.size < 8 * 1024 * 1024 && file?.status === 'ready' ? urls.stream(file.id) : null;
  const src = thumbUrl || directUrl;

  const style = {
    backgroundImage: file?.lqip ? `url(${file.lqip})` : undefined,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
  };

  if (!src || failed) {
    return (
      <div className={clsx('thumb-fallback', className)} style={{ ...style, borderRadius: rounded ? 'var(--radius-sm)' : undefined }}>
        <FileIcon file={file} size={size === 'row' ? 17 : 34} />
      </div>
    );
  }

  return (
    <div className={clsx(className)} style={{ ...style, width: '100%', height: '100%', position: 'relative' }}>
      <img
        src={src}
        alt={file?.name || ''}
        loading="lazy"
        decoding="async"
        data-loading={!loaded}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        style={{ position: 'absolute', inset: 0, opacity: loaded ? 1 : 0 }}
      />
    </div>
  );
}

/** Small square label for documents without a thumbnail (e.g. "PDF"). */
export function ExtTag({ file }) {
  return <span className="thumb-badge">{extLabel(file?.name || '')}</span>;
}

export default { FileIcon, Thumbnail, iconForFile, ExtTag };
