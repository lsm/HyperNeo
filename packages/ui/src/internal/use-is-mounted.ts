import { useRef } from 'preact/hooks';
import { useIsoMorphicEffect } from './use-iso-morphic-effect.ts';

/**
 * A hook that returns a ref indicating whether the component is currently mounted.
 *
 * This is useful for avoiding state updates after a component has unmounted,
 * especially in async operations.
 *
 * @returns A ref that is `true` when the component is mounted, `false` otherwise
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const isMounted = useIsMounted();
 *
 *   useEffect(() => {
 *     fetchData().then((data) => {
 *       if (isMounted.current) {
 *         setState(data);
 *       }
 *     });
 *   }, []);
 * }
 * ```
 */
export function useIsMounted(): { readonly current: boolean } {
  const mounted = useRef(false);

  useIsoMorphicEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  return mounted;
}
