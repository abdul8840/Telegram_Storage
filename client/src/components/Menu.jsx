/** Positioned dropdown / context menu with viewport clamping. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';

export function Menu({ open, anchor, onClose, children, align = 'right', width = 216 }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ top: -9999, left: -9999 });

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const rect = anchor.getBoundingClientRect?.() || anchor;
    const el = ref.current;
    const menuWidth = el?.offsetWidth || width;
    const menuHeight = el?.offsetHeight || 240;
    const margin = 10;

    let left = align === 'right' ? rect.right - menuWidth : rect.left;
    let top = rect.bottom + 6;
    if (top + menuHeight > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - menuHeight - 6);
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - menuWidth - margin));
    setPos({ top, left });
  }, [open, anchor, align, width]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose?.();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    const onScroll = () => onClose?.();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="menu" ref={ref} style={{ top: pos.top, left: pos.left, width }} role="menu">
      {children}
    </div>
  );
}

export function MenuItem({ children, icon: Icon, onClick, danger = false, disabled = false, shortcut, closeOnSelect = true, onClose }) {
  return (
    <button
      className={clsx('menu-item', danger && 'menu-item-danger')}
      role="menuitem"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        onClick?.(e);
        if (closeOnSelect) onClose?.();
      }}
    >
      {Icon ? <Icon /> : null}
      <span className="truncate">{children}</span>
      {shortcut ? <span className="menu-shortcut">{shortcut}</span> : null}
    </button>
  );
}

export const MenuSeparator = () => <div className="menu-sep" />;
export const MenuLabel = ({ children }) => <div className="menu-label">{children}</div>;

export default Menu;
