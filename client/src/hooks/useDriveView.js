/**
 * Syncs a page's view parameters into the drive store and loads data.
 * Kept separate from routing so any page can declare "I am the videos view".
 */
import { useEffect } from 'react';
import { useDrive } from '../store/drive.js';

export function useDriveView({ view = 'folder', folderId = null, q = '', limit } = {}) {
  const sort = useDrive((s) => s.sort);
  const order = useDrive((s) => s.order);
  const page = useDrive((s) => s.page);
  const stale = useDrive((s) => s.stale);

  // Push navigation params in (they reset pagination automatically).
  useEffect(() => {
    const state = useDrive.getState();
    if (state.view !== view || state.folderId !== folderId || state.q !== q) {
      state.setParams({ view, folderId, q });
    }
    if (limit && state.limit !== limit) state.setParams({ limit });
  }, [view, folderId, q, limit]);

  // Fetch whenever the effective query changes.
  useEffect(() => {
    useDrive.getState().load({ force: true });
  }, [view, folderId, q, sort, order, page]);

  // Re-fetch after SSE told us something changed elsewhere.
  useEffect(() => {
    if (!stale) return undefined;
    const timer = setTimeout(() => useDrive.getState().load({ force: true }), 500);
    return () => clearTimeout(timer);
  }, [stale]);

  return {
    items: useDrive((s) => s.items),
    folders: useDrive((s) => s.folders),
    loading: useDrive((s) => s.loading),
    error: useDrive((s) => s.error),
    total: useDrive((s) => s.total),
    pages: useDrive((s) => s.pages),
    folderPath: useDrive((s) => s.folderPath),
  };
}

export default useDriveView;
