/**
 * useClickOutside Hook
 *
 * Detects clicks outside of a referenced element and calls a handler.
 * Useful for closing dropdowns, modals, and popovers.
 *
 * @example
 * ```typescript
 * const menuRef = useRef<HTMLDivElement>(null);
 * useClickOutside(menuRef, () => setMenuOpen(false), menuOpen);
 * ```
 */

import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';

/**
 * Hook that calls handler when clicking outside the referenced element
 *
 * @param ref - Ref to the element to detect clicks outside of
 * @param handler - Callback when click outside is detected
 * @param enabled - Whether the listener is active (default: true)
 * @param excludeRefs - Additional refs to exclude from outside detection
 */
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

      // Check if click is inside main ref
      if (ref.current && ref.current.contains(target)) {
        return;
      }

      // Check if click is inside any excluded refs
      for (const excludeRef of excludeRefs) {
        if (excludeRef.current && excludeRef.current.contains(target)) {
          return;
        }
      }

      // Click was outside - call handler
      handler();
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handler();
      }
    };

    // Delay to avoid triggering from the same click that opened the element
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
