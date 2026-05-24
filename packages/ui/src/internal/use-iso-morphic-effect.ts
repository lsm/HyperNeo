import { useEffect, useLayoutEffect } from 'preact/hooks';
import { env } from './env.ts';

/**
 * A hook that uses useLayoutEffect on the client and useEffect on the server.
 *
 * This is important for SSR (Server-Side Rendering) because useLayoutEffect
 * triggers a warning when rendered on the server. By using useEffect on the
 * server, we avoid these warnings while still getting the synchronous behavior
 * of useLayoutEffect on the client.
 *
 * The term "iso-morphic" refers to code that runs the same way on both
 * server and client, adapting to the environment.
 *
 * @param effect - The effect callback to run
 * @param deps - Dependency array (same as useEffect/useLayoutEffect)
 *
 * @example
 * ```tsx
 * useIsoMorphicEffect(() => {
 *   // This runs synchronously after render on client
 *   // but asynchronously on server
 * }, [dependency]);
 * ```
 */
export const useIsoMorphicEffect: typeof useEffect = (effect, deps) => {
  if (env.isServer) {
    useEffect(effect, deps);
  } else {
    useLayoutEffect(effect, deps);
  }
};
