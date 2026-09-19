/**
 * Drag & drop / folder-picker helpers.
 *
 * Walking `webkitGetAsEntry()` preserves the directory structure of a dropped
 * folder, so "Vacation 2026/Day 1/IMG_0001.HEVC.mov" lands in the matching
 * drive folders instead of a flat pile of files.
 */

const MAX_ENTRIES_PER_DIR = 5000;

function entryToPromise(entry) {
  return new Promise((resolve) => entry.file(resolve, () => resolve(null)));
}

function readEntries(reader) {
  return new Promise((resolve) => {
    // readEntries returns at most 100 entries per call — keep reading.
    const all = [];
    const batch = () => {
      reader.readEntries(
        (entries) => {
          if (!entries.length) return resolve(all);
          all.push(...entries);
          if (all.length > MAX_ENTRIES_PER_DIR) return resolve(all);
          batch();
        },
        () => resolve(all),
      );
    };
    batch();
  });
}

async function walkEntry(entry, prefix, out) {
  if (!entry) return;
  if (entry.isFile) {
    const file = await entryToPromise(entry);
    if (file) out.push({ file, path: `${prefix}${entry.name}` });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    const entries = await readEntries(reader);
    for (const child of entries) {
      // eslint-disable-next-line no-await-in-loop
      await walkEntry(child, `${prefix}${entry.name}/`, out);
    }
  }
}

/**
 * @param {DataTransfer} dataTransfer
 * @returns {Promise<Array<{file: File, path: string}>>}
 */
export async function readDroppedItems(dataTransfer) {
  const out = [];
  const items = dataTransfer?.items;
  if (items && items.length && typeof items[0].webkitGetAsEntry === 'function') {
    const entries = [];
    for (let i = 0; i < items.length; i += 1) {
      const entry = items[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    for (const entry of entries) {
      // eslint-disable-next-line no-await-in-loop
      await walkEntry(entry, '', out);
    }
    if (out.length) return out;
  }
  // Fallback: flat file list (no folder structure available).
  const files = Array.from(dataTransfer?.files || []);
  return files.map((file) => ({ file, path: file.name }));
}

/** Files picked with <input webkitdirectory> already carry relative paths. */
export function readDirectoryFileList(fileList) {
  return Array.from(fileList || []).map((file) => ({
    file,
    path: file.webkitRelativePath || file.name,
  }));
}

export function hasDirectories(dataTransfer) {
  const items = dataTransfer?.items;
  if (!items) return false;
  for (let i = 0; i < items.length; i += 1) {
    const entry = typeof items[i].webkitGetAsEntry === 'function' ? items[i].webkitGetAsEntry() : null;
    if (entry?.isDirectory) return true;
  }
  return false;
}

/** Groups entries by their parent directory (used to show a summary). */
export function summarizeEntries(entries) {
  const dirs = new Set();
  let total = 0;
  for (const { path, file } of entries) {
    total += file?.size || 0;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (dir) dirs.add(dir.split('/')[0]);
  }
  return { count: entries.length, totalBytes: total, folders: [...dirs] };
}

export default { readDroppedItems, readDirectoryFileList, hasDirectories, summarizeEntries };
