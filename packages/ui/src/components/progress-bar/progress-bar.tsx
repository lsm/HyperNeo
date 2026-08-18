import { createElement } from 'preact';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';

type ProgressBarSize = 'sm' | 'md' | 'lg';

interface ProgressBarProps {
  value: number | null | undefined;
  min?: number;
  max?: number;
  label?: string;
  showValue?: boolean;
  size?: ProgressBarSize;
  color?: string;
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function ProgressBarFn({
  value,
  min = 0,
  max = 100,
  label,
  showValue = false,
  size = 'md',
  color,
  as: Tag = 'div',
  children,
  ...rest
}: ProgressBarProps) {
  const isIndeterminate = value === null || value === undefined;

  const percentage = isIndeterminate
    ? 0
    : Math.min(100, Math.max(0, ((value! - min) / (max - min)) * 100));

  const slot = { value, percentage, indeterminate: isIndeterminate };

  const ourProps: Record<string, unknown> = {
    role: 'progressbar',
    'aria-valuenow': isIndeterminate ? undefined : value,
    'aria-valuemin': min,
    'aria-valuemax': max,
    'aria-valuetext': isIndeterminate ? undefined : `${Math.round(percentage)}%`,
    'aria-label': label,
    'data-value': value ?? undefined,
    'data-min': min,
    'data-max': max,
    'data-size': size,
    'data-indeterminate': isIndeterminate ? '' : undefined,
  };

  const fillStyle = isIndeterminate
    ? { width: '100%' }
    : color
      ? { width: `${percentage}%`, backgroundColor: color }
      : { width: `${percentage}%` };

  const fillElement = createElement('div', {
    'data-progress-fill': true,
    style: fillStyle,
  });

  const labelElement =
    showValue && !isIndeterminate
      ? createElement('span', { 'data-progress-value': true }, `${Math.round(percentage)}%`)
      : null;

  const content = [fillElement, labelElement, children].filter(Boolean);

  return render({
    ourProps,
    theirProps: { as: Tag, children: content, ...rest },
    slot,
    defaultTag: 'div',
    name: 'ProgressBar',
  });
}

ProgressBarFn.displayName = 'ProgressBar';
export const ProgressBar = ProgressBarFn;
