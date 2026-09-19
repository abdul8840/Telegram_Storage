/** Context menu shared by grid cards, list rows and the preview overlay. */
import { useMemo, useState } from 'react';
import {
  Clapperboard,
  Copy,
  Download,
  Eye,
  FolderInput,
  Link2,
  Pencil,
  RotateCcw,
  Star,
  Trash2,
  Wand2,
  XCircle,
} from 'lucide-react';
import { Menu, MenuItem, MenuSeparator } from './Menu.jsx';
import useFileActions from '../hooks/useFileActions.js';

/**
 * Builds the action list for one file (or a multi-selection), respecting its
 * lifecycle state: processing files can only be cancelled, failed ones retried,
 * trashed ones restored or destroyed.
 */
export function useFileMenuItems(files, { onClose } = {}) {
  const actions = useFileActions();
  return useMemo(() => {
    const list = [].concat(files).filter(Boolean);
    if (!list.length) return [];
    const single = list.length === 1 ? list[0] : null;
    const anyProcessing = list.some((f) => ['processing', 'uploading', 'assembling'].includes(f.status));
    const anyFailed = list.some((f) => f.status === 'failed');
    const anyTrashed = list.some((f) => f.trashed);
    const anyStarred = list.some((f) => f.starred);
    const anyTranscodable = list.some((f) => f.needsTranscode || (f.kind === 'video' && f.status === 'ready'));
    const anyReady = list.some((f) => f.status === 'ready');

    const items = [];

    if (anyTrashed) {
      items.push({ label: 'Restore', icon: RotateCcw, onClick: () => actions.restore(list) });
      items.push({ label: 'Delete forever', icon: Trash2, danger: true, onClick: () => actions.confirmDelete(list) });
      return items;
    }

    if (anyProcessing) {
      items.push({ label: 'Cancel upload', icon: XCircle, danger: true, onClick: () => list.forEach((f) => actions.cancel(f)) });
      return items;
    }

    if (anyFailed) {
      items.push({ label: 'Retry upload', icon: RotateCcw, onClick: () => list.forEach((f) => actions.retry(f)) });
    }

    if (anyReady) {
      if (single) items.push({ label: 'Open preview', icon: Eye, shortcut: '↵', onClick: () => actions.open(single) });
      items.push({ label: list.length > 1 ? `Download ${list.length} files` : 'Download', icon: Download, onClick: () => list.forEach((f) => actions.download(f)) });
      if (single) {
        items.push({ label: 'Copy share link', icon: Link2, onClick: () => actions.copyLink(single) });
        items.push({ label: 'Share…', icon: Copy, onClick: () => actions.share(single) });
      }
      items.push({ sep: true });
      if (single) items.push({ label: 'Rename', icon: Pencil, shortcut: 'F2', onClick: () => actions.rename(single) });
      items.push({ label: 'Move to…', icon: FolderInput, onClick: () => actions.move(list) });
      items.push({
        label: anyStarred ? 'Remove star' : 'Add star',
        icon: Star,
        onClick: () => actions.star(list, !anyStarred),
      });
      if (anyTranscodable) {
        items.push({ sep: true });
        items.push({
          label: single?.needsTranscode ? 'Convert to MP4 (H.264)' : 'Convert to MP4 (H.264)',
          icon: Clapperboard,
          onClick: () => list.filter((f) => f.kind === 'video').forEach((f) => actions.transcode(f)),
        });
      }
      if (single) {
        items.push({ label: 'Rebuild preview', icon: Wand2, onClick: () => actions.regenerate(single) });
      }
      items.push({ sep: true });
      items.push({ label: 'Move to Trash', icon: Trash2, danger: true, shortcut: '⌫', onClick: () => actions.trash(list) });
    }

    return items;
  }, [files, actions]);
}

export function FileContextMenu({ open, anchor, files, onClose }) {
  const items = useFileMenuItems(files, { onClose });
  return (
    <Menu open={open} anchor={anchor} onClose={onClose}>
      {items.map((item, index) =>
        item.sep ? <MenuSeparator key={`sep-${index}`} /> : (
          <MenuItem
            key={item.label + index}
            icon={item.icon}
            danger={item.danger}
            shortcut={item.shortcut}
            disabled={item.disabled}
            onClick={item.onClick}
            onClose={onClose}
          >
            {item.label}
          </MenuItem>
        ),
      )}
    </Menu>
  );
}

/** Hook version: manages menu open state + anchor for a list/grid owner. */
export function useMenuState() {
  const [state, setState] = useState({ open: false, anchor: null, files: [] });
  const openMenu = (anchor, files) => setState({ open: true, anchor, files: [].concat(files) });
  const closeMenu = () => setState((s) => ({ ...s, open: false }));
  return { menu: state, openMenu, closeMenu };
}

export default FileContextMenu;
