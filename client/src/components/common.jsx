/** Shared primitives: modal, confirm dialog, empty state, skeletons, toasts. */
import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, FileQuestion, Info, X, XCircle } from 'lucide-react';
import { useUi } from '../store/ui.js';

export function Modal({ open, onClose, title, subtitle, children, footer, width = 'normal', icon: Icon }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    };
    document.addEventListener('keydown', onKey);
    // Focus the first input for fast typing.
    const timer = setTimeout(() => {
      const input = ref.current?.querySelector('input:not([type=hidden]), textarea, select, button[data-autofocus]');
      input?.focus?.();
      if (input?.select) input.select();
    }, 40);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(timer);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className={clsx('modal', width === 'wide' && 'modal-wide')} ref={ref} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <div className="row" style={{ gap: 11, minWidth: 0 }}>
            {Icon ? (
              <span className="folder-icon" style={{ width: 34, height: 34 }}>
                <Icon />
              </span>
            ) : null}
            <div style={{ minWidth: 0 }}>
              <h3 className="modal-title truncate">{title}</h3>
              {subtitle ? <p className="hint" style={{ marginTop: 3 }}>{subtitle}</p> : null}
            </div>
          </div>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  tone = 'danger',
  busy = false,
}) {
  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      title={title}
      icon={tone === 'danger' ? AlertTriangle : Info}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={clsx('btn', tone === 'danger' ? 'btn-danger' : 'btn-primary')} onClick={onConfirm} disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="small" style={{ color: 'var(--text-soft)', lineHeight: 1.6 }}>
        {message}
      </p>
    </Modal>
  );
}

export function EmptyState({ icon: Icon = FileQuestion, title, children, action }) {
  return (
    <div className="empty anim-rise">
      <div className="empty-icon">
        <Icon />
      </div>
      <div className="empty-title">{title}</div>
      {children ? <div className="empty-text">{children}</div> : null}
      {action ? <div className="row" style={{ marginTop: 6 }}>{action}</div> : null}
    </div>
  );
}

export function GridSkeleton({ count = 12 }) {
  return (
    <div className="file-grid">
      {Array.from({ length: count }).map((_, i) => (
        <div className="file-card" key={i} style={{ pointerEvents: 'none' }}>
          <div className="file-card-thumb skeleton" />
          <div className="file-card-body">
            <div className="skeleton" style={{ height: 12, width: '82%' }} />
            <div className="skeleton" style={{ height: 10, width: '48%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ListSkeleton({ count = 8 }) {
  return (
    <div className="file-list">
      {Array.from({ length: count }).map((_, i) => (
        <div className="list-row" key={i} style={{ pointerEvents: 'none' }}>
          <div className="skeleton" style={{ width: 18, height: 18, borderRadius: 5 }} />
          <div className="row" style={{ gap: 10 }}>
            <div className="skeleton" style={{ width: 38, height: 38, borderRadius: 9 }} />
            <div className="skeleton" style={{ height: 12, width: '46%', minWidth: 120 }} />
          </div>
          <div className="skeleton" style={{ height: 11, width: 60 }} />
          <div className="skeleton" style={{ height: 11, width: 90 }} />
          <div className="skeleton" style={{ height: 11, width: 70 }} />
          <div />
        </div>
      ))}
    </div>
  );
}

const TOAST_ICON = {
  success: CheckCircle2,
  error: XCircle,
  warn: AlertTriangle,
  info: Info,
};
const TOAST_COLOR = {
  success: 'var(--ok)',
  error: 'var(--danger)',
  warn: 'var(--warn)',
  info: 'var(--brand)',
};

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = TOAST_ICON[toast.kind] || Info;
        return (
          <div className="toast" data-kind={toast.kind} key={toast.id}>
            <span className="toast-icon" style={{ color: TOAST_COLOR[toast.kind] }}>
              <Icon size={17} />
            </span>
            <div className="toast-body">
              {toast.title ? <div className="toast-title">{toast.title}</div> : null}
              {toast.message ? <div className="toast-msg">{toast.message}</div> : null}
              {toast.action ? (
                <button className="btn btn-sm btn-ghost" style={{ marginTop: 6, paddingLeft: 0 }} onClick={toast.action.onClick}>
                  {toast.action.label}
                </button>
              ) : null}
            </div>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function Spinner({ size = 16, className }) {
  return <span className={clsx('spinner', className)} style={{ width: size, height: size }} />;
}

export function Progress({ percent, state = 'active', thin = false, indeterminate = false }) {
  return (
    <div className={clsx('progress', thin && 'progress-thin', indeterminate && 'progress-indeterminate')}>
      <div className="progress-bar" data-state={state} style={{ width: `${Math.max(0, Math.min(100, percent || 0))}%` }} />
    </div>
  );
}

export function Badge({ children, tone = '', icon: Icon, className, ...rest }) {
  return (
    <span className={clsx('badge', tone && `badge-${tone}`, className)} {...rest}>
      {Icon ? <Icon /> : null}
      {children}
    </span>
  );
}

export default { Modal, ConfirmDialog, EmptyState, GridSkeleton, ListSkeleton, Toasts, Spinner, Progress, Badge };
