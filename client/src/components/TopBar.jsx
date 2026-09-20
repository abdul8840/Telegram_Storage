/** Top bar: search, upload, view/sort controls, theme and account menu. */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowDownUp,
  FolderUp,
  LayoutGrid,
  List as ListIcon,
  LogOut,
  Menu as MenuIcon,
  Moon,
  Search,
  Send,
  Settings,
  Sun,
  Upload,
  X,
} from 'lucide-react';
import { Menu, MenuItem, MenuSeparator } from './Menu.jsx';
import { useDrive } from '../store/drive.js';
import { useUi } from '../store/ui.js';
import { useAuth } from '../store/auth.js';
import { initials } from '../lib/format.js';

const SORTS = [
  { key: 'createdAt', label: 'Date added' },
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'Size' },
  { key: 'kind', label: 'Type' },
  { key: 'updatedAt', label: 'Last updated' },
  { key: 'downloadCount', label: 'Most downloaded' },
];

export function TopBar({ onOpenSidebar }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [query, setQuery] = useState('');
  const [sortOpen, setSortOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const sortAnchor = useRef(null);
  const accountAnchor = useRef(null);

  const q = useDrive((s) => s.q);
  const sort = useDrive((s) => s.sort);
  const order = useDrive((s) => s.order);
  const setParams = useDrive((s) => s.setParams);
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const toast = useUi((s) => s.toast);
  const openDialog = useUi((s) => s.openDialog);
  const requestUpload = useUi((s) => s.requestUpload);

  const uiView = user?.settings?.view || 'grid';

  useEffect(() => {
    setQuery(pathname === '/search' ? q : '');
  }, [pathname, q]);

  // Debounced search → /search?q=
  useEffect(() => {
    if (pathname === '/search') return undefined;
    const value = query.trim();
    if (!value) return undefined;
    const timer = setTimeout(() => {
      navigate(`/search?q=${encodeURIComponent(value)}`);
    }, 420);
    return () => clearTimeout(timer);
  }, [query, pathname, navigate]);

  const clearSearch = () => {
    setQuery('');
    if (pathname === '/search') navigate('/drive');
  };

  const setView = async (next) => {
    const previous = uiView;
    useAuth.setState((s) => ({ user: { ...s.user, settings: { ...(s.user?.settings || {}), view: next } } }));
    try {
      await useAuth.getState().updateProfile({ settings: { view: next } });
    } catch (err) {
      useAuth.setState((s) => ({ user: { ...s.user, settings: { ...(s.user?.settings || {}), view: previous } } }));
      toast({ kind: 'error', title: 'Could not save view', message: err.message });
    }
  };

  const changeTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    useAuth.getState().updateProfile({ settings: { theme: next } }).catch((err) => {
      toast({ kind: 'warn', title: 'Theme changed on this device', message: `Profile sync failed: ${err.message}` });
    });
  };

  return (
    <header className="topbar">
      <button className="btn btn-ghost btn-icon only-mobile" onClick={onOpenSidebar} aria-label="Open navigation">
        <MenuIcon />
      </button>

      <div className="search-input">
        <Search />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim()) navigate(`/search?q=${encodeURIComponent(query.trim())}`);
            if (e.key === 'Escape') clearSearch();
          }}
          placeholder="Search your cloud…"
          aria-label="Search files"
          id="global-search"
        />
        {query ? (
          <button className="clear" onClick={clearSearch} aria-label="Clear search">
            <X size={15} />
          </button>
        ) : null}
      </div>

      <div className="topbar-actions">
        <button className="btn btn-primary" onClick={() => requestUpload('files')}>
          <Upload /> <span className="hide-mobile">Upload</span>
        </button>
        <button className="btn btn-icon hide-mobile" title="Upload a folder" onClick={() => requestUpload('folder')}>
          <FolderUp />
        </button>

        <div className="segmented hide-mobile" role="group" aria-label="View mode">
          <button data-active={uiView === 'grid'} onClick={() => setView('grid')} aria-label="Grid view" title="Grid view">
            <LayoutGrid />
          </button>
          <button data-active={uiView === 'list'} onClick={() => setView('list')} aria-label="List view" title="List view">
            <ListIcon />
          </button>
        </div>

        <button className="btn btn-icon topbar-sort" ref={sortAnchor} onClick={() => setSortOpen((v) => !v)} aria-label="Sort" title="Sort">
          <ArrowDownUp />
        </button>

        <button className="btn btn-ghost btn-icon topbar-theme" onClick={changeTheme} aria-label="Toggle theme" title={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
          {theme === 'dark' ? <Sun /> : <Moon />}
        </button>

        <button className="avatar topbar-avatar" ref={accountAnchor} onClick={() => setAccountOpen((v) => !v)} aria-label="Account menu" title={user?.email}>
          {initials(user?.name || user?.email || '?')}
        </button>
      </div>

      <Menu open={sortOpen} anchor={sortAnchor.current} onClose={() => setSortOpen(false)} width={200}>
        <div className="menu-label">Sort by</div>
        {SORTS.map((s) => (
          <MenuItem
            key={s.key}
            onClick={() => {
              if (sort === s.key) setParams({ order: order === 'asc' ? 'desc' : 'asc' });
              else setParams({ sort: s.key, order: s.key === 'name' || s.key === 'kind' ? 'asc' : 'desc' });
            }}
            onClose={() => setSortOpen(false)}
          >
            <span style={{ opacity: sort === s.key ? 1 : 0.35, width: 14 }}>{sort === s.key ? '●' : ''}</span>
            {s.label}
            {sort === s.key ? <span className="menu-shortcut">{order === 'asc' ? '↑' : '↓'}</span> : null}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          onClick={() => setParams({ order: order === 'asc' ? 'desc' : 'asc' })}
          onClose={() => setSortOpen(false)}
        >
          {order === 'asc' ? 'Descending' : 'Ascending'}
          <span className="menu-shortcut">{order === 'asc' ? '↑' : '↓'}</span>
        </MenuItem>
      </Menu>

      <Menu open={accountOpen} anchor={accountAnchor.current} onClose={() => setAccountOpen(false)} width={232}>
        <div className="menu-label">
          {user?.name}
          <div className="tiny" style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, marginTop: 2 }}>
            {user?.email}
          </div>
        </div>
        <MenuSeparator />
        <MenuItem icon={Settings} onClick={() => navigate('/settings')} onClose={() => setAccountOpen(false)}>
          Settings
        </MenuItem>
        <MenuItem icon={Send} onClick={() => { navigate('/settings'); setTimeout(() => openDialog('telegram'), 150); }} onClose={() => setAccountOpen(false)}>
          Telegram connection
        </MenuItem>
        <MenuItem icon={theme === 'dark' ? Sun : Moon} onClick={changeTheme} onClose={() => setAccountOpen(false)}>
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={LogOut}
          danger
          onClick={async () => {
            await logout();
            navigate('/login');
          }}
          onClose={() => setAccountOpen(false)}
        >
          Sign out
        </MenuItem>
      </Menu>

    </header>
  );
}

export default TopBar;
