/** Settings: storage provider, Telegram connection, media pipeline, defaults, account. */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  Check,
  Clapperboard,
  Database,
  Film,
  Gauge,
  HardDrive,
  Info,
  KeyRound,
  LayoutGrid,
  List as ListIcon,
  LogOut,
  Moon,
  RefreshCw,
  Send,
  Server,
  ShieldCheck,
  Sun,
  Trash2,
  TriangleAlert,
  Upload,
  UserCog,
  Wand2,
  X,
} from 'lucide-react';
import { useAuth } from '../store/auth.js';
import { useUi } from '../store/ui.js';
import { useDrive } from '../store/drive.js';
import { Files, Meta, Telegram } from '../lib/api.js';
import uploadQueue from '../lib/uploadQueue.js';
import { Spinner } from '../components/common.jsx';
import { formatBytes, KIND_COLOR, KIND_LABEL } from '../lib/format.js';

function StatusBadge({ ok, okLabel = 'Ready', badLabel = 'Unavailable', warn }) {
  if (warn) return <span className="badge badge-warn">{warn}</span>;
  return ok ? <span className="badge badge-ok">{okLabel}</span> : <span className="badge badge-danger">{badLabel}</span>;
}

export function SettingsPage() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const updateProfile = useAuth((s) => s.updateProfile);
  const changePassword = useAuth((s) => s.changePassword);
  const deleteAccount = useAuth((s) => s.deleteAccount);
  const logout = useAuth((s) => s.logout);

  const capabilities = useDrive((s) => s.capabilities);
  const loadCapabilities = useDrive((s) => s.loadCapabilities);
  const stats = useDrive((s) => s.stats);
  const loadStats = useDrive((s) => s.loadStats);

  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const toast = useUi((s) => s.toast);
  const openDialog = useUi((s) => s.openDialog);

  const [health, setHealth] = useState(null);
  const [config, setConfig] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [name, setName] = useState(user?.name || '');
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    await Promise.all([loadCapabilities(), loadStats()]);
  }, [loadCapabilities, loadStats]);

  useEffect(() => {
    refresh();
    Meta.health().then(setHealth).catch(() => {});
    Meta.config().then(setConfig).catch(() => {});
  }, [refresh]);

  const settings = user?.settings || {};
  const storage = capabilities?.storage;
  const media = capabilities?.media;
  const tg = capabilities?.telegram;
  const server = capabilities?.server;

  const patchSettings = async (patch) => {
    try {
      await updateProfile({ settings: patch });
      toast({ kind: 'success', title: 'Saved', timeout: 1800 });
    } catch (err) {
      toast({ kind: 'error', title: 'Could not save setting', message: err.message });
    }
  };

  const verifyTelegram = async () => {
    setVerifying(true);
    try {
      const result = await Telegram.verify();
      toast({
        kind: result?.ok || result?.ready ? 'success' : 'warn',
        title: result?.ok || result?.ready ? 'Telegram connection is healthy' : 'Telegram needs attention',
        message: result?.destination || result?.reason || '',
        timeout: 5200,
      });
      await refresh();
    } catch (err) {
      toast({ kind: 'error', title: 'Verification failed', message: err.message, timeout: 6000 });
    } finally {
      setVerifying(false);
    }
  };

  const kindEntries = Object.entries(stats?.byKind || {});
  const kindTotal = kindEntries.reduce((sum, [, v]) => sum + (v.size || 0), 0) || 1;

  return (
    <div className="content-narrow">
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">Storage, media pipeline, defaults and your account</p>
        </div>
        <button className="btn btn-outline" onClick={refresh}>
          <RefreshCw /> Refresh status
        </button>
      </div>

      <div className="settings-grid">
        <div className="settings-section">
          {/* ── Storage ─────────────────────────────────────────────── */}
          <section className="panel">
            <div className="panel-pad">
              <h2 className="panel-title">
                <HardDrive /> Where your files live
              </h2>

              {!capabilities ? (
                <div className="row center" style={{ padding: 20, gap: 10 }}>
                  <Spinner /> Loading storage status…
                </div>
              ) : (
                <>
                  <div className={`callout ${storage?.active === 'telegram' ? 'callout-ok' : 'callout-brand'}`} style={{ margin: '12px 0 4px' }}>
                    {storage?.active === 'telegram' ? <Send /> : <TriangleAlert />}
                    <div style={{ flex: '1 1 auto' }}>
                      <div className="callout-title">
                        {storage?.active === 'telegram'
                          ? `Storing in Telegram — ${storage?.telegram?.details?.destination || 'Saved Messages'}`
                          : 'Connect Telegram to enable uploads'}
                      </div>
                      <p className="small" style={{ marginTop: 4 }}>
                        {storage?.active === 'telegram'
                          ? `Unlimited total space, up to ${formatBytes(storage?.limits?.perTelegramFile || 2 * 1024 ** 3)} per file. Your files are private to your Telegram account.`
                          : 'Uploads are paused because local-disk fallback is disabled. Connect Telegram and every new file will be stored through ZoZoCloud in your account.'}
                      </p>
                    </div>
                  </div>

                  <div className="setting-row">
                    <div className="setting-main">
                      <div className="setting-name">Telegram account</div>
                      <div className="setting-desc">
                        {tg?.connected
                          ? [tg.firstName, tg.username ? `@${tg.username}` : null, tg.phone].filter(Boolean).join(' · ') +
                            (tg.isPremium ? ' · Premium (4 GB per file)' : '')
                          : storage?.telegram?.reason || 'Not connected'}
                      </div>
                    </div>
                    {tg?.connected ? (
                      <div className="row" style={{ gap: 8 }}>
                        <button className="btn btn-outline btn-sm" onClick={verifyTelegram} disabled={verifying}>
                          {verifying ? <Spinner size={14} /> : <Activity />} Verify
                        </button>
                        <button className="btn btn-primary btn-sm" onClick={() => openDialog('telegram')}>
                          <Send /> Manage
                        </button>
                      </div>
                    ) : (
                      <button className="btn btn-primary btn-sm" onClick={() => openDialog('telegram')}>
                        <Send /> Connect Telegram
                      </button>
                    )}
                  </div>

                  <div className="setting-row">
                    <div className="setting-main">
                      <div className="setting-name">Storage destination</div>
                      <div className="setting-desc">All new uploads are stored in Telegram. There is no permanent local-disk fallback.</div>
                    </div>
                    <StatusBadge ok={storage?.active === 'telegram'} okLabel="Telegram" badLabel="Connection required" />
                  </div>

                  <div className="setting-row">
                    <div className="setting-main">
                      <div className="setting-name">Upload limits</div>
                      <div className="setting-desc">
                        {formatBytes(config?.maxUploadSize || storage?.limits?.maxUploadSize || 0)} per upload ·{' '}
                        {formatBytes(config?.defaultChunkSize || 8 * 1024 * 1024)} chunks (resumable) ·{' '}
                        {formatBytes(storage?.limits?.perTelegramFile || 2 * 1024 ** 3)} per Telegram file
                      </div>
                    </div>
                    <StatusBadge ok={!!storage?.limits} okLabel="Configured" badLabel="Unknown" />
                  </div>
                </>
              )}
            </div>
          </section>

          {/* ── Media pipeline ──────────────────────────────────────── */}
          <section className="panel">
            <div className="panel-pad">
              <h2 className="panel-title">
                <Wand2 /> Media pipeline
              </h2>
              <p className="hint" style={{ margin: '6px 0 12px' }}>
                Everything the server can do with your files after an upload: probing, thumbnails, previews and
                HEVC → H.264 conversion.
              </p>

              <div className="setting-row">
                <div className="setting-main">
                  <div className="setting-name">ffmpeg / ffprobe</div>
                  <div className="setting-desc">
                    {media?.ffmpegVersion || (media?.ffmpeg ? 'installed' : 'not installed')} — probes video codecs,
                    builds thumbnails and transcodes HEVC.
                  </div>
                </div>
                <StatusBadge ok={media?.ffmpeg && media?.ffprobe} />
              </div>

              <div className="setting-row">
                <div className="setting-main">
                  <div className="setting-name">Video transcoding (HEVC → H.264)</div>
                  <div className="setting-desc">
                    Makes iPhone recordings playable in every browser. The original stays untouched.{' '}
                    {media?.transcode
                      ? `Copies are limited to ${media.transcodeMaxDimension || 1920}px using the ${media.transcodePreset || 'fast'} preset; ${media.maxConcurrentTranscodes || 1} conversion${(media.maxConcurrentTranscodes || 1) === 1 ? '' : 's'} at a time.`
                      : ''}
                  </div>
                </div>
                <StatusBadge ok={media?.transcode} okLabel="Enabled" badLabel="Disabled" />
              </div>

              <div className="setting-row">
                <div className="setting-main">
                  <div className="setting-name">Thumbnails &amp; blur-up placeholders</div>
                  <div className="setting-desc">Grid previews load instantly, even on slow connections.</div>
                </div>
                <StatusBadge ok={media?.thumbnails} okLabel={media?.videoThumbnails ? 'Photos + video' : 'Photos'} badLabel="Off" />
              </div>

              <div className="setting-row">
                <div className="setting-main">
                  <div className="setting-name">HEIC image conversion</div>
                  <div className="setting-desc">Apple photos are converted to a web-previewable rendition on upload.</div>
                </div>
                <StatusBadge ok={media?.heic || media?.webPreviews} okLabel="Available" badLabel="Off" />
              </div>

              <div className="setting-row">
                <div className="setting-main">
                  <div className="setting-name">Send videos as media (not documents)</div>
                  <div className="setting-desc">
                    When on, Telegram shows videos in its own gallery. Documents keep the exact original filename.
                  </div>
                </div>
                <button
                  className="switch"
                  data-on={settings.sendVideosAsMedia !== false}
                  role="switch"
                  aria-checked={settings.sendVideosAsMedia !== false}
                  aria-label="Send videos as media"
                  onClick={() => patchSettings({ sendVideosAsMedia: settings.sendVideosAsMedia === false })}
                />
              </div>

              <div className="setting-row">
                <div className="setting-main">
                  <div className="setting-name">Upload images as photos</div>
                  <div className="setting-desc">Keeps them grouped in Telegram’s photo tab.</div>
                </div>
                <button
                  className="switch"
                  data-on={settings.imagesAsPhotos !== false}
                  role="switch"
                  aria-checked={settings.imagesAsPhotos !== false}
                  aria-label="Upload images as photos"
                  onClick={() => patchSettings({ imagesAsPhotos: settings.imagesAsPhotos === false })}
                />
              </div>

              {stats?.needsTranscode ? (
                <div className="callout callout-warn" style={{ marginTop: 14 }}>
                  <Clapperboard />
                  <div style={{ flex: '1 1 auto' }}>
                    <div className="callout-title">{stats.needsTranscode} video(s) waiting for conversion</div>
                    <p className="small" style={{ marginTop: 4 }}>
                      They are stored safely but cannot play in a browser yet.
                    </p>
                  </div>
                  <button className="btn btn-outline btn-sm" onClick={() => navigate('/videos')}>
                    <Film /> Open Videos
                  </button>
                </div>
              ) : null}
            </div>
          </section>

          {/* ── Library ─────────────────────────────────────────────── */}
          <section className="panel">
            <div className="panel-pad">
              <h2 className="panel-title">
                <Database /> Your library
              </h2>

              <div className="stat-grid" style={{ margin: '12px 0 16px' }}>
                <div className="stat">
                  <div className="stat-value">{stats?.files ?? '—'}</div>
                  <div className="stat-label">Files</div>
                </div>
                <div className="stat">
                  <div className="stat-value">{stats ? formatBytes(stats.totalSize || 0) : '—'}</div>
                  <div className="stat-label">Stored</div>
                </div>
                <div className="stat">
                  <div className="stat-value">{stats?.byKind?.video?.count ?? 0}</div>
                  <div className="stat-label">Videos</div>
                </div>
                <div className="stat">
                  <div className="stat-value">{stats?.hevcCount ?? 0}</div>
                  <div className="stat-label">HEVC files</div>
                </div>
                <div className="stat">
                  <div className="stat-value">{stats?.starred ?? 0}</div>
                  <div className="stat-label">Starred</div>
                </div>
                <div className="stat">
                  <div className="stat-value">{stats?.shares ?? 0}</div>
                  <div className="stat-label">Share links</div>
                </div>
              </div>

              {kindEntries.length ? (
                <>
                  <div className="kind-bar">
                    {kindEntries.map(([kind, value]) => (
                      <span
                        key={kind}
                        style={{
                          width: `${Math.max(2, ((value.size || 0) / kindTotal) * 100)}%`,
                          background: KIND_COLOR[kind] || 'var(--muted)',
                        }}
                        title={`${KIND_LABEL[kind] || kind}: ${formatBytes(value.size || 0)}`}
                      />
                    ))}
                  </div>
                  <div className="kind-legend">
                    {kindEntries.map(([kind, value]) => (
                      <span className="kind-legend-item" key={kind}>
                        <span className="kind-swatch" style={{ background: KIND_COLOR[kind] || 'var(--muted)' }} />
                        {KIND_LABEL[kind] || kind} · {value.count} · {formatBytes(value.size || 0)}
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <p className="hint">Upload something and your library breakdown appears here.</p>
              )}

              <div className="row" style={{ gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
                <button className="btn btn-outline btn-sm" onClick={() => navigate('/trash')}>
                  <Trash2 /> Trash ({stats?.trashedCount ?? 0})
                </button>
                <button className="btn btn-outline btn-sm" onClick={() => navigate('/starred')}>
                  <ShieldCheck /> Starred
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    openDialog('confirm', {
                      title: 'Empty the trash?',
                      message: 'Permanently deletes every trashed file and its copy in Telegram.',
                      confirmLabel: 'Empty trash',
                      onConfirm: async () => {
                        await Files.emptyTrash();
                        await refresh();
                        toast({ kind: 'success', title: 'Trash emptied', timeout: 2600 });
                      },
                    })
                  }
                >
                  Empty trash
                </button>
              </div>
            </div>
          </section>

          {/* ── Defaults ────────────────────────────────────────────── */}
          <section className="panel">
            <div className="panel-pad">
              <h2 className="panel-title">
                <UserCog /> Defaults &amp; appearance
              </h2>

              <div className="setting-row">
                <div className="setting-main">
                  <div className="setting-name">Theme</div>
                  <div className="setting-desc">Dark is easiest on the eyes for photo and video libraries.</div>
                </div>
                <div className="segmented">
                  <button data-active={theme === 'dark'} onClick={() => { setTheme('dark'); patchSettings({ theme: 'dark' }); }}>
                    <Moon /> Dark
                  </button>
                  <button data-active={theme === 'light'} onClick={() => { setTheme('light'); patchSettings({ theme: 'light' }); }}>
                    <Sun /> Light
                  </button>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-main">
                  <div className="setting-name">Default view</div>
                  <div className="setting-desc">Grid shows thumbnails, list shows sizes and dates.</div>
                </div>
                <div className="segmented">
                  <button data-active={(settings.view || 'grid') === 'grid'} onClick={() => patchSettings({ view: 'grid' })}>
                    <LayoutGrid /> Grid
                  </button>
                  <button data-active={settings.view === 'list'} onClick={() => patchSettings({ view: 'list' })}>
                    <ListIcon /> List
                  </button>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-main">
                  <div className="setting-name">Parallel uploads</div>
                  <div className="setting-desc">How many files upload at once (each in 3 parallel chunks).</div>
                </div>
                <select
                  className="select"
                  style={{ width: 92 }}
                  value={settings.uploadConcurrency || 2}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    patchSettings({ uploadConcurrency: value });
                    uploadQueue.setConcurrency({ fileConcurrency: value });
                  }}
                >
                  {[1, 2, 3, 4, 6, 8].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>

              <div className="setting-row">
                <div className="setting-main">
                  <div className="setting-name">Trash auto-purge</div>
                  <div className="setting-desc">
                    Trashed files are deleted for good after {config?.trashAutoPurgeDays ?? 30} days.
                  </div>
                </div>
                <span className="badge">{config?.trashAutoPurgeDays ?? 30} days</span>
              </div>
            </div>
          </section>

          {/* ── Account ─────────────────────────────────────────────── */}
          <section className="panel">
            <div className="panel-pad">
              <h2 className="panel-title">
                <KeyRound /> Account
              </h2>

              <div className="field" style={{ marginTop: 12 }}>
                <label className="label" htmlFor="settings-name">
                  Display name
                </label>
                <div className="row" style={{ gap: 8 }}>
                  <input id="settings-name" className="input grow" value={name} onChange={(e) => setName(e.target.value)} />
                  <button
                    className="btn btn-outline btn-sm"
                    disabled={saving || name.trim() === (user?.name || '')}
                    onClick={async () => {
                      setSaving(true);
                      try {
                        await updateProfile({ name: name.trim() });
                        toast({ kind: 'success', title: 'Name updated', timeout: 2000 });
                      } catch (err) {
                        toast({ kind: 'error', title: 'Could not update name', message: err.message });
                      } finally {
                        setSaving(false);
                      }
                    }}
                  >
                    {saving ? <Spinner size={14} /> : <Check />} Save
                  </button>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-main">
                  <div className="setting-name">Email</div>
                  <div className="setting-desc">{user?.email}</div>
                </div>
                <span className="badge">Signed in</span>
              </div>

              <div className="divider" style={{ margin: '14px 0' }} />

              <h3 className="panel-title" style={{ fontSize: 13 }}>
                Change password
              </h3>
              <form
                className="row"
                style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (pw.next !== pw.confirm) {
                    toast({ kind: 'error', title: 'Passwords do not match' });
                    return;
                  }
                  setPwBusy(true);
                  try {
                    await changePassword(pw.current, pw.next);
                    setPw({ current: '', next: '', confirm: '' });
                    toast({ kind: 'success', title: 'Password changed', timeout: 2600 });
                  } catch (err) {
                    toast({ kind: 'error', title: 'Could not change password', message: err.message });
                  } finally {
                    setPwBusy(false);
                  }
                }}
              >
                <input
                  className="input"
                  style={{ flex: '1 1 150px' }}
                  type="password"
                  placeholder="Current password"
                  value={pw.current}
                  onChange={(e) => setPw({ ...pw, current: e.target.value })}
                  autoComplete="current-password"
                />
                <input
                  className="input"
                  style={{ flex: '1 1 150px' }}
                  type="password"
                  placeholder="New password"
                  value={pw.next}
                  onChange={(e) => setPw({ ...pw, next: e.target.value })}
                  autoComplete="new-password"
                />
                <input
                  className="input"
                  style={{ flex: '1 1 150px' }}
                  type="password"
                  placeholder="Confirm new password"
                  value={pw.confirm}
                  onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
                  autoComplete="new-password"
                />
                <button className="btn btn-outline btn-sm" type="submit" disabled={pwBusy || !pw.current || !pw.next}>
                  {pwBusy ? <Spinner size={14} /> : <KeyRound />} Update
                </button>
              </form>

              <div className="divider" style={{ margin: '16px 0' }} />

              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={async () => {
                    await logout();
                    navigate('/login');
                  }}
                >
                  <LogOut /> Sign out
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() =>
                    openDialog('confirm', {
                      title: 'Delete your account and every file?',
                      message:
                        'This removes your account, all folders, all files (including the copies stored in Telegram), share links and jobs. There is no undo.',
                      confirmLabel: 'Delete everything',
                      onConfirm: async () => {
                        await deleteAccount();
                        toast({ kind: 'info', title: 'Account deleted', timeout: 3000 });
                        navigate('/login');
                      },
                    })
                  }
                >
                  <Trash2 /> Delete account
                </button>
              </div>
            </div>
          </section>
        </div>

        {/* ── Aside ───────────────────────────────────────────────── */}
        <div className="settings-section">
          <section className="panel">
            <div className="panel-pad">
              <h2 className="panel-title">
                <Server /> Server
              </h2>
              <dl className="kv" style={{ marginTop: 12 }}>
                <div style={{ display: 'contents' }}>
                  <dt>Version</dt>
                  <dd className="mono">{server?.version || config?.version || '—'}</dd>
                </div>
                <div style={{ display: 'contents' }}>
                  <dt>Node</dt>
                  <dd className="mono">{server?.node || health?.node || '—'}</dd>
                </div>
                <div style={{ display: 'contents' }}>
                  <dt>Platform</dt>
                  <dd className="mono">{server?.platform || '—'}</dd>
                </div>
                <div style={{ display: 'contents' }}>
                  <dt>CPU cores</dt>
                  <dd className="mono">{server?.cpus ?? '—'}</dd>
                </div>
                <div style={{ display: 'contents' }}>
                  <dt>Database</dt>
                  <dd className="mono">{health?.database?.name || health?.database?.type || '—'}</dd>
                </div>
                <div style={{ display: 'contents' }}>
                  <dt>Uptime</dt>
                  <dd className="mono">
                    {health?.uptimeSeconds ? `${Math.round(health.uptimeSeconds / 60)} min` : '—'}
                  </dd>
                </div>
                <div style={{ display: 'contents' }}>
                  <dt>Memory</dt>
                  <dd className="mono">{health?.memoryMb ? `${health.memoryMb} MB` : '—'}</dd>
                </div>
                <div style={{ display: 'contents' }}>
                  <dt>Active jobs</dt>
                  <dd className="mono">{stats?.activeJobs ?? 0}</dd>
                </div>
              </dl>
            </div>
          </section>

          <section className="panel">
            <div className="panel-pad">
              <h2 className="panel-title">
                <Info /> How storage works
              </h2>
              <ul className="small" style={{ marginTop: 10, paddingLeft: 18, lineHeight: 1.75, color: 'var(--text-soft)' }}>
                <li>
                  Uploads are split into {formatBytes(config?.defaultChunkSize || 8 * 1024 * 1024)} chunks, so a dropped
                  connection resumes instead of restarting.
                </li>
                <li>
                  With Telegram connected, each file becomes a message in your Saved Messages (or a private channel) —
                  up to {formatBytes(storage?.limits?.perTelegramFile || 2 * 1024 ** 3)} per file.
                </li>
                <li>Videos stream with HTTP range requests, so seeking is instant.</li>
                <li>
                  HEVC/H.265 videos are converted to H.264 MP4 on demand; both copies stay in your cloud.
                </li>
                <li>Your Telegram session string is encrypted before it is written to the database.</li>
              </ul>
            </div>
          </section>

          <section className="panel">
            <div className="panel-pad">
              <h2 className="panel-title">
                <TriangleAlert /> Status flags
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                <div className="row-between">
                  <span className="small">Telegram connected</span>
                  <StatusBadge ok={!!tg?.connected} okLabel="Yes" badLabel="No" />
                </div>
                <div className="row-between">
                  <span className="small">Transcoding available</span>
                  <StatusBadge ok={!!media?.transcode} okLabel="Yes" badLabel="No" />
                </div>
                <div className="row-between">
                  <span className="small">Thumbnails available</span>
                  <StatusBadge ok={!!media?.thumbnails} okLabel="Yes" badLabel="No" />
                </div>
                <div className="row-between">
                  <span className="small">Telegram uploads ready</span>
                  <StatusBadge ok={!!storage?.uploadReady} okLabel="Yes" badLabel="Connect account" />
                </div>
                <div className="row-between">
                  <span className="small">Live progress (SSE)</span>
                  <StatusBadge ok okLabel="On" />
                </div>
              </div>
              {!tg?.connected ? (
                <button className="btn btn-primary btn-block" style={{ marginTop: 14 }} onClick={() => openDialog('telegram')}>
                  <Upload /> Connect Telegram now
                </button>
              ) : null}
            </div>
          </section>

          <section className="panel">
            <div className="panel-pad">
              <h2 className="panel-title">
                <Gauge /> Keyboard shortcuts
              </h2>
              <dl className="kv" style={{ marginTop: 12 }}>
                {[
                  ['/', 'Focus search'],
                  ['U', 'Upload files'],
                  ['⇧ F', 'New folder'],
                  ['⌘/Ctrl A', 'Select all'],
                  ['⌘/Ctrl K', 'Command palette… not yet'],
                  ['Esc', 'Clear selection / close'],
                  ['⌫', 'Move selection to Trash'],
                  ['← →', 'Prev / next in preview'],
                  ['I', 'Toggle details panel'],
                  ['D', 'Download open file'],
                ].map(([key, label]) => (
                  <div style={{ display: 'contents' }} key={key}>
                    <dt>
                      <span className="badge mono">{key}</span>
                    </dt>
                    <dd>{label}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export default SettingsPage;
