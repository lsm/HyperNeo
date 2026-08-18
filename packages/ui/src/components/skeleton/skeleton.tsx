import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';

interface SkeletonProps {
  as?: ElementType;
  animation?: 'pulse' | 'wave' | 'none';
  children?: unknown;
  [key: string]: unknown;
}

function SkeletonFn({ as: Tag = 'div', animation = 'pulse', children, ...rest }: SkeletonProps) {
  const ourProps: Record<string, unknown> = {
    role: 'presentation',
    'aria-hidden': 'true',
    'data-slot': 'skeleton',
    'data-animation': animation,
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot: {},
    defaultTag: 'div',
    name: 'Skeleton',
  });
}

SkeletonFn.displayName = 'Skeleton';
export const Skeleton = SkeletonFn;
