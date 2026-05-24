import { useCallback, useRef } from 'preact/hooks';

interface Pointer {
  x: number;
  y: number;
}

export function useTrackedPointer(): {
  wasMoved: (event: PointerEvent) => boolean;
  update: (event: PointerEvent) => void;
} {
  const pointer = useRef<Pointer>({ x: -1, y: -1 });

  return {
    wasMoved: useCallback((event: PointerEvent) => {
      // First event — initialize
      if (pointer.current.x === -1 && pointer.current.y === -1) {
        pointer.current = { x: event.screenX, y: event.screenY };
        return false;
      }
      // Check if pointer actually moved (prevents hover events from keyboard scrolling)
      if (pointer.current.x !== event.screenX || pointer.current.y !== event.screenY) {
        pointer.current = { x: event.screenX, y: event.screenY };
        return true;
      }
      return false;
    }, []),
    update: useCallback((event: PointerEvent) => {
      pointer.current = { x: event.screenX, y: event.screenY };
    }, []),
  };
}
