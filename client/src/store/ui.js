/** UI store: theme, toasts, sidebar, preview overlay, and modal dialogs. */
import { create } from 'zustand';

const THEME_KEY = 'tgc_theme';
let toastSeq = 0;

const initialTheme = () => {
  if (typeof window === 'undefined') return 'dark';
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
};

export const useUi = create((set, get) => ({
  theme: initialTheme(),
  sidebarOpen: false,
  toasts: [],
  /** Which modal is open: null | 'newFolder' | 'rename' | 'move' | 'share' | 'delete' | 'telegram' | 'shortcuts' */
  dialog: null,
  dialogProps: {},
  /** Preview overlay state: { ids, index, shareToken } */
  preview: null,
  uploadDockOpen: true,
  /** Set by any component that wants the hidden file/folder picker to open. */
  uploadRequest: null,
  density: localStorage.getItem('tgc_density') || 'comfortable',

  applyTheme() {
    document.documentElement.dataset.theme = get().theme;
    document.documentElement.style.colorScheme = get().theme;
  },

  toggleTheme() {
    const theme = get().theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, theme);
    set({ theme });
    get().applyTheme();
  },

  setTheme(theme) {
    localStorage.setItem(THEME_KEY, theme);
    set({ theme });
    get().applyTheme();
  },

  setSidebarOpen(open) {
    set({ sidebarOpen: open });
  },

  toast({ kind = 'info', title = '', message = '', timeout = 5200, action = null } = {}) {
    const id = `toast_${(toastSeq += 1)}`;
    set((state) => ({ toasts: [...state.toasts, { id, kind, title, message, action }] }));
    if (timeout) {
      setTimeout(() => get().dismissToast(id), timeout);
    }
    return id;
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },

  openDialog(dialog, props = {}) {
    set({ dialog, dialogProps: props });
  },
  closeDialog() {
    set({ dialog: null, dialogProps: {} });
  },

  openPreview(ids, index = 0, extra = {}) {
    const list = [].concat(ids).filter(Boolean);
    if (!list.length) return;
    set({ preview: { ids: list, index: Math.max(0, Math.min(index, list.length - 1)), ...extra } });
  },
  closePreview() {
    set({ preview: null });
  },
  previewNext() {
    const p = get().preview;
    if (!p) return;
    set({ preview: { ...p, index: (p.index + 1) % p.ids.length } });
  },
  previewPrev() {
    const p = get().preview;
    if (!p) return;
    set({ preview: { ...p, index: (p.index - 1 + p.ids.length) % p.ids.length } });
  },
  setPreviewIndex(index) {
    const p = get().preview;
    if (!p) return;
    set({ preview: { ...p, index } });
  },

  toggleUploadDock() {
    set((state) => ({ uploadDockOpen: !state.uploadDockOpen }));
  },

  /** kind: 'files' | 'folder' */
  requestUpload(kind = 'files') {
    set({ uploadRequest: { kind, at: Date.now() } });
  },
  clearUploadRequest() {
    set({ uploadRequest: null });
  },
}));

export default useUi;
