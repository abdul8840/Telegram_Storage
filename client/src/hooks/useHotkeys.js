/** Global keyboard shortcuts for the drive. */
import { useEffect } from 'react';

/**
 * @param {Record<string, (e:KeyboardEvent)=>void>} map  e.g. { '/': fn, 'mod+a': fn, 'Escape': fn }
 */
export function useHotkeys(map, { enabled = true } = {}) {
  useEffect(() => {
    if (!enabled) return undefined;
    const handler = (event) => {
      const target = event.target;
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);

      for (const [combo, fn] of Object.entries(map)) {
        const parts = combo.toLowerCase().split('+');
        const key = parts[parts.length - 1];
        const needMod = parts.includes('mod');
        const needShift = parts.includes('shift');
        const hasMod = event.metaKey || event.ctrlKey;

        const keyMatches = key === 'escape' ? event.key === 'Escape' : event.key.toLowerCase() === key;
        if (!keyMatches) continue;
        if (needMod !== hasMod) continue;
        if (needShift !== event.shiftKey) continue;
        // Shortcuts without modifiers must not fire while typing.
        if (typing && !needMod && key !== 'escape') continue;

        event.preventDefault();
        fn(event);
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [map, enabled]);
}

export default useHotkeys;
