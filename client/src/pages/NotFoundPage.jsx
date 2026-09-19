/** 404 page. */
import { Link, useNavigate } from 'react-router-dom';
import { Compass, HardDrive, Home } from 'lucide-react';
import { EmptyState } from '../components/common.jsx';
import { useAuth } from '../store/auth.js';

export function NotFoundPage() {
  const navigate = useNavigate();
  const status = useAuth((s) => s.status);

  return (
    <div className="public-page">
      <div className="public-card" style={{ maxWidth: 620 }}>
        <EmptyState icon={Compass} title="This page does not exist">
          The link you followed may be old, or the page may have moved. Your files are safe — head back to the drive.
          <div className="row" style={{ gap: 8, marginTop: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
            {status === 'authed' ? (
              <>
                <button className="btn btn-primary" onClick={() => navigate('/drive')}>
                  <HardDrive /> Go to My Drive
                </button>
                <button className="btn btn-outline" onClick={() => navigate(-1)}>
                  Go back
                </button>
              </>
            ) : (
              <Link className="btn btn-primary" to="/login">
                <Home /> Sign in
              </Link>
            )}
          </div>
        </EmptyState>
      </div>
    </div>
  );
}

export default NotFoundPage;
