/**
 * Every file action the UI can perform, in one place, so the grid, list,
 * selection bar, context menu and preview modal all behave identically.
 */
import { useCallback } from 'react';
import { Files, Shares, downloadFile, absoluteUrl } from '../lib/api.js';
import { useDrive } from '../store/drive.js';
import { useUi } from '../store/ui.js';
import { useJobs } from '../store/jobs.js';
import { formatBytes } from '../lib/format.js';

export function useFileActions() {
  const toast = useUi((s) => s.toast);
  const openDialog = useUi((s) => s.openDialog);
  const openPreview = useUi((s) => s.openPreview);

  const refresh = useCallback(() => {
    const drive = useDrive.getState();
    drive.load({ force: true });
    drive.loadStats();
    drive.loadFolders();
  }, []);

  const idsOf = (files) => [].concat(files).map((f) => f.id || f._id).filter(Boolean);

  const open = useCallback(
    (file, siblings = null) => {
      const list = (siblings || useDrive.getState().items).filter((f) => f.status === 'ready' || f.status === 'processing');
      const index = Math.max(0, list.findIndex((f) => f.id === file.id));
      openPreview(idsOf(list.length ? list : [file]), index);
    },
    [openPreview],
  );

  const download = useCallback(
    (file) => {
      downloadFile(file.id, file.name);
      toast({ kind: 'info', title: 'Download started', message: file.name, timeout: 2600 });
    },
    [toast],
  );

  const rename = useCallback((file) => openDialog('rename', { file }), [openDialog]);

  const move = useCallback((files) => openDialog('move', { files: [].concat(files) }), [openDialog]);

  const star = useCallback(
    async (files, starred) => {
      try {
        const result = await Files.star(idsOf(files), starred);
        result.files?.forEach((f) => useDrive.getState().upsertFile(f));
        toast({
          kind: 'success',
          title: starred ? 'Added to Starred' : 'Removed from Starred',
          message: files.length > 1 ? `${files.length} items` : files[0]?.name,
          timeout: 2400,
        });
      } catch (err) {
        toast({ kind: 'error', title: 'Could not update', message: err.message });
      }
    },
    [toast],
  );

  const share = useCallback((file) => openDialog('share', { file }), [openDialog]);

  const copyLink = useCallback(
    async (file) => {
      try {
        const { share } = await Shares.create({ fileId: file.id });
        const url = absoluteUrl(share.url);
        await navigator.clipboard?.writeText(url);
        toast({ kind: 'success', title: 'Link copied', message: url, timeout: 4200 });
      } catch (err) {
        toast({ kind: 'error', title: 'Could not create link', message: err.message });
      }
    },
    [toast],
  );

  const transcode = useCallback(
    async (file, maxDimension = 1920) => {
      try {
        await Files.transcode(file.id, maxDimension);
        await useJobs.getState().load();
        toast({
          kind: 'info',
          title: 'Conversion started',
          message: `${file.name} → H.264 MP4. You can keep using the drive; we'll notify you.`,
          timeout: 6000,
        });
      } catch (err) {
        toast({ kind: 'error', title: 'Cannot convert', message: err.message, timeout: 8000 });
      }
    },
    [toast],
  );

  const regenerate = useCallback(
    async (file) => {
      try {
        await Files.regenerate(file.id);
        toast({ kind: 'info', title: 'Rebuilding preview', message: file.name, timeout: 3200 });
      } catch (err) {
        toast({ kind: 'error', title: 'Could not rebuild preview', message: err.message });
      }
    },
    [toast],
  );

  const cancel = useCallback(
    async (file) => {
      try {
        await Files.cancel(file.id);
        useDrive.getState().removeFiles([file.id]);
        toast({ kind: 'info', title: 'Upload cancelled', message: file.name, timeout: 3000 });
      } catch (err) {
        toast({ kind: 'error', title: 'Could not cancel', message: err.message });
      }
    },
    [toast],
  );

  const retry = useCallback(
    async (file) => {
      try {
        await Files.retry(file.id);
        toast({ kind: 'info', title: 'Retrying upload', message: file.name, timeout: 3000 });
      } catch (err) {
        toast({ kind: 'error', title: 'Retry failed', message: err.message });
      }
    },
    [toast],
  );

  const trash = useCallback(
    async (files, folderIds = []) => {
      try {
        const result = await Files.trash(idsOf(files), folderIds);
        useDrive.getState().removeFiles(idsOf(files));
        toast({
          kind: 'success',
          title: 'Moved to Trash',
          message: `${result.trashed} item(s) — you can restore them any time.`,
          timeout: 4200,
        });
        refresh();
      } catch (err) {
        toast({ kind: 'error', title: 'Could not move to Trash', message: err.message });
      }
    },
    [toast, refresh],
  );

  const restore = useCallback(
    async (files, folderIds = []) => {
      try {
        await Files.restore(idsOf(files), folderIds);
        useDrive.getState().removeFiles(idsOf(files));
        toast({ kind: 'success', title: 'Restored', message: `${files.length} item(s) are back in your drive.`, timeout: 3200 });
        refresh();
      } catch (err) {
        toast({ kind: 'error', title: 'Could not restore', message: err.message });
      }
    },
    [toast, refresh],
  );

  const confirmDelete = useCallback(
    (files) => {
      const list = [].concat(files);
      const totalBytes = list.reduce((sum, f) => sum + (f.size || 0), 0);
      openDialog('deleteForever', {
        files: list,
        message: `This permanently deletes ${list.length} item(s) (${formatBytes(totalBytes)}) from storage${
          list.some((f) => f.inTelegram) ? ' and from Telegram' : ''
        }. This cannot be undone.`,
      });
    },
    [openDialog],
  );

  const deleteForever = useCallback(
    async (files) => {
      try {
        const result = await Files.remove(idsOf(files));
        useDrive.getState().removeFiles(idsOf(files));
        useUi.getState().closeDialog();
        toast({
          kind: result.failed?.length ? 'warn' : 'success',
          title: result.failed?.length ? 'Partially deleted' : 'Deleted permanently',
          message: result.failed?.length
            ? `${result.deleted} deleted, ${result.failed.length} failed: ${result.failed[0].error}`
            : `${result.deleted} item(s) removed (${formatBytes(files.reduce((s, f) => s + (f.size || 0), 0))} freed).`,
          timeout: 5200,
        });
        refresh();
        return result;
      } catch (err) {
        toast({ kind: 'error', title: 'Delete failed', message: err.message });
        return null;
      }
    },
    [toast, refresh],
  );

  return {
    open,
    download,
    rename,
    move,
    star,
    share,
    copyLink,
    transcode,
    regenerate,
    retry,
    cancel,
    trash,
    restore,
    confirmDelete,
    deleteForever,
    refresh,
  };
}

export default useFileActions;
