import type { ComponentChildren } from 'preact';
import type { ElementType } from '../../internal/types.ts';

interface TouchTargetProps {
  as?: ElementType;
  children?: ComponentChildren;
  class?: string;
  [key: string]: unknown;
}

function TouchTargetFn({
  as: Tag = 'span',
  children,
  class: className,
  ...rest
}: TouchTargetProps) {
  const ourProps: Record<string, unknown> = {
    'aria-hidden': 'true',
    className,
    style: {
      position: 'absolute',
      inset: '0',
    },
  };

  return (
    <Tag {...ourProps} {...rest}>
      {children}
    </Tag>
  );
}

TouchTargetFn.displayName = 'TouchTarget';
export const TouchTarget = TouchTargetFn;
