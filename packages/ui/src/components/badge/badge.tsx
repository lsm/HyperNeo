import { createElement } from 'preact';
import { useCallback, useState } from 'preact/hooks';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';

type BadgeVariant = 'subtle' | 'outline' | 'solid';
type BadgeColor = 'gray' | 'red' | 'yellow' | 'green' | 'blue' | 'indigo' | 'purple' | 'pink';
type BadgeSize = 'sm' | 'md';
type BadgeShape = 'rounded' | 'pill' | 'square';

interface BadgeProps {
  variant?: BadgeVariant;
  color?: BadgeColor;
  size?: BadgeSize;
  shape?: BadgeShape;
  dot?: boolean;
  removable?: boolean;
  onRemove?: () => void;
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function BadgeFn({
  variant = 'subtle',
  color = 'gray',
  size = 'md',
  shape = 'rounded',
  dot = false,
  removable = false,
  onRemove,
  as: Tag = 'span',
  children,
  ...rest
}: BadgeProps) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(false);

  const handleRemove = useCallback(() => {
    onRemove?.();
  }, [onRemove]);

  const slot = { hover, focus, active };

  const ourProps: Record<string, unknown> = {
    'data-variant': variant,
    'data-color': color,
    'data-size': size,
    'data-shape': shape,
    'data-dot': dot ? '' : undefined,
    'data-removable': removable ? '' : undefined,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    onMouseDown: () => setActive(true),
    onMouseUp: () => setActive(false),
  };

  const dotElement = dot
    ? createElement('svg', {
        'aria-hidden': 'true',
        viewBox: '0 0 6 6',
        className: 'badge-dot',
        children: createElement('circle', {
          cx: '3',
          cy: '3',
          r: '3',
          fill: 'currentColor',
        }),
      })
    : null;

  const removeButton = removable
    ? createElement('button', {
        type: 'button',
        'aria-label': 'Remove',
        onClick: handleRemove,
        className: 'badge-remove',
        children: createElement('svg', {
          'aria-hidden': 'true',
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': '2',
          children: createElement('path', {
            d: 'M4 4l8 8m0-8l-8 8',
          }),
        }),
      })
    : null;

  const badgeContent = [dotElement, children, removeButton].filter(Boolean);

  return render({
    ourProps,
    theirProps: { as: Tag, children: badgeContent, ...rest },
    slot,
    defaultTag: 'span',
    name: 'Badge',
  });
}

BadgeFn.displayName = 'Badge';
export const Badge = BadgeFn;
