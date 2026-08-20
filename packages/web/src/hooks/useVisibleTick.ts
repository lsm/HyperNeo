import { useEffect, useRef, useState } from 'preact/hooks';

export function useVisibleTick(intervalMs: number, enabled = true, onTick?: () => void): void {
  const [, setTick] = useState(0);
  const onTickRef = useRef(onTick);

  useEffect(() => {
    onTickRef.current = onTick;
  });

  useEffect(() => {
    if (typeof document === 'undefined' || !enabled) return;
    const fire = () => {
      if (onTickRef.current) {
        onTickRef.current();
      } else {
        setTick((n) => n + 1);
      }
    };
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id === null) id = setInterval(fire, intervalMs);
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        fire();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, enabled]);
}
