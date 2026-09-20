/** Public share page (`/s/:token`) — no account needed. */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Clapperboard, Cloud, Download, Eye, Lock, ShieldCheck, TriangleAlert } from 'lucide-react';
import { PublicApi, urls } from '../lib/api.js';
import { MediaStage } from '../components/PreviewModal.jsx';
import { FileIcon } from '../components/FileIcon.jsx';
import { Spinner } from '../components/common.jsx';
import { formatBytes, formatDate, formatDuration } from '../lib/format.js';

export function SharedPage() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState(null);
  const [file, setFile] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await PublicApi.get(token);
      setShare(data.share);
      setFile(data.file);
      setNeedsPassword(false);
    } catch (err) {
      if (err?.code === 'PASSWORD_REQUIRED' || err?.status === 401) {
        setNeedsPassword(true);
        setError(null);
      } else {
        setError(err.message || 'This link is no longer available');
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const unlock = async (e) => {
    e?.preventDefault?.();
    setBusy(true);
    setError(null);
    try {
      const data = await PublicApi.unlock(token, password);
      setShare(data.share);
      setFile(data.file);
      setNeedsPassword(false);
      setPassword('');
    } catch (err) {
      setError(err.message || 'Wrong password');
    } finally {
      setBusy(false);
    }
  };

  const src = file
    ? {
        stream: file.streamUrl || urls.publicStream(token),
        download: file.downloadUrl || urls.publicDownload(token),
        thumbnail: file.hasThumb ? file.thumbUrl || urls.publicThumbnail(token) : null,
        preview: file.hasPreviewRendition ? urls.publicPreview(token) : null,
      }
    : {};

  return (
    <div className="public-page">
      <div className="public-card">
        <div className="public-head">
          <span className="brand-mark">
            <Cloud />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="brand-name">ZoZoCloud</div>
            <div className="brand-sub">Shared with you</div>
          </div>
          <span className="grow" />
          <Link className="btn btn-ghost btn-sm" to="/login">
            Sign in
          </Link>
        </div>

        {loading ? (
          <div className="public-stage">
            <div className="row center" style={{ gap: 10 }}>
              <Spinner /> Loading shared file…
            </div>
          </div>
        ) : needsPassword ? (
          <div className="public-stage">
            <form onSubmit={unlock} style={{ width: '100%', maxWidth: 380, textAlign: 'center' }}>
              <span className="preview-audio-art-fallback" style={{ margin: '0 auto 16px' }}>
                <Lock />
              </span>
              <h2 className="page-title" style={{ fontSize: 18 }}>
                This link is password protected
              </h2>
              <p className="hint" style={{ margin: '6px 0 16px' }}>
                Enter the password that came with the link.
              </p>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                autoFocus
                style={{ marginBottom: 10 }}
              />
              {error ? <p className="error-text" style={{ marginBottom: 10 }}>{error}</p> : null}
              <button className="btn btn-primary btn-block" type="submit" disabled={busy || !password}>
                {busy ? <Spinner size={14} /> : <Lock />} Unlock
              </button>
            </form>
          </div>
        ) : error || !file ? (
          <div className="public-stage">
            <div className="callout callout-danger" style={{ maxWidth: 480 }}>
              <TriangleAlert />
              <div>
                <div className="callout-title">Link unavailable</div>
                <p className="small" style={{ marginTop: 5 }}>
                  {error || 'This file is no longer shared.'}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <>
            <section className="panel">
              <div className="panel-pad">
                <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                  <span style={{ display: 'grid', placeItems: 'center', flex: 'none', marginTop: 2 }}>
                    <FileIcon file={file} size={22} />
                  </span>
                  <div style={{ minWidth: 0, flex: '1 1 auto' }}>
                    <h1 className="page-title truncate" style={{ fontSize: 17 }}>
                      {file.name}
                    </h1>
                    <p className="page-sub">
                      {[
                        formatBytes(file.size || 0),
                        file.durationText || (file.media?.duration ? formatDuration(file.media.duration) : null),
                        file.media?.width ? `${file.media.width}×${file.media.height}` : null,
                        file.media?.vcodec ? file.media.vcodec.toUpperCase() : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <div className="public-stage">
              <MediaStage doc={file} src={src} publicMode />
            </div>

            {file.needsTranscode ? (
              <div className="callout callout-warn">
                <Clapperboard />
                <div>
                  <div className="callout-title">This video needs browser preparation</div>
                  <p className="small" style={{ marginTop: 4 }}>
                    {file.videoCompatibility?.reason || 'The video container or codec is not supported by this browser.'}{' '}
                    Download it for VLC, or ask the owner to optimize it as an MP4.
                  </p>
                </div>
              </div>
            ) : null}

            <div className="public-foot">
              <a className="btn btn-primary btn-sm" href={src.download} download={file.name}>
                <Download /> Download {formatBytes(file.size || 0)}
              </a>
              <span className="row" style={{ gap: 6 }}>
                <Eye size={14} /> {share?.views || 0} views · {share?.downloads || 0} downloads
              </span>
              <span className="row" style={{ gap: 6 }}>
                <ShieldCheck size={14} /> Streamed through ZoZoCloud from the owner's connected storage
              </span>
              {share?.expiresAt ? (
                <span className="row" style={{ gap: 6 }}>Link expires {formatDate(share.expiresAt)}</span>
              ) : (
                <span className="row" style={{ gap: 6 }}>No expiry</span>
              )}
              {share?.note ? <span className="row" style={{ gap: 6 }}>Note: {share.note}</span> : null}
              <span className="grow" />
              <Link className="btn btn-ghost btn-sm" to="/signup">
                Get your own cloud drive
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default SharedPage;
