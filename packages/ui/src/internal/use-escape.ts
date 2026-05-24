import { useEffect, useRef } from 'preact/hooks';

export function useEscape(callback: (event: KeyboardEvent) => void, enabled = true): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        callbackRef.current(event);
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [enabled]);
}
