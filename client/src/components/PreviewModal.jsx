/**
 * Full-screen preview overlay: images, video (with the HEVC → H.264 path),
 * audio, PDF, text and a details panel. `MediaStage` is exported so the public
 * share page can render exactly the same viewer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Download,
  FileQuestion,
  Image as ImageIcon,
  Info,
  Link2,
  MoreVertical,
  Music,
  Paperclip,
  Star,
  X,
} from 'lucide-react';
import { Files, getToken, urls } from '../lib/api.js';
import { useUi } from '../store/ui.js';
import { useDrive } from '../store/drive.js';
import { useFileActions } from '../hooks/useFileActions.js';
import { useFileMenuItems } from './FileMenu.jsx';
import { Menu, MenuItem, MenuSeparator } from './Menu.jsx';
import { Spinner } from './common.jsx';
import VideoStage from './VideoStage.jsx';
import { FileIcon } from './FileIcon.jsx';
import { formatBytes, formatDate, formatDateTime, formatDuration } from '../lib/format.js';

/* ── Stage (shared with the public share page) ───────────────────────────── */

export function MediaStage({ doc, src, onConvert, onDownload, canConvert = true, publicMode = false }) {
  const [zoomed, setZoomed] = useState(false);
  const [text, setText] = useState(null);
  const [textError, setTextError] = useState(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setZoomed(false);
    setText(null);
    setTextError(null);
    setBroken(false);
  }, [doc?.id]);

  useEffect(() => {
    let alive = true;
    if (doc?.previewKind !== 'text') return undefined;
    (async () => {
      try {
        if (!publicMode) {
          const result = await Files.text(doc.id);
          if (alive) setText(result.text ?? result.content ?? '');
        } else {
          const { data } = await axios.get(src.stream, { responseType: 'text', transformResponse: [(d) => d] });
          if (alive) setText(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
        }
      } catch (err) {
        if (alive) setTextError(err?.response?.data?.error || err.message || 'Could not load the text preview');
      }
    })();
    return () => {
      alive = false;
    };
  }, [doc?.id, doc?.previewKind, publicMode, src.stream]);

  if (!doc) return null;
  const kind = broken && doc.previewKind === 'image' ? 'download' : doc.previewKind;

  switch (kind) {
    case 'video':
    case 'video-transcode':
      return publicMode ? (
        doc.previewKind === 'video' ? (
          <video className="preview-video" src={src.stream} poster={src.thumbnail} controls autoPlay playsInline preload="metadata" />
        ) : (
          <div className="hevc-banner">
            <Clapperboard />
            <div style={{ flex: '1 1 240px' }}>
              <div className="callout-title" style={{ fontSize: 13.5 }}>HEVC video — browsers cannot play this directly</div>
              <p className="small" style={{ marginTop: 5, color: 'var(--text-soft)' }}>
                The owner can convert it to H.264 in one click. Meanwhile you can download it and play it in any player
                (VLC, QuickTime, Infuse).
              </p>
              <a className="btn btn-primary btn-sm" style={{ marginTop: 12 }} href={src.download || src.stream} download>
                <Download /> Download {formatBytes(doc.size || 0)}
              </a>
            </div>
          </div>
        )
      ) : (
        <VideoStage file={doc} onConvert={onConvert} onDownload={onDownload} />
      );

    case 'image':
      return (
        <div className="preview-image-wrap">
          <img
            className="preview-image"
            src={src.stream}
            alt={doc.name}
            data-zoomed={zoomed}
            onClick={() => setZoomed((z) => !z)}
            onError={() => setBroken(true)}
          />
        </div>
      );

    case 'image-preview':
      return (
        <div className="preview-image-wrap">
          <img
            className="preview-image"
            src={src.preview || src.stream}
            alt={doc.name}
            data-zoomed={zoomed}
            onClick={() => setZoomed((z) => !z)}
            onError={() => setBroken(true)}
          />
          <span className="badge badge-violet" style={{ position: 'absolute', bottom: 10, left: 10 }}>
            Web preview · original is {doc.name.split('.').pop()?.toUpperCase()}
          </span>
        </div>
      );

    case 'heic':
      return (
        <div className="preview-image-wrap" style={{ flexDirection: 'column', gap: 14 }}>
          {doc.hasThumb ? (
            <img className="preview-image" src={src.thumbnail} alt={doc.name} style={{ cursor: 'default' }} />
          ) : null}
          <div className="callout callout-brand" style={{ maxWidth: 520 }}>
            <div className="callout-title">
              <ImageIcon /> HEIC image
            </div>
            <p className="small" style={{ marginTop: 6 }}>
              This is Apple's HEIC format. Above is the generated web preview — download the original for full quality.
            </p>
          </div>
        </div>
      );

    case 'audio':
      return (
        <div className="preview-audio-card">
          {doc.hasThumb ? (
            <img className="preview-audio-art" src={src.thumbnail} alt="" />
          ) : (
            <span className="preview-audio-art-fallback">
              <Music />
            </span>
          )}
          <div>
            <div className="preview-title">{doc.name}</div>
            <div className="hint" style={{ marginTop: 4 }}>
              {[doc.media?.artist, doc.media?.album, doc.durationText || (doc.media?.duration ? formatDuration(doc.media.duration) : null)]
                .filter(Boolean)
                .join(' · ') || formatBytes(doc.size || 0)}
            </div>
          </div>
          <audio controls autoPlay src={src.stream} style={{ width: '100%' }} preload="metadata" />
        </div>
      );

    case 'pdf':
      return <iframe className="preview-pdf" src={src.stream} title={doc.name} />;

    case 'text':
      return textError ? (
        <div className="callout callout-danger" style={{ maxWidth: 560 }}>
          <div className="callout-title">
            <FileQuestion /> {textError}
          </div>
        </div>
      ) : text === null ? (
        <div className="row center" style={{ gap: 10, color: 'var(--muted)' }}>
          <Spinner /> Loading text…
        </div>
      ) : (
        <pre className="preview-text">{text || '(empty file)'}</pre>
      );

    case 'pending':
      return (
        <div className="callout callout-brand" style={{ maxWidth: 520 }}>
          <div className="callout-title">
            <Spinner /> Still processing
          </div>
          <p className="small" style={{ marginTop: 6 }}>
            We are generating thumbnails and probing the media. This usually takes a few seconds — the preview will
            appear automatically.
          </p>
        </div>
      );

    case 'office':
      return (
        <div className="preview-audio-card">
          <span className="preview-audio-art-fallback">
            <FileIcon file={doc} size={54} />
          </span>
          <div>
            <div className="preview-title">{doc.name}</div>
            <div className="hint" style={{ marginTop: 4 }}>
              Office documents preview in their own app — download to open it.
            </div>
          </div>
          <a className="btn btn-primary" href={src.download || src.stream} download>
            <Download /> Download {formatBytes(doc.size || 0)}
          </a>
        </div>
      );

    default:
      return (
        <div className="preview-audio-card">
          <span className="preview-audio-art-fallback">
            <FileIcon file={doc} size={54} />
          </span>
          <div>
            <div className="preview-title">{doc.name}</div>
            <div className="hint" style={{ marginTop: 4 }}>
              No in-browser preview for this format ({doc.mime || 'unknown type'}) — the file is stored safely in your
              cloud.
            </div>
          </div>
          <a className="btn btn-primary" href={src.download || src.stream} download>
            <Download /> Download {formatBytes(doc.size || 0)}
          </a>
          {canConvert && doc.kind === 'video' && onConvert ? (
            <button className="btn btn-outline btn-sm" onClick={() => onConvert(doc)}>
              <Clapperboard /> Convert to MP4 (H.264)
            </button>
          ) : null}
        </div>
      );
  }
}

