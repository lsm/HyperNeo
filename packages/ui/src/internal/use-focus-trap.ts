import type { RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { focusElement, getFocusableElements } from './focus-management.ts';

export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  enabled = true,
  options: {
    initialFocus?: RefObject<HTMLElement | null>;
    restoreFocus?: boolean;
  } = {}
): void {
  const { initialFocus, restoreFocus = true } = options;
  const previousActiveElement = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    previousActiveElement.current = document.activeElement as HTMLElement;
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    if (initialFocus?.current) {
      focusElement(initialFocus.current);
    } else {
      const autoFocusEl = container.querySelector<HTMLElement>('[data-autofocus]');
      if (autoFocusEl) {
        focusElement(autoFocusEl);
      } else {
        const focusables = getFocusableElements(container);
        if (focusables.length > 0) {
          focusElement(focusables[0]);
        } else {
          if (container.tabIndex === -1 || container.getAttribute('tabindex') !== null) {
            focusElement(container);
          }
        }
      }
    }
  }, [enabled, containerRef, initialFocus]);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      if (!container) return;

      event.preventDefault();

      const focusables = getFocusableElements(container);
      if (focusables.length === 0) return;

      const active = document.activeElement as HTMLElement;
      const currentIndex = focusables.indexOf(active);

      if (event.shiftKey) {
        const nextIndex = currentIndex <= 0 ? focusables.length - 1 : currentIndex - 1;
        focusElement(focusables[nextIndex]);
      } else {
        const nextIndex = currentIndex >= focusables.length - 1 ? 0 : currentIndex + 1;
        focusElement(focusables[nextIndex]);
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);

      if (restoreFocus && previousActiveElement.current) {
        focusElement(previousActiveElement.current);
        previousActiveElement.current = null;
      }
    };
  }, [enabled, containerRef, restoreFocus]);
}
