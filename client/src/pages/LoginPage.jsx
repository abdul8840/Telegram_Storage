/** Sign in / create account. */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Clapperboard,
  FolderSync,
  Gauge,
  HardDriveDownload,
  Link2,
  Loader2,
  Lock,
  Send,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { useAuth } from '../store/auth.js';
import { useUi } from '../store/ui.js';
import { useDrive } from '../store/drive.js';
import { Meta } from '../lib/api.js';

const FEATURES = [
  {
    icon: Send,
    title: 'Telegram as your cloud drive',
    text: 'Files up to 2 GB (4 GB with Premium) are stored in your own Telegram account — private, replicated, free.',
  },
  {
    icon: Clapperboard,
    title: 'iPhone HEVC videos that just play',
    text: 'H.265 recordings are probed, thumbnailed and converted to H.264 on the server so they stream in any browser.',
  },
  {
    icon: Gauge,
    title: 'Instant streaming with seeking',
    text: 'HTTP range requests let you scrub through hours-long videos straight from the cloud, no download needed.',
  },
  {
    icon: Link2,
    title: 'Private share links',
    text: 'Send anyone a link — optionally password protected and expiring — they can preview and download without an account.',
  },
];

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const login = useAuth((s) => s.login);
  const signup = useAuth((s) => s.signup);
  const toast = useUi((s) => s.toast);

  const [mode, setMode] = useState(location.pathname === '/signup' ? 'signup' : 'login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [config, setConfig] = useState(null);

  useEffect(() => {
    Meta.config().then(setConfig).catch(() => {});
  }, []);

  // ?expired=1 is set by the API client when a session times out.
  useEffect(() => {
    if (searchParams.get('expired')) {
      toast({ kind: 'warn', title: 'Session expired', message: 'Please sign in again', timeout: 5200 });
    }
  }, [searchParams, toast]);

  const rawNext = searchParams.get('next') || location.state?.from || '/drive';
  // Never follow an off-site redirect.
  const from = typeof rawNext === 'string' && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/drive';

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signup') {
        await signup(name.trim() || email.split('@')[0], email.trim(), password);
        toast({ kind: 'success', title: 'Welcome to your cloud', message: 'Drop a file anywhere to upload it', timeout: 5200 });
      } else {
        await login(email.trim(), password);
      }
      // Warm the caches the drive needs on first paint.
      const drive = useDrive.getState();
      drive.loadStats();
      drive.loadFolders();
      drive.loadCapabilities();
      navigate(from, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const signupDisabled = config && config.allowSignup === false;

  return (
    <div className="auth-page">
      <section className="auth-hero">
        <div className="row" style={{ gap: 11 }}>
          <span className="brand-mark">
            <Send />
          </span>
          <div>
            <div className="brand-name">Telegram Cloud Drive</div>
            <div className="brand-sub">Store anything. Play it anywhere.</div>
          </div>
        </div>

        <div>
          <h1 className="auth-hero-title">
            Turn your Telegram account into an <span>unlimited cloud drive</span>
          </h1>
          <p className="auth-hero-sub">
            Upload documents, photos and videos — including HEVC iPhone recordings — and stream them back from any
            device, any time, with real seeking and one-click H.264 conversion.
          </p>
        </div>

        <div className="auth-features">
          {FEATURES.map((feature) => (
            <div className="auth-feature" key={feature.title}>
              <span className="auth-feature-icon">
                <feature.icon />
              </span>
              <div>
                <div className="auth-feature-title">{feature.title}</div>
                <div className="auth-feature-text">{feature.text}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="row" style={{ gap: 18, color: 'var(--faint)', fontSize: 12 }}>
          <span className="row" style={{ gap: 6 }}>
            <ShieldCheck size={14} /> Session strings encrypted at rest
          </span>
          <span className="row" style={{ gap: 6 }}>
            <HardDriveDownload size={14} /> Local fallback storage
          </span>
          <span className="row" style={{ gap: 6 }}>
            <Smartphone size={14} /> Works on mobile
          </span>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-card-head">
            <h2 className="auth-title">{mode === 'login' ? 'Sign in' : 'Create your account'}</h2>
            <p className="auth-sub">
              {mode === 'login'
                ? 'Your files are waiting in the cloud.'
                : 'Pick any email and password — this is your private drive.'}
            </p>
          </div>

          <div className="tabs" style={{ marginBottom: 18 }}>
            <button className="tab" data-active={mode === 'login'} onClick={() => { setMode('login'); setError(null); }}>
              Sign in
            </button>
            <button
              className="tab"
              data-active={mode === 'signup'}
              disabled={signupDisabled}
              onClick={() => { setMode('signup'); setError(null); }}
            >
              Create account
            </button>
          </div>

          <form className="auth-form" onSubmit={submit}>
            {mode === 'signup' ? (
              <div className="field">
                <label className="label" htmlFor="auth-name">
                  Name
                </label>
                <input
                  id="auth-name"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Abdul"
                  autoComplete="name"
                />
              </div>
            ) : null}

            <div className="field">
              <label className="label" htmlFor="auth-email">
                Email
              </label>
              <input
                id="auth-email"
                className="input"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="auth-password">
                Password
              </label>
              <input
                id="auth-password"
                className="input"
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'signup' ? 'At least 6 characters' : 'Your password'}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              />
            </div>

            {error ? (
              <div className="callout callout-danger">
                <Lock />
                <div>{error}</div>
              </div>
            ) : null}

            <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy || signupDisabled && mode === 'signup'}>
              {busy ? <Loader2 className="spin" /> : mode === 'login' ? <Send /> : <FolderSync />}
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          {signupDisabled && mode === 'signup' ? (
            <p className="hint" style={{ marginTop: 12 }}>
              Sign-ups are disabled on this server (ALLOW_SIGNUP=false). Ask the operator for an account.
            </p>
          ) : null}

          <div className="auth-alt">
            {mode === 'login' ? (
              <span>
                New here?{' '}
                <button className="btn btn-ghost btn-sm" onClick={() => setMode('signup')} disabled={signupDisabled}>
                  Create an account
                </button>
              </span>
            ) : (
              <span>
                Already have an account?{' '}
                <button className="btn btn-ghost btn-sm" onClick={() => setMode('login')}>
                  Sign in
                </button>
              </span>
            )}
          </div>

          <p className="tiny faint" style={{ marginTop: 16, lineHeight: 1.6 }}>
            After signing in, connect your Telegram account in Settings. Uploads stay disabled until then, and every
            uploaded file is stored in your Telegram cloud.
          </p>
        </div>
      </section>
    </div>
  );
}

export default LoginPage;