/* ── Details panel ───────────────────────────────────────────────────────── */

function DetailRows({ doc }) {
  const media = doc.media || {};
  const rows = [
    ['Type', doc.kind ? doc.kind[0].toUpperCase() + doc.kind.slice(1) : '—'],
    ['Size', formatBytes(doc.size || 0)],
    media.width && media.height ? ['Dimensions', `${media.width} × ${media.height}`] : null,
    media.duration ? ['Duration', formatDuration(media.duration)] : null,
    media.vcodec ? ['Video codec', media.vcodec] : null,
    media.acodec ? ['Audio codec', media.acodec] : null,
    media.fps ? ['Frame rate', `${Math.round(media.fps * 10) / 10} fps`] : null,
    media.bitrate ? ['Bitrate', `${Math.round(media.bitrate / 1000)} kbps`] : null,
    media.codecTag ? ['Codec tag', media.codecTag] : null,
    media.pixFmt ? ['Pixel format', media.pixFmt] : null,
    media.channels ? ['Audio channels', String(media.channels)] : null,
    doc.mime ? ['MIME', doc.mime] : null,
    ['Added', formatDateTime(doc.createdAt)],
    doc.updatedAt ? ['Updated', formatDate(doc.updatedAt)] : null,
    doc.folderPath ? ['Folder', doc.folderPath] : null,
    ['Stored in', doc.inTelegram ? 'ZoZoCloud (Telegram backend)' : doc.provider === 'local' ? 'Local disk' : doc.provider || '—'],
    doc.telegramMessageId ? ['Telegram message', String(doc.telegramMessageId)] : null,
    doc.downloadCount ? ['Downloads', String(doc.downloadCount)] : null,
    doc.derivedFrom ? ['Converted from', doc.derivedFrom] : null,
  ].filter(Boolean);

  return (
    <dl className="kv">
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt>{label}</dt>
          <dd className="mono" title={String(value)}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ── Private preview modal ───────────────────────────────────────────────── */

export function PreviewModal() {
  const preview = useUi((s) => s.preview);
  const close = useUi((s) => s.closePreview);
  const next = useUi((s) => s.previewNext);
  const prev = useUi((s) => s.previewPrev);
  const toast = useUi((s) => s.toast);
  const items = useDrive((s) => s.items);
  const actions = useFileActions();

  const [fetched, setFetched] = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreAnchor = useRef(null);

  const id = preview?.ids?.[preview.index] || null;
  const cached = useMemo(() => (id ? items.find((f) => f.id === id) || null : null), [items, id]);
  const hasCached = !!cached;

  useEffect(() => {
    let alive = true;
    setFetched(null);
    setFetchError(null);
    if (!id || hasCached) return undefined;
    Files.get(id)
      .then((doc) => alive && setFetched(doc))
      .catch((err) => alive && setFetchError(err.message));
    return () => {
      alive = false;
    };
  }, [id, hasCached]);

  const doc = cached || fetched;

  const onKeyDown = useCallback(
    (e) => {
      if (!preview) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
      } else if (e.key === 'i' || e.key === 'I') {
        setInfoOpen((v) => !v);
      } else if ((e.key === 'd' || e.key === 'D') && doc && !e.metaKey && !e.ctrlKey) {
        actions.download(doc);
      }
    },
    [preview, close, next, prev, doc, actions],
  );

  useEffect(() => {
    if (!preview) return undefined;
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [preview, onKeyDown]);

  const menuItems = useFileMenuItems(doc ? [doc] : [], { onClose: () => setMoreOpen(false) });

  if (!preview) return null;

  const src = doc
    ? {
        stream: urls.stream(doc.id, getToken()),
        thumbnail: doc.hasThumb ? urls.thumbnail(doc.id, getToken()) : null,
        preview: doc.hasPreviewRendition ? urls.preview(doc.id, getToken()) : null,
        download: urls.download(doc.id, getToken()),
      }
    : {};

  const total = preview.ids.length;

  return (
    <div
      className="preview-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="preview-head">
        <span style={{ display: 'grid', placeItems: 'center', flex: 'none' }}>
          {doc ? <FileIcon file={doc} size={19} /> : <Paperclip size={19} />}
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="preview-title truncate">{doc?.name || 'Loading…'}</div>
          <div className="tiny faint truncate" style={{ marginTop: 2 }}>
            {doc
              ? [
                  formatBytes(doc.size || 0),
                  doc.durationText,
                  doc.media?.width ? `${doc.media.width}×${doc.media.height}` : null,
                  doc.inTelegram ? 'in Telegram' : 'local',
                ]
                  .filter(Boolean)
                  .join(' · ')
              : fetchError || 'Fetching details…'}
          </div>
        </div>

        {doc?.hevc ? <span className="badge badge-violet">HEVC</span> : null}
        {doc?.needsTranscode ? <span className="badge badge-warn">Needs convert</span> : null}

        <div className="preview-actions">
          {total > 1 ? (
            <span className="tiny faint">
              {preview.index + 1} / {total}
            </span>
          ) : null}

          {doc ? (
            <>
              <button
                className="btn btn-ghost btn-icon btn-sm"
                title={doc.starred ? 'Remove star' : 'Add star'}
                onClick={() => actions.star([doc], !doc.starred)}
              >
                <Star fill={doc.starred ? 'currentColor' : 'none'} />
              </button>
              <button className="btn btn-ghost btn-icon btn-sm" title="Download (D)" onClick={() => actions.download(doc)}>
                <Download />
              </button>
              <button className="btn btn-ghost btn-icon btn-sm" title="Copy share link" onClick={() => actions.copyLink(doc)}>
                <Link2 />
              </button>
              {doc.kind === 'video' ? (
                <button className="btn btn-ghost btn-icon btn-sm" title="Convert to H.264 MP4" onClick={() => actions.transcode(doc)}>
                  <Clapperboard />
                </button>
              ) : null}
              <button
                className="btn btn-ghost btn-icon btn-sm"
                title="Details (I)"
                data-active={infoOpen}
                onClick={() => setInfoOpen((v) => !v)}
              >
                <Info />
              </button>
              <button className="btn btn-ghost btn-icon btn-sm" ref={moreAnchor} title="More" onClick={() => setMoreOpen((v) => !v)}>
                <MoreVertical />
              </button>
            </>
          ) : null}

          <button className="btn btn-ghost btn-icon btn-sm" title="Close (Esc)" onClick={close}>
            <X />
          </button>
        </div>
      </div>

      <div className="preview-body">
        <div className="preview-stage">
          {!doc ? (
            fetchError ? (
              <div className="callout callout-danger" style={{ maxWidth: 480 }}>
                <div className="callout-title">
                  <FileQuestion /> {fetchError}
                </div>
              </div>
            ) : (
              <div className="row center" style={{ gap: 10, color: 'var(--muted)' }}>
                <Spinner /> Loading preview…
              </div>
            )
          ) : (
            <MediaStage doc={doc} src={src} onConvert={(f) => actions.transcode(f)} onDownload={(f) => actions.download(f)} />
          )}

          {total > 1 ? (
            <>
              <button className="preview-nav preview-nav-prev" onClick={prev} aria-label="Previous file">
                <ChevronLeft />
              </button>
              <button className="preview-nav preview-nav-next" onClick={next} aria-label="Next file">
                <ChevronRight />
              </button>
            </>
          ) : null}
        </div>

        {infoOpen && doc ? (
          <aside className="preview-side">
            <div className="row-between" style={{ marginBottom: 12 }}>
              <h4 className="panel-title">Details</h4>
              <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setInfoOpen(false)} aria-label="Hide details">
                <X />
              </button>
            </div>
            {doc.hasThumb ? (
              <img
                src={src.thumbnail}
                alt=""
                style={{ width: '100%', borderRadius: 12, marginBottom: 14, border: '1px solid var(--line)' }}
              />
            ) : null}
            <DetailRows doc={doc} />
            <div className="row" style={{ gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              <button className="btn btn-outline btn-sm" onClick={() => actions.share(doc)}>
                <Link2 /> Share
              </button>
              <button className="btn btn-outline btn-sm" onClick={() => actions.rename(doc)}>
                Rename
              </button>
              <button className="btn btn-outline btn-sm" onClick={() => actions.move([doc])}>
                Move
              </button>
              <button className="btn btn-ghost btn-sm danger" onClick={() => actions.trash([doc])}>
                Trash
              </button>
            </div>
            {doc.status === 'failed' && doc.error ? (
              <div className="callout callout-danger" style={{ marginTop: 14 }}>
                <div className="callout-title">Upload failed</div>
                <p className="small" style={{ marginTop: 5 }}>
                  {doc.error}
                </p>
                <button className="btn btn-outline btn-sm" style={{ marginTop: 10 }} onClick={() => actions.retry(doc)}>
                  Retry
                </button>
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>

      <Menu open={moreOpen} anchor={moreAnchor.current} onClose={() => setMoreOpen(false)} width={240}>
        {menuItems.map((item, i) =>
          item.sep ? (
            // eslint-disable-next-line react/no-array-index-key
            <MenuSeparator key={`sep-${i}`} />
          ) : (
            <MenuItem
              // eslint-disable-next-line react/no-array-index-key
              key={`${item.label}-${i}`}
              icon={item.icon}
              danger={item.danger}
              shortcut={item.shortcut}
              onClick={() => {
                item.onClick?.();
                setMoreOpen(false);
                if (['Move to Trash', 'Delete forever'].includes(item.label)) close();
              }}
              onClose={() => setMoreOpen(false)}
            >
              {item.label}
            </MenuItem>
          ),
        )}
      </Menu>
    </div>
  );
}

export default PreviewModal;
