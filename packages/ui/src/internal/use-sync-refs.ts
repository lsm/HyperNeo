import { useEffect, useRef } from 'preact/hooks';
import { useEvent } from './use-event.ts';

const Optional = Symbol('optional');

/**
 * Marks a ref callback as optional, meaning it can be skipped when determining
 * if all refs are optional (in which case useSyncRefs returns undefined).
 *
 * @param cb - The ref callback to mark as optional
 * @param isOptional - Whether this ref is optional (default: true)
 *
 * @example
 * ```tsx
 * const ref = useSyncRefs(
 *   externalRef,
 *   optionalRef((el) => console.log('Got element'))
 * );
 * ```
 */
export function optionalRef<T>(
  cb: (ref: T) => void,
  isOptional = true
): ((instance: T) => void) & {
  [Optional]: boolean;
} {
  return Object.assign(cb, { [Optional]: isOptional });
}

/**
 * A hook that combines multiple refs into a single callback ref.
 *
 * When the returned callback ref is called with an element, it forwards that
 * element to all provided refs. This is useful when multiple parts of your
 * code need access to the same DOM element.
 *
 * Supports both callback refs and object refs (MutableRefObject).
 *
 * If all provided refs are null or marked as optional, returns undefined
 * instead of a function.
 *
 * @param refs - Array of refs to sync (can be callback refs, object refs, or null)
 * @returns A single callback ref that forwards to all provided refs, or undefined
 *
 * @example
 * ```tsx
 * function Input(props) {
 *   const internalRef = useRef(null);
 *   const ref = useSyncRefs(internalRef, props.ref);
 *
 *   return <input ref={ref} />;
 * }
 * ```
 */
export function useSyncRefs<T>(
  ...refs: (import('preact').RefObject<T | null> | ((instance: T) => void) | null)[]
): import('preact').RefCallback<T> | undefined {
  const cache = useRef(refs);

  // Keep the refs array up to date
  useEffect(() => {
    cache.current = refs;
  }, [refs]);

  const syncRefs = useEvent((value: T | null) => {
    for (const ref of cache.current) {
      if (ref == null) continue;
      if (typeof ref === 'function') {
        ref(value as T);
      } else {
        ref.current = value;
      }
    }
  });

  // Return undefined if all refs are null or optional
  return refs.every(
    (ref) =>
      ref == null ||
      // @ts-expect-error - checking for Optional symbol
      ref?.[Optional]
  )
    ? undefined
    : syncRefs;
}
