/** Floating action bar shown while files/folders are selected. */
import {
  Download,
  FolderInput,
  Link2,
  RotateCcw,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { Folders } from '../lib/api.js';
import { useDrive } from '../store/drive.js';
import { useUi } from '../store/ui.js';
import { useFileActions } from '../hooks/useFileActions.js';

const isFolderKey = (key) => String(key).startsWith('folder:');

export function SelectionBar() {
  const selection = useDrive((s) => s.selection);
  const items = useDrive((s) => s.items);
  const clearSelection = useDrive((s) => s.clearSelection);
  const openDialog = useUi((s) => s.openDialog);
  const toast = useUi((s) => s.toast);
  const actions = useFileActions();

  const count = selection.length;
  if (!count) return null;

  const selected = selection
    .filter((key) => !isFolderKey(key))
    .map((id) => items.find((f) => f.id === id))
    .filter(Boolean);
  const folderIds = selection.filter(isFolderKey).map((key) => String(key).slice(7));

  const inTrash = selected.some((f) => f.trashed) || useDrive.getState().view === 'trash';
  const allStarred = selected.length > 0 && selected.every((f) => f.starred);
  const label = `${count} selected${folderIds.length ? ` (${folderIds.length} folder${folderIds.length > 1 ? 's' : ''})` : ''}`;

  const downloadAll = () => {
    selected.forEach((f) => actions.download(f));
    toast({
      kind: 'info',
      title: 'Downloads started',
      message: `${selected.length} file${selected.length > 1 ? 's' : ''} streaming from your cloud`,
      timeout: 3000,
    });
  };

  const trashAll = async () => {
    await actions.trash(selected, folderIds);
    clearSelection();
  };

  const restoreAll = async () => {
    await actions.restore(selected, folderIds);
    clearSelection();
  };

  const deleteAll = () => {
    openDialog('confirm', {
      title: `Delete ${count} item${count > 1 ? 's' : ''} forever?`,
      message: 'This cannot be undone — copies stored in Telegram are deleted too.',
      danger: true,
      confirmLabel: 'Delete forever',
      onConfirm: async () => {
        if (selected.length) await actions.deleteForever(selected);
        for (const id of folderIds) {
          await Folders.remove(id, 'delete').catch((err) =>
            toast({ kind: 'error', title: 'Could not delete folder', message: err.message }),
          );
        }
        clearSelection();
        await Promise.all([useDrive.getState().load({ force: true }), useDrive.getState().loadFolders()]);
      },
    });
  };

  return (
    <div className="selection-bar" role="toolbar" aria-label="Selection actions">
      <strong className="selection-count">{label}</strong>
      <span className="sel-actions row" style={{ gap: 2 }}>
        {selected.length ? (
          <button className="btn btn-ghost btn-sm" onClick={downloadAll} title="Download selected">
            <Download />
          </button>
        ) : null}
        {selected.length ? (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => actions.star(selected, !allStarred)}
            title={allStarred ? 'Remove star' : 'Add star'}
          >
            <Star />
          </button>
        ) : null}
        {selected.length ? (
          <button className="btn btn-ghost btn-sm" title="Move selected" onClick={() => actions.move(selected)}>
            <FolderInput />
          </button>
        ) : null}
        {selected.length === 1 && !folderIds.length ? (
          <button className="btn btn-ghost btn-sm" title="Share" onClick={() => actions.share(selected[0])}>
            <Link2 />
          </button>
        ) : null}
        {inTrash ? (
          <button className="btn btn-ghost btn-sm" title="Restore selected" onClick={restoreAll}>
            <RotateCcw />
          </button>
        ) : null}
        <button
          className="btn btn-ghost btn-sm danger"
          title={inTrash ? 'Delete forever' : 'Move to trash'}
          onClick={inTrash ? deleteAll : trashAll}
        >
          <Trash2 />
        </button>
        <button className="btn btn-ghost btn-sm" onClick={clearSelection} title="Clear selection (Esc)">
          <X />
        </button>
      </span>
    </div>
  );
}

export default SelectionBar;
