/**
 * StatusDot Component
 *
 * A small solid dot indicator driven by an indicator tone. Supports a subtle
 * pulse animation for active/attention states.
 */

import { INDICATOR_TONES, type IndicatorTone } from '../../lib/indicator-tokens';
import { cn } from '../../lib/utils';

export interface StatusDotProps {
  /** Indicator tone that drives the dot color. */
  tone: IndicatorTone;
  /** Dot size. */
  size?: 'xs' | 'sm' | 'md';
  /** Whether the dot should pulse. */
  pulse?: boolean;
  /** Additional CSS classes. */
  className?: string;
  /** Accessible label for the dot. */
  'aria-label'?: string;
}

const sizeClasses = {
  xs: 'w-1.5 h-1.5',
  sm: 'w-2 h-2',
  md: 'w-2.5 h-2.5',
} as const;

/**
 * Render a status dot.
 */
export function StatusDot({
  tone,
  size = 'sm',
  pulse = false,
  className,
  'aria-label': ariaLabel,
}: StatusDotProps) {
  const bgClass = INDICATOR_TONES[tone].bg;

  return (
    <span
      class={cn(
        'inline-flex items-center justify-center rounded-full',
        sizeClasses[size],
        className
      )}
      aria-label={ariaLabel}
      role="img"
    >
      <span class={cn('rounded-full w-full h-full', bgClass, pulse && 'animate-pulse')} />
    </span>
  );
}
