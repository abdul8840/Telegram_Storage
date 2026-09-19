/** Breadcrumb trail for the current folder / virtual view. */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';
import { useDrive } from '../store/drive.js';

const VIEW_TITLES = {
  photos: 'Photos',
  videos: 'Videos',
  audio: 'Audio',
  docs: 'Documents',
  starred: 'Starred',
  recent: 'Recent',
  trash: 'Trash',
  search: 'Search results',
};

/** Walks the folder tree to build [{id, name}, …] from the root down. */
function findChain(nodes, id, trail = []) {
  for (const node of nodes || []) {
    const next = [...trail, { id: node.id || node._id, name: node.name }];
    if ((node.id || node._id) === id) return next;
    if (node.children?.length) {
      const found = findChain(node.children, id, next);
      if (found) return found;
    }
  }
  return null;
}

export function Breadcrumbs({ view = 'folder', folderId = null, query = '', folderPath = '/' }) {
  const folderTree = useDrive((s) => s.folderTree);

  const segments = useMemo(() => {
    const out = [];
    if (view === 'folder' && folderId) {
      const chain = findChain(folderTree, folderId);
      if (chain?.length) {
        chain.forEach((node, i) => out.push({ label: node.name, href: i === chain.length - 1 ? null : `/drive/f/${node.id}` }));
      } else {
        // Tree not loaded yet — fall back to the path string from the API.
        String(folderPath || '')
          .split('/')
          .filter(Boolean)
          .forEach((name, i, arr) => out.push({ label: name, href: i === arr.length - 1 ? null : null }));
      }
    }
    if (view !== 'folder' && VIEW_TITLES[view]) {
      out.push({ label: view === 'search' && query ? `“${query}”` : VIEW_TITLES[view], href: null });
    }
    return out;
  }, [view, folderId, folderTree, folderPath, query]);

  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <Link className="crumb" to="/drive" title="My Drive">
        <Home />
      </Link>

      {segments.length === 0 ? (
        <>
          <span className="crumb-sep">
            <ChevronRight />
          </span>
          <span className="crumb" data-current="true">My Drive</span>
        </>
      ) : null}

      {segments.map((seg, i) => (
        <span key={`${seg.label}-${i}`} style={{ display: 'contents' }}>
          <span className="crumb-sep">
            <ChevronRight />
          </span>
          {seg.href ? (
            <Link className="crumb" to={seg.href}>
              {seg.label}
            </Link>
          ) : (
            <span className="crumb" data-current="true">{seg.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export default Breadcrumbs;
