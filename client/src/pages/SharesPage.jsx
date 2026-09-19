/** Manage every share link you have created. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, ExternalLink, Eye, Link2, Lock, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Shares, absoluteUrl } from '../lib/api.js';
import { useUi } from '../store/ui.js';
import { useDrive } from '../store/drive.js';
import { FileIcon } from '../components/FileIcon.jsx';
import { EmptyState, Spinner } from '../components/common.jsx';
import { formatBytes, formatDate } from '../lib/format.js';

export function SharesPage() {
  const toast = useUi((s) => s.toast);
  const openPreview = useUi((s) => s.openPreview);
  const [shares, setShares] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(null);
  const loadStats = useDrive((s) => s.loadStats);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await Shares.list();
      setShares(Array.isArray(result) ? result : result.shares || []);
    } catch (err) {
      toast({ kind: 'error', title: 'Could not load links', message: err.message });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return shares;
    return shares.filter((s) => `${s.name || ''} ${s.token} ${s.note || ''}`.toLowerCase().includes(q));
  }, [shares, query]);

  const copy = async (share) => {
    const url = absoluteUrl(share.url || `/s/${share.token}`);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(share.token);
      setTimeout(() => setCopied(null), 1800);
      toast({ kind: 'success', title: 'Link copied', message: url, timeout: 3600 });
    } catch {
      toast({ kind: 'error', title: 'Copy failed', message: url });
    }
  };

  const revoke = async (share) => {
    try {
      await Shares.revoke(share.token);
      setShares((prev) => prev.filter((s) => s.token !== share.token));
      loadStats();
      toast({ kind: 'info', title: 'Link revoked', message: share.name, timeout: 2800 });
    } catch (err) {
      toast({ kind: 'error', title: 'Could not revoke', message: err.message });
    }
  };

  return (
    <div className="content-narrow">
      <div className="page-head">
        <div>
          <h1 className="page-title">Shared links</h1>
          <p className="page-sub">
            {shares.length} link{shares.length === 1 ? '' : 's'} ·{' '}
            {shares.reduce((sum, s) => sum + (s.views || 0), 0)} views ·{' '}
            {shares.reduce((sum, s) => sum + (s.downloads || 0), 0)} downloads
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <div className="search-input" style={{ width: 220 }}>
            <Search />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter links…" aria-label="Filter links" />
          </div>
          <button className="btn btn-outline" onClick={load}>
            <RefreshCw /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="row center" style={{ padding: 40, gap: 10 }}>
          <Spinner /> Loading links…
        </div>
      ) : !visible.length ? (
        <EmptyState icon={Link2} title={shares.length ? 'No links match that filter' : 'No share links yet'}>
          {shares.length
            ? 'Try a different file name or token.'
            : 'Right-click any file (or use its ⋯ menu) and choose “Share…” to create a private link. Links stream straight from your Telegram cloud — no account needed for the recipient.'}
        </EmptyState>
      ) : (
        <section className="panel">
          <div className="file-list" style={{ padding: 6 }}>
            {visible.map((share) => {
              const url = absoluteUrl(share.url || `/s/${share.token}`);
              return (
                <div className="list-row" key={share.token} style={{ gridTemplateColumns: '26px minmax(180px, 3fr) auto 40px' }}>
                  <span className="list-thumb">
                    <FileIcon file={{ kind: share.kind, name: share.name }} size={18} />
                  </span>

                  <div style={{ minWidth: 0 }}>
                    <div className="list-name truncate">{share.name || 'Deleted file'}</div>
                    <div className="list-meta">
                      <span className="mono truncate" style={{ maxWidth: 260 }}>
                        {url}
                      </span>
                      <span>· {formatBytes(share.size || 0)}</span>
                      <span>· {share.expiresAt ? `expires ${formatDate(share.expiresAt)}` : 'no expiry'}</span>
                      <span>
                        · <Eye size={11} /> {share.views || 0} · downloads {share.downloads || 0}
                      </span>
                      {share.note ? <span>· {share.note}</span> : null}
                    </div>
                  </div>

                  <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {share.protected ? <span className="badge" title="Password protected"><Lock size={11} /></span> : null}
                    {share.expired ? <span className="badge badge-warn">Expired</span> : null}
                    <button className="btn btn-ghost btn-icon btn-sm" title="Copy link" onClick={() => copy(share)}>
                      {copied === share.token ? <Check /> : <Copy />}
                    </button>
                    <a className="btn btn-ghost btn-icon btn-sm" title="Open public page" href={url} target="_blank" rel="noreferrer">
                      <ExternalLink />
                    </a>
                    {share.fileId ? (
                      <button className="btn btn-ghost btn-icon btn-sm" title="Open file" onClick={() => openPreview([share.fileId], 0)}>
                        <Eye />
                      </button>
                    ) : null}
                    <button className="btn btn-ghost btn-icon btn-sm danger" title="Revoke link" onClick={() => revoke(share)}>
                      <Trash2 />
                    </button>
                  </div>

                  <span />
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

export default SharesPage;
