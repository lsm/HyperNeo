import { useRef } from 'preact/hooks';
import { useIsoMorphicEffect } from './use-iso-morphic-effect.ts';

/**
 * A hook that keeps a ref in sync with the latest value.
 *
 * This is useful when you need to access the current value of a prop or state
 * inside an effect, event handler, or callback without adding it to the dependency
 * array (which would cause unnecessary re-renders or re-executions).
 *
 * The ref is updated synchronously after every render using useIsoMorphicEffect,
 * ensuring the value is always current.
 *
 * @param value - The value to keep in sync
 * @returns A ref containing the latest value
 *
 * @example
 * ```tsx
 * function MyComponent({ onClick }) {
 *   const latestOnClick = useLatestValue(onClick);
 *
 *   useEffect(() => {
 *     const handler = (e) => latestOnClick.current(e);
 *     document.addEventListener('click', handler);
 *     return () => document.removeEventListener('click', handler);
 *   }, []); // No need to include onClick in deps
 * }
 * ```
 */
export function useLatestValue<T>(value: T): { readonly current: T } {
  const cache = useRef(value);

  useIsoMorphicEffect(() => {
    cache.current = value;
  }, [value]);

  return cache;
}
