/** Router, auth guard and app bootstrap. */
import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Cloud } from 'lucide-react';
import { useAuth } from './store/auth.js';
import { useUi } from './store/ui.js';
import { useDrive } from './store/drive.js';
import uploadQueue from './lib/uploadQueue.js';
import AppShell from './components/AppShell.jsx';
import { Spinner } from './components/common.jsx';
import LoginPage from './pages/LoginPage.jsx';
import DrivePage from './pages/DrivePage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import SharesPage from './pages/SharesPage.jsx';
import SharedPage from './pages/SharedPage.jsx';
import PrivacyPage from './pages/PrivacyPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';

function BootScreen({ label = 'Loading your cloud…' }) {
  return (
    <div className="boot-screen">
      <div className="boot-card" role="status" aria-live="polite">
        <span className="boot-logo"><Cloud /></span>
        <div className="boot-title">ZoZoCloud</div>
        <div className="boot-label"><Spinner size={16} /> {label}</div>
      </div>
    </div>
  );
}

function RequireAuth({ children }) {
  const status = useAuth((s) => s.status);
  const location = useLocation();

  if (status === 'loading') return <BootScreen />;
  if (status !== 'authed') {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  return children;
}

/** Logged-in users skip the auth page. */
function PublicOnly({ children }) {
  const status = useAuth((s) => s.status);
  if (status === 'loading') return <BootScreen label="Checking your session…" />;
  if (status === 'authed') return <Navigate to="/drive" replace />;
  return children;
}

export default function App() {
  const bootstrap = useAuth((s) => s.bootstrap);
  const user = useAuth((s) => s.user);
  const applyTheme = useUi((s) => s.applyTheme);
  const setTheme = useUi((s) => s.setTheme);

  useEffect(() => {
    applyTheme();
    bootstrap();
  }, [bootstrap, applyTheme]);

  // Honour the theme saved in the profile on first load.
  useEffect(() => {
    const preferred = user?.settings?.theme;
    if (preferred && preferred !== useUi.getState().theme) setTheme(preferred);
  }, [user?.settings?.theme, setTheme]);

  // Upload concurrency from the profile.
  useEffect(() => {
    const n = Number(user?.settings?.uploadConcurrency);
    if (n >= 1 && n <= 8) uploadQueue.setConcurrency({ fileConcurrency: n });
  }, [user?.settings?.uploadConcurrency]);

  // Reset library state when the signed-in user changes.
  useEffect(() => {
    if (!user) useDrive.getState().reset();
  }, [user]);

  return (
    <BrowserRouter future={{ v7_relativeSplatPath: true }}>
      <Routes>
        <Route
          path="/login"
          element={
            <PublicOnly>
              <LoginPage />
            </PublicOnly>
          }
        />
        <Route
          path="/signup"
          element={
            <PublicOnly>
              <LoginPage />
            </PublicOnly>
          }
        />

        {/* Public share links live outside the shell. */}
        <Route path="/s/:token" element={<SharedPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />

        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route path="/" element={<Navigate to="/drive" replace />} />
          <Route path="/drive" element={<DrivePage view="folder" />} />
          <Route path="/drive/f/:folderId" element={<DrivePage view="folder" />} />
          <Route path="/photos" element={<DrivePage view="photos" />} />
          <Route path="/videos" element={<DrivePage view="videos" />} />
          <Route path="/music" element={<DrivePage view="audio" />} />
          <Route path="/documents" element={<DrivePage view="docs" />} />
          <Route path="/starred" element={<DrivePage view="starred" />} />
          <Route path="/recent" element={<DrivePage view="recent" />} />
          <Route path="/trash" element={<DrivePage view="trash" />} />
          <Route path="/search" element={<DrivePage view="search" />} />
          <Route path="/shared" element={<SharesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="*"
            element={
              <NotFoundPage />
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
