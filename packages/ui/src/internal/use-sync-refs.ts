import { useEffect, useRef } from 'preact/hooks';
import { useEvent } from './use-event.ts';

const Optional = Symbol('optional');

export function optionalRef<T>(
  cb: (ref: T) => void,
  isOptional = true
): ((instance: T) => void) & {
  [Optional]: boolean;
} {
  return Object.assign(cb, { [Optional]: isOptional });
}

export function useSyncRefs<T>(
  ...refs: (import('preact').RefObject<T | null> | ((instance: T) => void) | null)[]
): import('preact').RefCallback<T> | undefined {
  const cache = useRef(refs);

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

  return refs.every(
    (ref) =>
      ref == null ||
      // @ts-expect-error - checking for Optional symbol
      ref?.[Optional]
  )
    ? undefined
    : syncRefs;
}
