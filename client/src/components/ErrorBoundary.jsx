/**
 * Keeps a single broken page from blanking the whole app: the shell stays up,
 * the error is reported, and the user can retry or go home.
 */
import { Component } from 'react';
import { AlertTriangle, Home, RefreshCw } from 'lucide-react';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface it in the console (and any future error reporter) with context.
    console.error('[Telegram Cloud] render error:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="empty anim-rise" role="alert">
        <div className="empty-icon" style={{ color: 'var(--danger)' }}>
          <AlertTriangle />
        </div>
        <div className="empty-title">This view hit an unexpected error</div>
        <div className="empty-text">
          <span className="mono small">{String(error?.message || error)}</span>
          <p className="hint" style={{ marginTop: 10 }}>
            Your files are safe — this is only a rendering problem. Reload the view, or head back to the drive.
          </p>
        </div>
        <div className="row" style={{ marginTop: 14, gap: 8 }}>
          <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>
            <RefreshCw /> Try again
          </button>
          <a className="btn btn-outline" href="/drive">
            <Home /> Back to My Drive
          </a>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
