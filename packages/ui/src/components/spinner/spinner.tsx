import { createElement, Fragment } from 'preact';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';

interface SpinnerProps {
  as?: ElementType;
  label?: string;
  children?: unknown;
  [key: string]: unknown;
}

function SpinnerFn({ as: Tag = 'span', label = 'Loading', children, ...rest }: SpinnerProps) {
  const srOnlyStyle = {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: '0',
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0,0,0,0)',
    whiteSpace: 'nowrap',
    borderWidth: '0',
  };

  const srSpan = createElement('span', { style: srOnlyStyle }, label);
  const slotContent = createElement(Fragment, null, [srSpan, children]);

  const ourProps: Record<string, unknown> = {
    role: 'status',
    'aria-label': label,
    'data-slot': 'spinner',
  };

  return render({
    ourProps,
    theirProps: { as: Tag, children: slotContent, ...rest },
    slot: {},
    defaultTag: 'span',
    name: 'Spinner',
  });
}

SpinnerFn.displayName = 'Spinner';
export const Spinner = SpinnerFn;
