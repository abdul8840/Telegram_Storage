/**
 * The authenticated shell: sidebar, top bar, routed page, upload dock,
 * drag & drop, preview overlay, dialogs, toasts and the live SSE stream.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Film,
  FolderUp,
  HardDrive,
  Image as ImageIcon,
  Link2,
  Search as SearchIcon,
  Star,
} from 'lucide-react';
import Sidebar from './Sidebar.jsx';
import TopBar from './TopBar.jsx';
import UploadDock from './UploadDock.jsx';
import DropZone from './DropZone.jsx';
import PreviewModal from './PreviewModal.jsx';
import DialogHost from './dialogs.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import { Toasts } from './common.jsx';
import { Menu, MenuItem, MenuSeparator } from './Menu.jsx';
import { useEvents } from '../hooks/useEvents.js';
import { useHotkeys } from '../hooks/useHotkeys.js';
import { useDrive } from '../store/drive.js';
import { useUi } from '../store/ui.js';
import { useUploads } from '../store/uploads.js';
import { useFileActions } from '../hooks/useFileActions.js';
import { readDirectoryFileList } from '../lib/dropFiles.js';

const MOBILE_NAV = [
  { to: '/drive', label: 'Drive', icon: HardDrive, match: (p) => p.startsWith('/drive') },
  { to: '/photos', label: 'Photos', icon: ImageIcon, match: (p) => p === '/photos' },
  { to: '/videos', label: 'Videos', icon: Film, match: (p) => p === '/videos' },
  { to: '/shared', label: 'Shared', icon: Link2, match: (p) => p === '/shared' },
  { to: '/starred', label: 'Starred', icon: Star, match: (p) => p === '/starred' },
  { to: '/search', label: 'Search', icon: SearchIcon, match: (p) => p === '/search' },
];

function MobileNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return (
    <nav className="mobile-nav" aria-label="Quick navigation">
      {MOBILE_NAV.map((item) => (
        <button key={item.to} data-active={item.match(pathname)} onClick={() => navigate(item.to)}>
          <item.icon />
          {item.label}
        </button>
      ))}
    </nav>
  );
}

export function AppShell() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const fileInput = useRef(null);
  const folderInput = useRef(null);
  const pendingFolder = useRef(null);

  const [folderMenu, setFolderMenu] = useState({ open: false, anchor: null, node: null });

  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const uploadRequest = useUi((s) => s.uploadRequest);
  const clearUploadRequest = useUi((s) => s.clearUploadRequest);
  const openDialog = useUi((s) => s.openDialog);
  const toast = useUi((s) => s.toast);
  const previewOpen = useUi((s) => !!s.preview);
  const dialogOpen = useUi((s) => !!s.dialog);
  const actions = useFileActions();

  const currentFolderId = pathname.startsWith('/drive/f/') ? pathname.slice('/drive/f/'.length) : null;

  // Live progress + library updates over SSE.
  useEvents(true);

  useEffect(() => {
    useUploads.getState().init();
    const drive = useDrive.getState();
    drive.loadFolders();
    drive.loadStats();
    drive.loadCapabilities();
  }, []);

  // Any component can ask for the file picker through the ui store.
  useEffect(() => {
    if (!uploadRequest) return;
    const input = uploadRequest.kind === 'folder' ? folderInput.current : fileInput.current;
    input?.click();
    clearUploadRequest();
  }, [uploadRequest, clearUploadRequest]);

  const enqueue = useCallback(
    async (entries) => {
      const list = Array.from(entries || []);
      if (!list.length) return;
      const payload = list.map((item) =>
        item.file
          ? item
          : { file: item, path: item.webkitRelativePath ? item.webkitRelativePath : undefined },
      );
      const hasPaths = payload.some((p) => p.path && p.path.includes('/'));
      const targetFolderId = hasPaths ? null : pendingFolder.current ?? currentFolderId;
      pendingFolder.current = null;
      setSidebarOpen(false);
      await useUploads.getState().add(payload, { folderId: targetFolderId });
      toast({
        kind: 'info',
        title: `Uploading ${payload.length} file${payload.length > 1 ? 's' : ''}`,
        message: hasPaths
          ? 'Folder structure will be recreated in your drive'
          : targetFolderId
            ? 'Into the selected folder'
            : 'Into My Drive',
        timeout: 3600,
      });
    },
    [currentFolderId, toast, setSidebarOpen],
  );

  const trashSelection = useCallback(() => {
    const drive = useDrive.getState();
    if (!drive.selection.length) return;
    actions.trash(drive.selectedFiles(), drive.selectedFolderIds());
    drive.clearSelection();
  }, [actions]);

  const hotkeys = useMemo(
    () => ({
      '/': () => document.getElementById('global-search')?.focus(),
      u: () => fileInput.current?.click(),
      'mod+shift+u': () => folderInput.current?.click(),
      'mod+shift+f': () => openDialog('newFolder', { parentId: currentFolderId }),
      'mod+a': () => useDrive.getState().selectAllVisible(),
      escape: () => {
        if (previewOpen || dialogOpen) return;
        const drive = useDrive.getState();
        if (drive.selection.length) drive.clearSelection();
        else if (pathname === '/search') navigate('/drive');
      },
      backspace: () => {
        if (previewOpen || dialogOpen) return;
        trashSelection();
      },
    }),
    [openDialog, currentFolderId, previewOpen, dialogOpen, pathname, navigate, trashSelection],
  );

  useHotkeys(hotkeys, { enabled: !previewOpen });

  const closeFolderMenu = () => setFolderMenu((s) => ({ ...s, open: false }));

  return (
    <div className="app-shell">
      <Sidebar
        onClose={() => setSidebarOpen(false)}
        onFolderContextMenu={(node, event) => {
          event.preventDefault();
          setFolderMenu({
            open: true,
            node,
            anchor: {
              getBoundingClientRect: () => ({
                left: event.clientX,
                right: event.clientX,
                top: event.clientY,
                bottom: event.clientY,
                width: 0,
                height: 0,
              }),
            },
          });
        }}
      />

      {sidebarOpen ? (
        <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <TopBar onOpenSidebar={() => setSidebarOpen(true)} />
        <main className="content">
          <ErrorBoundary key={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <MobileNav />
      <UploadDock />
      <DropZone onFiles={enqueue} enabled={!previewOpen && !dialogOpen} />
      <PreviewModal />
      <DialogHost />
      <Toasts />

      <Menu open={folderMenu.open} anchor={folderMenu.anchor} onClose={closeFolderMenu}>
        {folderMenu.node ? (
          <>
            <MenuItem onClick={() => navigate(`/drive/f/${folderMenu.node._id}`)} onClose={closeFolderMenu}>
              Open folder
            </MenuItem>
            <MenuItem
              onClick={() => openDialog('renameFolder', { folder: { ...folderMenu.node, id: folderMenu.node._id } })}
              onClose={closeFolderMenu}
            >
              Rename
            </MenuItem>
            <MenuItem onClick={() => openDialog('newFolder', { parentId: folderMenu.node._id })} onClose={closeFolderMenu}>
              New subfolder
            </MenuItem>
            <MenuItem
              icon={FolderUp}
              onClick={() => {
                pendingFolder.current = folderMenu.node._id;
                fileInput.current?.click();
              }}
              onClose={closeFolderMenu}
            >
              Upload into this folder
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              onClick={() => {
                const node = folderMenu.node;
                openDialog('confirm', {
                  title: `Move “${node.name}” to Trash?`,
                  message: 'Everything inside it is moved to Trash too. You can restore it later.',
                  confirmLabel: 'Move to Trash',
                  onConfirm: async () => {
                    await actions.trash([], [node._id]);
                    const drive = useDrive.getState();
                    await Promise.all([drive.loadFolders(), drive.load({ force: true }), drive.loadStats()]);
                  },
                });
              }}
              onClose={closeFolderMenu}
            >
              Move to Trash
            </MenuItem>
          </>
        ) : null}
      </Menu>

      <input
        ref={fileInput}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          if (files.length) enqueue(files);
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        webkitdirectory=""
        directory=""
        style={{ display: 'none' }}
        onChange={(e) => {
          const items = readDirectoryFileList(e.target.files);
          e.target.value = '';
          if (items.length) enqueue(items);
        }}
      />
    </div>
  );
}

export default AppShell;
