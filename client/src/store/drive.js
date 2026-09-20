/**
 * Drive store: the current library view (folder / kind / search / trash),
 * pagination, selection, plus folders, stats and server capabilities.
 *
 * The URL is the source of truth for navigation params; `useDriveRoute` pushes
 * them in here, and SSE events keep `items` fresh without a full refetch.
 */
import { create } from 'zustand';
import { Files, Folders, Meta } from '../lib/api.js';

const DEFAULTS = {
  view: 'folder',
  folderId: null,
  q: '',
  sort: 'createdAt',
  order: 'desc',
  page: 1,
  limit: 60,
};

export const useDrive = create((set, get) => ({
  ...DEFAULTS,
  items: [],
  folders: [],
  total: 0,
  pages: 1,
  folderPath: null,
  loading: false,
  error: null,
  stale: false,
  selection: [],
  lastFetchedKey: null,

  folderTree: [],
  folderTotals: { rootCount: 0, rootSize: 0 },
  stats: null,
  capabilities: null,
  summary: null,

  /** Navigation / filter changes. `refetch` is handled by the route hook. */
  setParams(patch) {
    const next = { ...patch };
    if ('view' in patch || 'folderId' in patch || 'q' in patch || 'sort' in patch || 'order' in patch) {
      if (patch.page === undefined) next.page = 1;
    }
    set(next);
  },

  queryKey() {
    const s = get();
    return [s.view, s.folderId, s.q, s.sort, s.order, s.page, s.limit].join('|');
  },

  async load({ force = false } = {}) {
    const state = get();
    const key = state.queryKey();
    if (!force && state.lastFetchedKey === key && state.items.length && !state.stale) return;
    set({ loading: true, error: null, lastFetchedKey: key });
    try {
      const data = await Files.list({
        view: state.view,
        folderId: state.folderId || undefined,
        q: state.q || undefined,
        sort: state.sort,
        order: state.order,
        page: state.page,
        limit: state.limit,
      });
      // Ignore responses for a view the user has already navigated away from.
      if (get().queryKey() !== key) return;
      set({
        items: data.items || [],
        folders: data.folders || [],
        total: data.total || 0,
        pages: data.pages || 1,
        folderPath: data.folderPath || null,
        loading: false,
        stale: false,
        selection: [],
      });
    } catch (err) {
      if (get().queryKey() !== key) return;
      // Keep the last successful view visible during a transient outage. The
      // inline error offers retry without turning the whole drive blank.
      set({ loading: false, error: err.message, stale: true });
    }
  },

  async loadFolders() {
    try {
      const data = await Folders.tree();
      set({ folderTree: data.tree || [], folderTotals: { rootCount: data.rootCount || 0, rootSize: data.rootSize || 0 } });
    } catch {
      /* non-fatal */
    }
  },

  async loadStats() {
    try {
      const [stats, summary] = await Promise.all([Files.stats(), Meta.summary()]);
      set({ stats, summary });
      return stats;
    } catch {
      return null;
    }
  },

  async loadCapabilities() {
    try {
      const capabilities = await Meta.capabilities();
      set({ capabilities });
      return capabilities;
    } catch {
      return null;
    }
  },

  markStale() {
    set({ stale: true });
  },

  /** Inserts or replaces a file in the current list (from SSE). */
  upsertFile(file) {
    if (!file) return;
    const { items, view, folderId, q, total } = get();
    const index = items.findIndex((f) => f.id === file.id);
    if (index >= 0) {
      // Trashed files disappear from every view except the trash.
      if (file.trashed && view !== 'trash') {
        const next = items.filter((_, i) => i !== index);
        set({ items: next, total: Math.max(0, total - 1) });
        return;
      }
      const next = [...items];
      next[index] = { ...next[index], ...file };
      set({ items: next });
      return;
    }
    if (file.trashed) return;
    const matchesView =
      view === 'all' ||
      view === 'recent' ||
      (view === 'folder' && (file.folderId || null) === (folderId || null)) ||
      (view === 'starred' && file.starred) ||
      (view === 'photos' && file.kind === 'image') ||
      (view === 'videos' && file.kind === 'video') ||
      (view === 'audio' && file.kind === 'audio') ||
      ((view === 'docs' || view === 'documents') && (file.kind === 'doc' || file.kind === 'text'));
    if (!matchesView) return;
    if (q && !file.name.toLowerCase().includes(q.toLowerCase())) return;
    set({ items: [file, ...items], total: total + 1 });
  },

  removeFiles(ids) {
    const set_ = new Set([].concat(ids));
    const { items, total, selection } = get();
    set({
      items: items.filter((f) => !set_.has(f.id)),
      total: Math.max(0, total - items.filter((f) => set_.has(f.id)).length),
      selection: selection.filter((id) => !set_.has(id)),
    });
  },

  // ── selection ────────────────────────────────────────────────────────────
  toggleSelect(id, { additive = true } = {}) {
    const { selection } = get();
    if (!additive) return set({ selection: [id] });
    set({
      selection: selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id],
    });
  },
  select(ids) {
    set({ selection: [].concat(ids) });
  },
  selectAllVisible() {
    const { items, folders, selection } = get();
    const ids = [...folders.map((f) => `folder:${f._id}`), ...items.map((f) => f.id)];
    const allSelected = ids.every((id) => selection.includes(id));
    set({ selection: allSelected ? [] : ids });
  },
  clearSelection() {
    set({ selection: [] });
  },
  selectedFiles() {
    const { selection, items } = get();
    return items.filter((f) => selection.includes(f.id));
  },
  selectedFolderIds() {
    return get()
      .selection.filter((id) => String(id).startsWith('folder:'))
      .map((id) => String(id).slice(7));
  },

  setPage(page) {
    set({ page });
  },
  reset() {
    set({ ...DEFAULTS, items: [], folders: [], total: 0, selection: [], lastFetchedKey: null });
  },
}));

export default useDrive;
