/**
 * Every modal in the app, mounted once by AppShell and driven by the ui store
 * (`openDialog(name, props)`), so any component can trigger a dialog without
 * prop drilling.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Check,
  Copy,
  ExternalLink,
  FolderPlus,
  FolderTree,
  Link2,
  Lock,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { Modal, ConfirmDialog, Spinner } from './common.jsx';
import { Files, Folders, Shares, Telegram, absoluteUrl } from '../lib/api.js';
import { useUi } from '../store/ui.js';
import { useDrive } from '../store/drive.js';
import { useFileActions } from '../hooks/useFileActions.js';
import { formatBytes, formatDate } from '../lib/format.js';

/* ── Shared bits ─────────────────────────────────────────────────────────── */

function flattenFolders(nodes, depth = 0, out = []) {
  for (const node of nodes || []) {
    out.push({
      id: node.id,
      name: node.name,
      path: node.path || '',
      depth,
      fileCount: node.fileCount || 0,
      size: node.size || 0,
    });
    if (node.children?.length) flattenFolders(node.children, depth + 1, out);
  }
  return out;
}

/** Indented, searchable folder list used by the Move dialog. */
function FolderPicker({ value, onChange, excludeIds = [], allowCreate = false, onCreate }) {
  const folderTree = useDrive((s) => s.folderTree);
  const loadFolders = useDrive((s) => s.loadFolders);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    if (!folderTree?.length) loadFolders();
  }, [folderTree, loadFolders]);

  const flat = useMemo(() => flattenFolders(folderTree), [folderTree]);
  const excluded = new Set(excludeIds);
  const visible = query.trim()
    ? flat.filter((f) => `${f.path}/${f.name}`.toLowerCase().includes(query.trim().toLowerCase()))
    : flat;

  return (
    <div>
      <div className="search-input" style={{ marginBottom: 10 }}>
        <Search />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter folders…"
          aria-label="Filter folders"
        />
      </div>

      <div className="picker-list">
        <button type="button" className="picker-row" data-active={value === null} onClick={() => onChange(null)}>
          <FolderTree size={16} />
          <span className="grow truncate">My Drive (root)</span>
          {value === null ? <Check size={15} /> : null}
        </button>

        {visible.map((folder) => (
          <button
            type="button"
            key={folder.id}
            className="picker-row"
            data-active={value === folder.id}
            disabled={excluded.has(folder.id)}
            onClick={() => onChange(folder.id)}
            style={{ paddingLeft: 10 + folder.depth * 18 }}
          >
            <FolderTree size={16} />
            <span className="grow truncate">{folder.name}</span>
            <span className="tiny faint">{folder.fileCount ? `${folder.fileCount}` : ''}</span>
            {value === folder.id ? <Check size={15} /> : null}
          </button>
        ))}

        {!visible.length ? <p className="hint center" style={{ padding: 14 }}>No folders match “{query}”.</p> : null}
      </div>

      {allowCreate ? (
        creating ? (
          <div className="row" style={{ marginTop: 10 }}>
            <input
              className="input grow"
              value={newName}
              placeholder="New folder name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newName.trim()) {
                  onCreate?.(newName.trim(), value);
                  setNewName('');
                  setCreating(false);
                }
                if (e.key === 'Escape') setCreating(false);
              }}
            />
            <button
              className="btn btn-primary btn-sm"
              onClick={async () => {
                if (!newName.trim()) return;
                await onCreate?.(newName.trim(), value);
                setNewName('');
                setCreating(false);
              }}
            >
              Create
            </button>
          </div>
        ) : (
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={() => setCreating(true)}>
            <FolderPlus /> New folder
          </button>
        )
      ) : null}
    </div>
  );
}

/* ── New folder ──────────────────────────────────────────────────────────── */

