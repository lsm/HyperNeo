import { useRef } from 'preact/hooks';
import { useIsoMorphicEffect } from './use-iso-morphic-effect.ts';

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
