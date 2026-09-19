/** Left navigation: views, folder tree, storage meter and backend status. */
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  Cloud,
  Clock,
  FileText,
  Film,
  Folder as FolderIcon,
  FolderPlus,
  HardDrive,
  Image as ImageIcon,
  Link2,
  Music,
  Plus,
  Send,
  Settings,
  Star,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useDrive } from '../store/drive.js';
import { useUi } from '../store/ui.js';
import { useAuth } from '../store/auth.js';
import { formatBytes } from '../lib/format.js';

const NAV = [
  { to: '/drive', label: 'My Drive', icon: HardDrive, match: (p) => p === '/drive' || p.startsWith('/drive/') },
  { to: '/recent', label: 'Recent', icon: Clock, match: (p) => p === '/recent' },
  { to: '/photos', label: 'Photos', icon: ImageIcon, match: (p) => p === '/photos', count: (s) => s?.byKind?.image?.count },
  { to: '/videos', label: 'Videos', icon: Film, match: (p) => p === '/videos', count: (s) => s?.byKind?.video?.count },
  { to: '/music', label: 'Music', icon: Music, match: (p) => p === '/music', count: (s) => s?.byKind?.audio?.count },
  {
    to: '/documents',
    label: 'Documents',
    icon: FileText,
    match: (p) => p === '/documents',
    count: (s) => (s?.byKind?.doc?.count || 0) + (s?.byKind?.text?.count || 0),
  },
  { to: '/starred', label: 'Starred', icon: Star, match: (p) => p === '/starred', count: (s) => s?.starred },
  { to: '/shared', label: 'Shared', icon: Link2, match: (p) => p === '/shared', count: (s) => s?.shares },
  { to: '/trash', label: 'Trash', icon: Trash2, match: (p) => p === '/trash', count: (s) => s?.trashedCount },
];

function FolderNode({ node, depth = 0, currentFolderId, onNavigate, onContextMenu }) {
  const [open, setOpen] = useState(depth < 1);
  const children = node.children || [];
  const active = currentFolderId === node._id;

  return (
    <div>
      <div className="folder-node">
        {children.length ? (
          <button
            className="folder-caret"
            data-open={open}
            aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
          >
            <ChevronRight />
          </button>
        ) : (
          <span style={{ width: 20, flex: 'none' }} />
        )}
        <button
          className="nav-item"
          data-active={active}
          style={{ paddingLeft: 4 }}
          onClick={() => onNavigate(node._id)}
          onContextMenu={(e) => onContextMenu?.(node, e)}
          title={node.path || node.name}
        >
          <FolderIcon style={{ color: active ? 'var(--brand)' : undefined }} />
          <span className="truncate">{node.name}</span>
          {node.fileCount ? <span className="nav-count">{node.fileCount}</span> : null}
        </button>
      </div>
      {children.length && open ? (
        <div className="folder-children">
          {children.map((child) => (
            <FolderNode
              key={child._id}
              node={child}
              depth={depth + 1}
              currentFolderId={currentFolderId}
              onNavigate={onNavigate}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Sidebar({ onFolderContextMenu, onClose }) {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const stats = useDrive((s) => s.stats);
  const folderTree = useDrive((s) => s.folderTree);
  const capabilities = useDrive((s) => s.capabilities);
  const openDialog = useUi((s) => s.openDialog);
  const requestUpload = useUi((s) => s.requestUpload);
  const user = useAuth((s) => s.user);

  const storage = capabilities?.storage;
  const onTelegram = storage?.active === 'telegram';
  const currentFolderId = pathname.startsWith('/drive/f/') ? pathname.slice('/drive/f/'.length) : null;

  const go = (to) => {
    navigate(to);
    onClose?.();
  };

  return (
    <aside className="sidebar" data-open={sidebarOpen}>
      <div className="sidebar-brand">
        <span className="brand-mark">
          <Send />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="brand-name">Telegram Cloud</div>
          <div className="brand-sub">Unlimited personal drive</div>
        </div>
      </div>

      <div className="sidebar-scroll">
        <button className="btn btn-primary btn-block" style={{ marginBottom: 16, height: 42 }} onClick={() => requestUpload('files')}>
          <Plus /> New upload
        </button>

        <nav className="nav-section" aria-label="Library">
          <div className="nav-heading">Library</div>
          {NAV.map((item) => {
            const Icon = item.icon;
            const count = item.count ? item.count(stats) : null;
            const active = item.match(pathname);
            return (
              <Link key={item.to} to={item.to} className="nav-item" data-active={active} onClick={() => onClose?.()}>
                <Icon />
                <span className="truncate">{item.label}</span>
                {count ? <span className="nav-count">{count}</span> : null}
              </Link>
            );
          })}
        </nav>

        <div className="nav-section">
          <div className="nav-heading">
            <span>Folders</span>
            <button
              className="btn btn-ghost btn-icon btn-sm"
              aria-label="New folder"
              title="New folder"
              onClick={() => openDialog('newFolder', { parentId: currentFolderId })}
            >
              <FolderPlus size={15} />
            </button>
          </div>
          <div className="folder-tree">
            {folderTree.length ? (
              folderTree.map((node) => (
                <FolderNode
                  key={node._id}
                  node={node}
                  currentFolderId={currentFolderId}
                  onNavigate={(id) => go(`/drive/f/${id}`)}
                  onContextMenu={onFolderContextMenu}
                />
              ))
            ) : (
              <button className="nav-item" onClick={() => openDialog('newFolder', { parentId: currentFolderId })} style={{ color: 'var(--muted)' }}>
                <FolderPlus />
                <span>Create a folder</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="sidebar-foot">
        <div className="storage-meter">
          <div className="storage-meter-top">
            <span className="row" style={{ gap: 6, fontWeight: 600 }}>
              {onTelegram ? <Cloud size={14} style={{ color: 'var(--brand)' }} /> : <TriangleAlert size={14} />}
              {onTelegram ? 'Telegram cloud' : 'Telegram disconnected'}
            </span>
            <span className="tiny muted">{formatBytes(stats?.totalSize || 0)}</span>
          </div>
          {onTelegram ? (
            <div className="storage-meter-note">
              {stats?.files || 0} file(s) stored in your Telegram account
              {storage?.telegram?.details?.account?.isPremium ? ' · Premium: up to 4 GB per file' : ' · up to 2 GB per file'}.
            </div>
          ) : (
            <div className="storage-meter-note">
              Uploads are paused.{' '}
              <button
                style={{ color: 'var(--brand)', fontWeight: 650 }}
                onClick={() => {
                  go('/settings');
                  setTimeout(() => openDialog('telegram'), 150);
                }}
              >
                Connect Telegram
              </button>{' '}
              to store every new file in Telegram.
            </div>
          )}
          {!onTelegram ? (
            <div className="row tiny" style={{ marginTop: 8, color: 'var(--warn)' }}>
              <TriangleAlert size={12} /> No local-disk fallback
            </div>
          ) : null}
        </div>

        <Link to="/settings" className="nav-item" style={{ marginTop: 10 }} onClick={() => onClose?.()}>
          <Settings />
          <span className="truncate">{user?.name || 'Settings'}</span>
        </Link>
      </div>
    </aside>
  );
}

export default Sidebar;
