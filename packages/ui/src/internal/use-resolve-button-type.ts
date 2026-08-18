import { useMemo } from 'preact/hooks';
import type { ElementType } from './types.ts';

type HasAsProp = {
  as?: ElementType | undefined;
};

type HasTypeProp = {
  type?: string | undefined;
};

export function useResolveButtonType(
  props: HasAsProp & HasTypeProp,
  element: HTMLElement | null
): string | undefined {
  return useMemo(() => {
    if (props.type) return props.type;

    if (props.as !== undefined && props.as !== 'button') {
      return undefined;
    }

    const tagName = element?.tagName?.toLowerCase();

    if (tagName === 'button') {
      return 'button';
    }

    return undefined;
  }, [props.type, props.as, element?.tagName]);
}
