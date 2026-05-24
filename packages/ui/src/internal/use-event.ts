import { useCallback } from 'preact/hooks';
import { useLatestValue } from './use-latest-value.ts';

/**
 * A hook that returns a stable callback function that always invokes the latest
 * version of the provided callback.
 *
 * This solves the "stale closure" problem where callbacks capture old values from
 * when they were created. The returned function is stable (same reference across
 * renders), making it safe to use in dependency arrays.
 *
 * This is similar to the proposed React useEvent hook (RFC).
 *
 * @param cb - The callback function to wrap
 * @returns A stable callback that always calls the latest version of cb
 *
 * @example
 * ```tsx
 * function MyComponent({ count, onClick }) {
 *   // Even though onClick might change, handleClick is stable
 *   const handleClick = useEvent(() => {
 *     onClick(count); // Always uses latest count and onClick
 *   });
 *
 *   // Safe to use in deps - handleClick never changes
 *   useEffect(() => {
 *     element.addEventListener('click', handleClick);
 *     return () => element.removeEventListener('click', handleClick);
 *   }, [handleClick]);
 * }
 * ```
 */
export function useEvent<F extends (...args: never[]) => unknown>(
  cb: F
): (...args: Parameters<F>) => ReturnType<F> {
  const cache = useLatestValue(cb);
  return useCallback((...args: Parameters<F>) => cache.current(...args) as ReturnType<F>, [cache]);
}
