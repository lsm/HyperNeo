import { useRef } from 'preact/hooks';
import { useIsoMorphicEffect } from './use-iso-morphic-effect.ts';

export function useLatestValue<T>(value: T): { readonly current: T } {
  const cache = useRef(value);

  useIsoMorphicEffect(() => {
    cache.current = value;
  }, [value]);

  return cache;
}
