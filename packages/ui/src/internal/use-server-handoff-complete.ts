import { useEffect, useState } from 'preact/hooks';
import { env } from './env.ts';

export function useServerHandoffComplete(): boolean {
  const [complete, setComplete] = useState(env.isHandoffComplete);

  if (complete && env.isHandoffComplete === false) {
    setComplete(false);
  }

  useEffect(() => {
    if (complete === true) return;
    setComplete(true);
  }, [complete]);

  useEffect(() => env.handoff(), []);

  return complete;
}
