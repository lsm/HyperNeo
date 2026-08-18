import { useRef } from 'preact/hooks';
import { dataAttributes, useInteractionState } from '../../internal/data-attributes.ts';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';

interface IconButtonProps {
  as?: ElementType;
  label: string;
  type?: string;
  disabled?: boolean;
  children?: unknown;
  [key: string]: unknown;
}

function IconButtonFn({
  as: Tag = 'button',
  label,
  type,
  disabled = false,
  children,
  ...rest
}: IconButtonProps) {
  const ref = useRef<HTMLElement | null>(null);
  const { hover, focus, active } = useInteractionState(ref, { disabled });

  const resolvedType = Tag === 'button' ? (type ?? 'button') : type;

  const slot = { hover, focus, active, disabled };

  const ourProps: Record<string, unknown> = {
    ref,
    'aria-label': label,
    disabled: disabled || undefined,
    ...(resolvedType !== undefined ? { type: resolvedType } : {}),
    ...dataAttributes(slot),
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'button',
    name: 'IconButton',
  });
}

IconButtonFn.displayName = 'IconButton';
export const IconButton = IconButtonFn;
