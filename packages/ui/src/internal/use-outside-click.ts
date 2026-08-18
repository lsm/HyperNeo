import type { RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

export function useOutsideClick(
  containers: RefObject<HTMLElement | null>[] | (() => (HTMLElement | null)[]),
  callback: (event: MouseEvent | PointerEvent | FocusEvent, target: HTMLElement) => void,
  enabled = true
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return;

    function handleClick(event: MouseEvent | PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target) return;
      if (!target.getRootNode().contains(target)) return;

      const _containers =
        typeof containers === 'function' ? containers() : containers.map((ref) => ref.current);

      for (const container of _containers) {
        if (!container) continue;
        if (container.contains(target)) return;
      }

      callbackRef.current(event, target);
    }

    const timer = setTimeout(() => {
      document.addEventListener('pointerdown', handleClick, true);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', handleClick, true);
    };
  }, [enabled, containers]);
}
