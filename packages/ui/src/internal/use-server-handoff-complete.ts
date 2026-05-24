import { useEffect, useState } from 'preact/hooks';
import { env } from './env.ts';

/**
 * A hook that returns true when the server-to-client handoff is complete.
 *
 * This is important for SSR (Server-Side Rendering) scenarios where you need
 * to know when it's safe to use client-only features after hydration.
 *
 * During SSR and initial hydration, this returns false. After hydration
 * completes, it returns true.
 *
 * @returns true if the server handoff is complete, false otherwise
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const ready = useServerHandoffComplete();
 *
 *   if (!ready) {
 *     return null; // Don't render until hydration is complete
 *   }
 *
 *   return <div>Client-side content</div>;
 * }
 * ```
 */
export function useServerHandoffComplete(): boolean {
  const [complete, setComplete] = useState(env.isHandoffComplete);

  if (complete && env.isHandoffComplete === false) {
    // This means we are in a test environment and we need to reset the handoff state
    // This kinda breaks the rules of Preact but this is only used for testing purposes
    // And should theoretically be fine
    setComplete(false);
  }

  useEffect(() => {
    if (complete === true) return;
    setComplete(true);
  }, [complete]);

  // Transition from pending to complete (forcing a re-render when server rendering)
  useEffect(() => env.handoff(), []);

  return complete;
}
