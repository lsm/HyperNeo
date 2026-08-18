import { useEffect, useLayoutEffect } from 'preact/hooks';
import { env } from './env.ts';

export const useIsoMorphicEffect: typeof useEffect = (effect, deps) => {
  if (env.isServer) {
    useEffect(effect, deps);
  } else {
    useLayoutEffect(effect, deps);
  }
};
