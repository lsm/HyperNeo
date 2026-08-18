import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';

export function useClickOutside(
  ref: RefObject<HTMLElement>,
  handler: () => void,
  enabled = true,
  excludeRefs: RefObject<HTMLElement>[] = []
): void {
  useEffect(() => {
    if (!enabled) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;

      if (ref.current && ref.current.contains(target)) {
        return;
      }

      for (const excludeRef of excludeRefs) {
        if (excludeRef.current && excludeRef.current.contains(target)) {
          return;
        }
      }

      handler();
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handler();
      }
    };

    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [ref, handler, enabled, excludeRefs]);
}
