import { useCallback } from 'preact/hooks';
import { useLatestValue } from './use-latest-value.ts';

export function useEvent<F extends (...args: never[]) => unknown>(
  cb: F
): (...args: Parameters<F>) => ReturnType<F> {
  const cache = useLatestValue(cb);
  return useCallback((...args: Parameters<F>) => cache.current(...args) as ReturnType<F>, [cache]);
}