export function NewFolderDialog({ parentId = null, openAfter = true, onClose }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    const clean = name.trim();
    if (!clean) return setError('Give the folder a name');
    setBusy(true);
    setError(null);
    try {
      const result = await Folders.create(clean, parentId);
      const folder = result.folder || result;
      await useDrive.getState().loadFolders();
      useUi.getState().toast({ kind: 'success', title: 'Folder created', message: clean, timeout: 2600 });
      onClose();
      if (openAfter && folder?.id) navigate(`/drive/f/${folder.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      title="New folder"
      icon={FolderPlus}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? <Spinner size={14} /> : null} Create
          </button>
        </>
      }
    >
      <div className="field">
        <label className="label" htmlFor="new-folder-name">
          Name
        </label>
        <input
          id="new-folder-name"
          className="input"
          value={name}
          placeholder="e.g. iPhone videos 2026"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoComplete="off"
        />
        {error ? <p className="error-text">{error}</p> : null}
      </div>
    </Modal>
  );
}

/* ── Rename ──────────────────────────────────────────────────────────────── */

export function RenameDialog({ file, onClose }) {
  const upsertFile = useDrive((s) => s.upsertFile);
  const toast = useUi((s) => s.toast);
  const [name, setName] = useState(file?.name || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  // Select just the base name so typing replaces it, extension stays.
  useEffect(() => {
    const dot = (file?.name || '').lastIndexOf('.');
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(0, dot > 0 ? dot : (file?.name || '').length);
  }, [file]);

  const submit = async () => {
    const clean = name.trim();
    if (!clean || clean === file.name) return onClose();
    setBusy(true);
    setError(null);
    try {
      const result = await Files.rename(file.id, clean);
      upsertFile(result.file || result);
      toast({ kind: 'success', title: 'Renamed', message: clean, timeout: 2400 });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      title="Rename"
      subtitle={file?.name}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? <Spinner size={14} /> : null} Save
          </button>
        </>
      }
    >
      <div className="field">
        <label className="label" htmlFor="rename-input">
          New name
        </label>
        <input
          id="rename-input"
          ref={inputRef}
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoComplete="off"
        />
        {error ? <p className="error-text">{error}</p> : null}
      </div>
    </Modal>
  );
}

/* ── Rename folder ───────────────────────────────────────────────────────── */

export function RenameFolderDialog({ folder, onClose }) {
  const toast = useUi((s) => s.toast);
  const [name, setName] = useState(folder?.name || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    const clean = name.trim();
    if (!clean || clean === folder.name) return onClose();
    setBusy(true);
    setError(null);
    try {
      await Folders.rename(folder.id || folder._id, clean);
      const drive = useDrive.getState();
      await Promise.all([drive.loadFolders(), drive.load({ force: true })]);
      toast({ kind: 'success', title: 'Folder renamed', message: clean, timeout: 2400 });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      title="Rename folder"
      subtitle={folder?.name}
      icon={FolderTree}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? <Spinner size={14} /> : null} Save
          </button>
        </>
      }
    >
      <div className="field">
        <label className="label" htmlFor="rename-folder-input">
          Folder name
        </label>
        <input
          id="rename-folder-input"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoComplete="off"
        />
        {error ? <p className="error-text">{error}</p> : null}
      </div>
    </Modal>
  );
}

/* ── Move ────────────────────────────────────────────────────────────────── */

export function MoveDialog({ files = [], onClose }) {
  const list = [].concat(files).filter(Boolean);
  const toast = useUi((s) => s.toast);
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await Files.move(
        list.map((f) => f.id),
        target,
      );
      const drive = useDrive.getState();
      await Promise.all([drive.load({ force: true }), drive.loadFolders(), drive.loadStats()]);
      toast({
        kind: 'success',
        title: 'Moved',
        message: `${list.length} item${list.length > 1 ? 's' : ''} → ${target ? 'folder' : 'My Drive'}`,
        timeout: 2800,
      });
      useDrive.getState().clearSelection();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      title={`Move ${list.length} item${list.length > 1 ? 's' : ''}`}
      subtitle={list.length === 1 ? list[0].name : `${formatBytes(list.reduce((s, f) => s + (f.size || 0), 0))} total`}
      icon={FolderTree}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? <Spinner size={14} /> : null} Move here
          </button>
        </>
      }
    >
      <FolderPicker
        value={target}
        onChange={setTarget}
        allowCreate
        onCreate={async (name, parentId) => {
          try {
            const result = await Folders.create(name, parentId);
            const folder = result.folder || result;
            await useDrive.getState().loadFolders();
            if (folder?.id) setTarget(folder.id);
          } catch (err) {
            toast({ kind: 'error', title: 'Could not create folder', message: err.message });
          }
        }}
      />
      {error ? <p className="error-text" style={{ marginTop: 10 }}>{error}</p> : null}
    </Modal>
  );
}

/* ── Share ───────────────────────────────────────────────────────────────── */

const EXPIRY_OPTIONS = [
  { value: 0, label: 'Never expires' },
  { value: 1, label: '1 day' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 365, label: '1 year' },
];

export function ShareDialog({ file, onClose }) {
  const toast = useUi((s) => s.toast);
  const [shares, setShares] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [expiresInDays, setExpires] = useState(0);
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await Shares.list(file.id);
      setShares(result.shares || []);
    } catch {
      setShares([]);
    } finally {
      setLoading(false);
    }
  }, [file.id]);

  useEffect(() => {
    load();
  }, [load]);

  const linkFor = (share) => absoluteUrl(share.url || `/s/${share.token}`);

  const copy = async (share) => {
    const url = linkFor(share);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(share.token);
      setTimeout(() => setCopied(null), 1800);
      toast({ kind: 'success', title: 'Link copied', message: url, timeout: 4000 });
    } catch {
      toast({ kind: 'error', title: 'Copy failed', message: url });
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      const { share } = await Shares.create({
        fileId: file.id,
        expiresInDays: Number(expiresInDays) || undefined,
        password: password || undefined,
        note: note || undefined,
      });
      setShares((prev) => [share, ...prev.filter((s) => s.token !== share.token)]);
      setPassword('');
      setNote('');
      toast({ kind: 'success', title: 'Share link ready', message: 'Anyone with the link can open it', timeout: 3200 });
      copy(share);
    } catch (err) {
      toast({ kind: 'error', title: 'Could not create link', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (share) => {
    try {
      await Shares.revoke(share.token);
      setShares((prev) => prev.filter((s) => s.token !== share.token));
      toast({ kind: 'info', title: 'Link revoked', timeout: 2400 });
    } catch (err) {
      toast({ kind: 'error', title: 'Could not revoke', message: err.message });
    }
  };

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      title="Share"
      subtitle={file.name}
      icon={Link2}
      width="wide"
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="field">
        <label className="label">Link lifetime</label>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {EXPIRY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="chip"
              data-active={Number(expiresInDays) === opt.value}
              onClick={() => setExpires(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="row" style={{ gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field grow" style={{ minWidth: 190 }}>
          <label className="label" htmlFor="share-password">
            Password (optional)
          </label>
          <input
            id="share-password"
            className="input"
            type="text"
            value={password}
            placeholder="Require a password"
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="field grow" style={{ minWidth: 190 }}>
          <label className="label" htmlFor="share-note">
            Note (optional)
          </label>
          <input
            id="share-note"
            className="input"
            type="text"
            value={note}
            placeholder="e.g. Sent to the client"
            onChange={(e) => setNote(e.target.value)}
            autoComplete="off"
          />
        </div>
        <button className="btn btn-primary" onClick={create} disabled={busy}>
          {busy ? <Spinner size={14} /> : <Link2 />} Create link
        </button>
      </div>

      <div className="divider" style={{ margin: '16px 0' }} />

      {loading ? (
        <div className="row center" style={{ padding: 18 }}>
          <Spinner /> Loading links…
        </div>
      ) : shares.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shares.map((share) => (
            <div className="panel panel-pad" key={share.token} style={{ padding: 12 }}>
              <div className="row-between" style={{ gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="mono truncate" style={{ fontSize: 12.5 }}>
                      {linkFor(share)}
                    </span>
                    {share.hasPassword || share.passwordSet ? <Lock size={13} /> : null}
                  </div>
                  <div className="tiny faint" style={{ marginTop: 3 }}>
                    {share.expiresAt ? `Expires ${formatDate(share.expiresAt)}` : 'No expiry'} · {share.views || 0} views ·{' '}
                    {share.downloads || 0} downloads{share.note ? ` · ${share.note}` : ''}
                  </div>
                </div>
                <div className="row" style={{ gap: 4, flex: 'none' }}>
                  <button className="btn btn-ghost btn-icon btn-sm" title="Copy link" onClick={() => copy(share)}>
                    {copied === share.token ? <Check /> : <Copy />}
                  </button>
                  <a className="btn btn-ghost btn-icon btn-sm" title="Open link" href={linkFor(share)} target="_blank" rel="noreferrer">
                    <ExternalLink />
                  </a>
                  <button className="btn btn-ghost btn-icon btn-sm danger" title="Revoke link" onClick={() => revoke(share)}>
                    <Trash2 />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="hint">
          No links yet. Create one above — the file streams straight from your Telegram cloud to whoever you share it
          with, no account needed.
        </p>
      )}
    </Modal>
  );
}

/* ── Delete forever ──────────────────────────────────────────────────────── */

export function DeleteForeverDialog({ files = [], message, onClose }) {
  const actions = useFileActions();
  const list = [].concat(files).filter(Boolean);
  const [busy, setBusy] = useState(false);

  return (
    <ConfirmDialog
      open
      busy={busy}
      onClose={busy ? undefined : onClose}
      title={`Delete ${list.length} item${list.length > 1 ? 's' : ''} forever?`}
      message={
        message ||
        `This permanently deletes ${list.length} item${list.length > 1 ? 's' : ''} (${formatBytes(
          list.reduce((s, f) => s + (f.size || 0), 0),
        )}). Copies stored in Telegram are deleted too. This cannot be undone.`
      }
      confirmLabel="Delete forever"
      tone="danger"
      onConfirm={async () => {
        setBusy(true);
        await actions.deleteForever(list);
        setBusy(false);
        useDrive.getState().clearSelection();
        onClose();
      }}
    />
  );
}

/* ── Generic confirm ─────────────────────────────────────────────────────── */

function ConfirmHost({ title, message, confirmLabel, danger = true, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog
      open
      busy={busy}
      onClose={busy ? undefined : onClose}
      title={title}
      message={message}
      confirmLabel={confirmLabel || 'Confirm'}
      tone={danger ? 'danger' : 'brand'}
      onConfirm={async () => {
        setBusy(true);
        try {
          await onConfirm?.();
        } finally {
          setBusy(false);
          onClose();
        }
      }}
    />
  );
}

/* ── Telegram connection wizard ──────────────────────────────────────────── */

export function TelegramDialog({ onClose }) {
  const toast = useUi((s) => s.toast);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password2fa, setPassword2fa] = useState('');
  const [chats, setChats] = useState(null);
  const [target, setTarget] = useState('me');
  const refreshDrive = useDrive((s) => s.loadCapabilities);

  const applyStatus = useCallback((data) => {
    setStatus(data);
    if (data?.prefill) {
      setApiId((v) => v || String(data.prefill.apiId || ''));
      setApiHash((v) => v || data.prefill.apiHash || '');
      setPhone((v) => v || data.prefill.phone || '');
    }
    if (data?.login?.step === 'code') setStep('code');
    else if (data?.login?.step === 'password') setStep('password');
    if (data?.account?.chatTarget) setTarget(data.account.chatTarget);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      applyStatus(await Telegram.status());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  useEffect(() => {
    load();
  }, [load]);

  const connected = !!status?.account?.connected;

  const afterLogin = async (result) => {
    setBusy(false);
    if (result?.step === 'password') {
      setStep('password');
      setInfo(null);
      setError(result.error || null);
      return;
    }
    if (result?.step === 'done' || result?.account?.connected) {
      setStep('done');
      setInfo(result.warning || 'Telegram is connected — uploads now land in your Telegram cloud.');
      applyStatus(await Telegram.status());
      refreshDrive();
      toast({ kind: 'success', title: 'Telegram connected', message: 'Your files now live in the Telegram cloud', timeout: 5200 });
      return;
    }
    if (result?.step === 'code') {
      setStep('code');
      setInfo(result.message || 'Enter the code Telegram sent you.');
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await Telegram.start({
        phone,
        apiId: apiId ? Number(apiId) : undefined,
        apiHash: apiHash || undefined,
      });
      await afterLogin(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    setBusy(true);
    setError(null);
    try {
      await afterLogin(await Telegram.code(code));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = async () => {
    setBusy(true);
    setError(null);
    try {
      await afterLogin(await Telegram.password(password2fa));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const loadChats = async () => {
    setBusy(true);
    try {
      setChats(await Telegram.chats());
    } catch (err) {
      toast({ kind: 'error', title: 'Could not list chats', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const saveTarget = async () => {
    setBusy(true);
    try {
      await Telegram.setChatTarget(target);
      applyStatus(await Telegram.status());
      toast({ kind: 'success', title: 'Destination updated', timeout: 2600 });
    } catch (err) {
      toast({ kind: 'error', title: 'Could not update destination', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await Telegram.disconnect();
      applyStatus(await Telegram.status());
      refreshDrive();
      setStep('phone');
      setCode('');
      setPassword2fa('');
      toast({ kind: 'info', title: 'Telegram disconnected', message: 'Uploads fall back to local storage', timeout: 4000 });
    } catch (err) {
      toast({ kind: 'error', title: 'Could not disconnect', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const activeStep = connected ? 'done' : step;
  const wizardSteps = [
    { key: 'phone', label: 'Phone' },
    { key: 'code', label: 'Code' },
    ...(step === 'password' || status?.login?.step === 'password' ? [{ key: 'password', label: '2FA' }] : []),
    { key: 'done', label: 'Connected' },
  ];
  const wizardIndex = Math.max(0, wizardSteps.findIndex((w) => w.key === activeStep));

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      title="Connect Telegram"
      subtitle={connected ? 'Your files are stored in the Telegram cloud' : 'Use your Telegram account as unlimited cloud storage'}
      icon={Send}
      width="wide"
      footer={
        <>
          {connected ? (
            <button className="btn btn-danger" onClick={disconnect} disabled={busy}>
              Disconnect
            </button>
          ) : null}
          <span className="grow" />
          <button className="btn" onClick={onClose} disabled={busy}>
            Close
          </button>
          {step === 'code' && !connected ? (
            <button className="btn btn-primary" onClick={submitCode} disabled={busy || code.length < 4}>
              {busy ? <Spinner size={14} /> : null} Verify code
            </button>
          ) : null}
          {step === 'password' && !connected ? (
            <button className="btn btn-primary" onClick={submitPassword} disabled={busy || !password2fa}>
              {busy ? <Spinner size={14} /> : null} Sign in
            </button>
          ) : null}
          {step === 'phone' && !connected ? (
            <button className="btn btn-primary" onClick={start} disabled={busy || phone.replace(/\D/g, '').length < 7}>
              {busy ? <Spinner size={14} /> : null} Send code
            </button>
          ) : null}
        </>
      }
    >
      {loading ? (
        <div className="row center" style={{ padding: 26 }}>
          <Spinner /> Checking your connection…
        </div>
      ) : (
        <>
          {!connected && activeStep !== 'done' ? (
            <div className="steps">
              {wizardSteps.map((w, i) => (
                <Fragment key={w.key}>
                  {i > 0 ? <span className="step-line" /> : null}
                  <span
                    className="step-dot"
                    data-state={i === wizardIndex ? 'active' : i < wizardIndex ? 'done' : undefined}
                  >
                    <span className="step-num">{i < wizardIndex ? '✓' : i + 1}</span>
                    {w.label}
                  </span>
                </Fragment>
              ))}
            </div>
          ) : null}

          {connected ? (
            <div>
              <div className="callout callout-ok">
                <div className="callout-title">
                  <ShieldCheck /> Connected as {status.account.firstName || status.account.username || status.account.phone}
                </div>
                <p className="small" style={{ marginTop: 6 }}>
                  {status.account.phone ? `Phone ${status.account.phone}` : ''}
                  {status.account.username ? ` · @${status.account.username}` : ''}
                  {status.account.isPremium ? ' · Telegram Premium (4 GB per file)' : ' · up to 2 GB per file'}
                </p>
                {status.status?.details?.destination ? (
                  <p className="small" style={{ marginTop: 4 }}>
                    Files are stored in <strong>{status.status.details.destination}</strong>.
                  </p>
                ) : null}
              </div>

              <div className="field" style={{ marginTop: 16 }}>
                <label className="label">Where files are stored</label>
                {!chats ? (
                  <button className="btn btn-outline btn-sm" onClick={loadChats} disabled={busy}>
                    <RefreshCw /> Choose a chat or channel
                  </button>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                    <button type="button" className="picker-row" data-active={target === 'me'} onClick={() => setTarget('me')}>
                      <Send size={15} /> <span className="grow truncate">Saved Messages (private, recommended)</span>
                      {target === 'me' ? <Check size={15} /> : null}
                    </button>
                    {(chats.chats || []).map((chat) => (
                      <button
                        type="button"
                        key={chat.value}
                        className="picker-row"
                        data-active={target === chat.value}
                        onClick={() => setTarget(chat.value)}
                      >
                        <span className="tiny badge">{chat.kind}</span>
                        <span className="grow truncate">{chat.title}</span>
                        {target === chat.value ? <Check size={15} /> : null}
                      </button>
                    ))}
                    <button className="btn btn-primary btn-sm" style={{ marginTop: 6 }} onClick={saveTarget} disabled={busy}>
                      {busy ? <Spinner size={14} /> : null} Save destination
                    </button>
                  </div>
                )}
                <p className="hint" style={{ marginTop: 8 }}>
                  Saved Messages keeps everything private to your account. A private channel works too and gives you
                  unlimited history.
                </p>
              </div>
            </div>
          ) : (
            <div>
              {activeStep === 'phone' ? (
                <>
                  <div className="callout callout-brand">
                    <div className="callout-title">
                      <TriangleAlert /> You need an api_id and api_hash
                    </div>
                    <p className="small" style={{ marginTop: 6 }}>
                      Create them free at{' '}
                      <a href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">
                        my.telegram.org/apps
                      </a>{' '}
                      → “API development tools”. They identify this app to Telegram; your password is never seen by this
                      server.
                    </p>
                  </div>

                  <div className="row" style={{ gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
                    <div className="field" style={{ width: 130 }}>
                      <label className="label" htmlFor="tg-apiid">
                        api_id
                      </label>
                      <input id="tg-apiid" className="input mono" value={apiId} onChange={(e) => setApiId(e.target.value)} placeholder="1234567" />
                    </div>
                    <div className="field grow" style={{ minWidth: 220 }}>
                      <label className="label" htmlFor="tg-apihash">
                        api_hash
                      </label>
                      <input
                        id="tg-apihash"
                        className="input mono"
                        value={apiHash}
                        onChange={(e) => setApiHash(e.target.value)}
                        placeholder="0123456789abcdef0123456789abcdef"
                      />
                    </div>
                  </div>

                  <div className="field">
                    <label className="label" htmlFor="tg-phone">
                      Phone number
                    </label>
                    <input
                      id="tg-phone"
                      className="input"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="+14155550123"
                      onKeyDown={(e) => e.key === 'Enter' && start()}
                      autoComplete="tel"
                    />
                    <p className="hint">Include the country code. Telegram will send you a login code.</p>
                  </div>
                </>
              ) : null}

              {activeStep === 'code' ? (
                <div className="field">
                  <label className="label" htmlFor="tg-code">
                    Login code
                  </label>
                  <input
                    id="tg-code"
                    className="input mono"
                    style={{ fontSize: 22, letterSpacing: 8, textAlign: 'center' }}
                    value={code}
                    inputMode="numeric"
                    maxLength={8}
                    onChange={(e) => {
                      const next = e.target.value.replace(/\D/g, '');
                      setCode(next);
                      if (next.length >= 5) setTimeout(() => submitCode(), 120);
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && submitCode()}
                    placeholder="•••••"
                  />
                  <p className="hint">{info || status?.login?.message || 'Check your Telegram app or SMS.'}</p>
                  <div className="row" style={{ gap: 8, marginTop: 10 }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        setBusy(true);
                        try {
                          const r = await Telegram.resend(false);
                          setInfo(r.message || 'A new code was sent.');
                        } catch (err) {
                          setError(err.message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                      disabled={busy}
                    >
                      <RefreshCw /> Resend code
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => { setStep('phone'); setCode(''); Telegram.cancelLogin().catch(() => {}); }} disabled={busy}>
                      Change number
                    </button>
                  </div>
                </div>
              ) : null}

              {activeStep === 'password' ? (
                <div className="field">
                  <label className="label" htmlFor="tg-2fa">
                    Two-step verification password
                  </label>
                  <input
                    id="tg-2fa"
                    className="input"
                    type="password"
                    value={password2fa}
                    onChange={(e) => setPassword2fa(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && submitPassword()}
                    placeholder="Your Telegram cloud password"
                  />
                  <p className="hint">
                    {status?.login?.passwordHint ? `Hint: ${status.login.passwordHint}` : 'Your account has 2FA enabled — enter it to finish.'}
                  </p>
                </div>
              ) : null}

              {activeStep === 'done' ? (
                <div className="callout callout-ok">
                  <div className="callout-title">
                    <Check /> Connected
                  </div>
                  <p className="small" style={{ marginTop: 6 }}>
                    {info || 'Upload a file to see it stored in your Telegram cloud.'}
                  </p>
                </div>
              ) : null}

              {error ? (
                <div className="callout callout-danger" style={{ marginTop: 12 }}>
                  <div className="callout-title">
                    <TriangleAlert /> {error}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/* ── Host ────────────────────────────────────────────────────────────────── */

export function DialogHost() {
  const dialog = useUi((s) => s.dialog);
  const props = useUi((s) => s.dialogProps);
  const close = useUi((s) => s.closeDialog);

  if (!dialog) return null;

  switch (dialog) {
    case 'newFolder':
      return <NewFolderDialog {...props} onClose={close} />;
    case 'rename':
      return props.file ? <RenameDialog {...props} onClose={close} /> : null;
    case 'renameFolder':
      return props.folder ? <RenameFolderDialog {...props} onClose={close} /> : null;
    case 'move':
      return <MoveDialog {...props} onClose={close} />;
    case 'share':
      return props.file ? <ShareDialog {...props} onClose={close} /> : null;
    case 'deleteForever':
      return <DeleteForeverDialog {...props} onClose={close} />;
    case 'confirm':
      return <ConfirmHost {...props} onClose={close} />;
    case 'telegram':
      return <TelegramDialog {...props} onClose={close} />;
    default:
      return null;
  }
}

export default DialogHost;
