/**
 * The drive page: one component renders every library view (folder, photos,
 * videos, audio, documents, starred, recent, trash, search). The URL decides
 * the view; `useDriveView` pushes it into the store and fetches.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AudioLines,
  Clapperboard,
  Clock,
  FileText,
  FolderPlus,
  HardDrive,
  Image as ImageIcon,
  Search as SearchIcon,
  Sparkles,
  Star,
  Trash2,
  Upload,
  Video,
} from 'lucide-react';
import Breadcrumbs from '../components/Breadcrumbs.jsx';
import SelectionBar from '../components/SelectionBar.jsx';
import FileGrid from '../components/FileGrid.jsx';
import FileList from '../components/FileList.jsx';
import { FileContextMenu, useMenuState } from '../components/FileMenu.jsx';
import { Menu, MenuItem, MenuSeparator } from '../components/Menu.jsx';
import { EmptyState, GridSkeleton, ListSkeleton, Spinner } from '../components/common.jsx';
import { useDriveView } from '../hooks/useDriveView.js';
import { useDrive } from '../store/drive.js';
import { useUi } from '../store/ui.js';
import { useAuth } from '../store/auth.js';
import { useFileActions } from '../hooks/useFileActions.js';
import { Files } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';

const VIEW_META = {
  folder: { title: 'My Drive', icon: HardDrive, empty: 'Drop files anywhere to store them in ZoZoCloud' },
  photos: { title: 'Photos', icon: ImageIcon, empty: 'No photos yet — upload some and thumbnails appear instantly' },
  videos: { title: 'Videos', icon: Video, empty: 'No videos yet — upload MP4, WebM, MKV or MOV files' },
  audio: { title: 'Audio', icon: AudioLines, empty: 'No audio files yet' },
  docs: { title: 'Documents', icon: FileText, empty: 'No documents yet' },
  starred: { title: 'Starred', icon: Star, empty: 'Star a file to keep it one click away' },
  recent: { title: 'Recent', icon: Clock, empty: 'Nothing recent yet' },
  trash: { title: 'Trash', icon: Trash2, empty: 'Trash is empty — deleted files rest here for 30 days' },
  search: { title: 'Search', icon: SearchIcon, empty: 'No matches' },
};

export function DrivePage({ view = 'folder' }) {
  const navigate = useNavigate();
  const { folderId = null } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const q = view === 'search' ? searchParams.get('q') || '' : '';
  const effectiveFolderId = view === 'folder' ? folderId : null;

  const { items, folders, loading, error, total, pages, folderPath } = useDriveView({
    view,
    folderId: effectiveFolderId,
    q,
  });

  const page = useDrive((s) => s.page);
  const limit = useDrive((s) => s.limit);
  const sort = useDrive((s) => s.sort);
  const order = useDrive((s) => s.order);
  const setParams = useDrive((s) => s.setParams);
  const selection = useDrive((s) => s.selection);
  const capabilities = useDrive((s) => s.capabilities);
  const stats = useDrive((s) => s.stats);
  const selectAllVisible = useDrive((s) => s.selectAllVisible);
  const toggleSelect = useDrive((s) => s.toggleSelect);
  const clearSelection = useDrive((s) => s.clearSelection);

  const user = useAuth((s) => s.user);
  const toast = useUi((s) => s.toast);
  const openDialog = useUi((s) => s.openDialog);
  const openPreview = useUi((s) => s.openPreview);
  const requestUpload = useUi((s) => s.requestUpload);
  const actions = useFileActions();

  const { menu, openMenu, closeMenu } = useMenuState();
  const [folderMenu, setFolderMenu] = useState({ open: false, anchor: null, folder: null });
  const [convertingAll, setConvertingAll] = useState(false);

  const uiView = user?.settings?.view === 'list' ? 'list' : 'grid';
  const meta = VIEW_META[view] || VIEW_META.folder;

  // Deep link from the upload dock: /drive?open=<fileId>
  useEffect(() => {
    const openId = searchParams.get('open');
    if (!openId) return;
    openPreview([openId], 0);
    const next = new URLSearchParams(searchParams);
    next.delete('open');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, openPreview]);

  const currentTitle = useMemo(() => {
    if (view !== 'folder') return meta.title;
    if (!effectiveFolderId) return 'My Drive';
    const last = String(folderPath || '').split('/').filter(Boolean).pop();
    return last || 'Folder';
  }, [view, effectiveFolderId, folderPath, meta.title]);

  const conversionCount = useMemo(() => items.filter((f) => f.needsTranscode).length, [items]);
  const canTranscode = !!capabilities?.media?.transcode;
  const totalSize = stats?.totalSize || 0;

  const onContextMenu = (target, event, anchor) => {
    event.preventDefault();
    const isFolder = target?.isFolder || (!!target?._id && !target?.kind);
    const rect = anchor || {
      getBoundingClientRect: () => ({
        left: event.clientX,
        right: event.clientX,
        top: event.clientY,
        bottom: event.clientY,
        width: 0,
        height: 0,
      }),
    };
    if (isFolder) {
      closeMenu();
      setFolderMenu({ open: true, anchor: rect, folder: target });
    } else {
      setFolderMenu((s) => ({ ...s, open: false }));
      openMenu(rect, target);
    }
  };

  const convertAll = async () => {
    const targets = items.filter((f) => f.needsTranscode);
    if (!targets.length) return;
    setConvertingAll(true);
    toast({ kind: 'info', title: `Converting ${targets.length} video(s)`, message: 'This runs in the background', timeout: 4000 });
    for (const file of targets) {
      await Files.transcode(file.id).catch((err) =>
        toast({ kind: 'error', title: `Could not convert ${file.name}`, message: err.message }),
      );
    }
    setConvertingAll(false);
  };

  const emptyAction =
    view === 'trash' ? null : (
      <button className="btn btn-primary" onClick={() => requestUpload('files')}>
        <Upload /> Upload files
      </button>
    );

  return (
    <div className="content-narrow">
      <Breadcrumbs view={view} folderId={effectiveFolderId} query={q} folderPath={folderPath} />

      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="page-title truncate">{view === 'search' && q ? `Results for “${q}”` : currentTitle}</h1>
          <p className="page-sub">
            {loading && !items.length
              ? 'Loading…'
              : `${total} item${total === 1 ? '' : 's'}${totalSize && view === 'folder' && !effectiveFolderId ? ` · ${formatBytes(totalSize)} in your cloud` : ''}${
                  view === 'trash' ? ' · restored or deleted for good' : ''
                }`}
          </p>
        </div>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {view === 'folder' && !selection.length ? (
            <button className="btn btn-outline" onClick={() => openDialog('newFolder', { parentId: effectiveFolderId })}>
              <FolderPlus /> New folder
            </button>
          ) : null}
          {view === 'trash' && items.length ? (
            <button
              className="btn btn-danger"
              onClick={() =>
                openDialog('confirm', {
                  title: 'Empty trash?',
                  message: `This permanently deletes all ${total} item(s) in the trash, including their copies in Telegram.`,
                  confirmLabel: 'Empty trash',
                  onConfirm: async () => {
                    await Files.emptyTrash();
                    const drive = useDrive.getState();
                    await Promise.all([drive.load({ force: true }), drive.loadStats()]);
                    toast({ kind: 'success', title: 'Trash emptied', timeout: 2800 });
                  },
                })
              }
            >
              <Trash2 /> Empty trash
            </button>
          ) : null}
          {view !== 'trash' ? (
            <button className="btn btn-primary" onClick={() => requestUpload('files')}>
              <Upload /> Upload
            </button>
          ) : null}
        </div>
      </div>

      {conversionCount && view !== 'trash' ? (
        <div className="callout callout-warn" style={{ marginBottom: 14 }}>
          <Clapperboard />
          <div style={{ flex: '1 1 260px' }}>
            <div className="callout-title">
              {conversionCount} video{conversionCount > 1 ? 's' : ''} need browser preparation
            </div>
            <p className="small" style={{ marginTop: 4 }}>
              ZoZoCloud checks the container, video codec and audio codec separately. Compatible H.264 streams are
              repackaged quickly; other codecs are converted and safely replace the old stored video.
            </p>
          </div>
          {canTranscode ? (
            <button className="btn btn-primary btn-sm" onClick={convertAll} disabled={convertingAll}>
              {convertingAll ? <Spinner size={14} /> : <Sparkles />} Convert all
            </button>
          ) : (
            <span className="badge badge-warn">ffmpeg not installed on this server</span>
          )}
        </div>
      ) : null}

      {selection.length ? <SelectionBar /> : null}

      {error ? (
        <div className="callout callout-danger" style={{ marginBottom: 14 }}>
          <div style={{ flex: '1 1 auto' }}>
            <div className="callout-title">{error}</div>
            <p className="small" style={{ marginTop: 4 }}>
              Check your connection — the cloud is still holding your files.
            </p>
          </div>
          <button className="btn btn-outline btn-sm" onClick={() => useDrive.getState().load({ force: true })}>
            Retry
          </button>
        </div>
      ) : null}

      {loading && !items.length && !folders.length ? (
        uiView === 'grid' ? (
          <GridSkeleton count={12} />
        ) : (
          <ListSkeleton count={10} />
        )
      ) : !items.length && !folders.length && !error ? (
        <EmptyState icon={meta.icon} title={view === 'search' && q ? `Nothing matches “${q}”` : meta.title === 'Trash' ? 'Trash is empty' : 'Nothing here yet'}>
          {view === 'search'
            ? 'Try a shorter query, or search by file type — “hevc”, “.mov”, “invoice”.'
            : meta.empty}
          {view === 'folder' && !effectiveFolderId && !capabilities?.storage?.telegram?.ready ? (
            <div className="row" style={{ gap: 8, marginTop: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-outline btn-sm" onClick={() => openDialog('telegram')}>
                <Sparkles /> Connect Telegram for unlimited storage
              </button>
            </div>
          ) : null}
          {emptyAction ? <div style={{ marginTop: 14 }}>{emptyAction}</div> : null}
        </EmptyState>
      ) : uiView === 'grid' ? (
        <FileGrid
          files={items}
          folders={folders}
          selection={selection}
          onOpen={(file) => actions.open(file, items)}
          onOpenFolder={(folder) => navigate(`/drive/f/${folder._id}`)}
          onToggle={toggleSelect}
          onContextMenu={onContextMenu}
        />
      ) : (
        <FileList
          files={items}
          folders={folders}
          selection={selection}
          sort={sort}
          order={order}
          onSort={(key) => {
            if (sort === key) setParams({ order: order === 'asc' ? 'desc' : 'asc' });
            else setParams({ sort: key, order: key === 'name' || key === 'kind' ? 'asc' : 'desc' });
          }}
          onOpen={(file) => actions.open(file, items)}
          onOpenFolder={(folder) => navigate(`/drive/f/${folder._id}`)}
          onToggle={toggleSelect}
          onToggleAll={selectAllVisible}
          onContextMenu={onContextMenu}
        />
      )}

      {pages > 1 ? (
        <div className="toolbar" style={{ justifyContent: 'center', marginTop: 22 }}>
          <button className="btn btn-outline btn-sm" disabled={page <= 1} onClick={() => setParams({ page: page - 1 })}>
            Previous
          </button>
          <span className="hint">
            Page {page} of {pages} · {items.length} shown · {total} total
          </span>
          <button className="btn btn-outline btn-sm" disabled={page >= pages} onClick={() => setParams({ page: page + 1 })}>
            Next
          </button>
          <select
            className="select"
            style={{ width: 'auto' }}
            value={limit}
            onChange={(e) => setParams({ limit: Number(e.target.value), page: 1 })}
            aria-label="Items per page"
          >
            {[30, 60, 120, 240].map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <FileContextMenu open={menu.open} anchor={menu.anchor} files={menu.files} onClose={closeMenu} />

      <Menu open={folderMenu.open} anchor={folderMenu.anchor} onClose={() => setFolderMenu((s) => ({ ...s, open: false }))}>
        {folderMenu.folder ? (
          <>
            <MenuItem
              onClick={() => navigate(`/drive/f/${folderMenu.folder._id}`)}
              onClose={() => setFolderMenu((s) => ({ ...s, open: false }))}
            >
              Open folder
            </MenuItem>
            <MenuItem
              onClick={() => {
                openDialog('renameFolder', { folder: { ...folderMenu.folder, id: folderMenu.folder._id } });
                setFolderMenu((s) => ({ ...s, open: false }));
              }}
            >
              Rename
            </MenuItem>
            <MenuItem
              onClick={() => {
                openDialog('newFolder', { parentId: folderMenu.folder._id });
                setFolderMenu((s) => ({ ...s, open: false }));
              }}
            >
              New subfolder
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              onClick={async () => {
                setFolderMenu((s) => ({ ...s, open: false }));
                openDialog('confirm', {
                  title: `Move “${folderMenu.folder.name}” to Trash?`,
                  message: 'Everything inside it is moved to Trash too. You can restore it later.',
                  confirmLabel: 'Move to Trash',
                  onConfirm: async () => {
                    await actions.trash([], [folderMenu.folder._id]);
                    clearSelection();
                  },
                });
              }}
            >
              Move to Trash
            </MenuItem>
          </>
        ) : null}
      </Menu>
    </div>
  );
}

export default DrivePage;
