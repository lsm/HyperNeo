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
  const wrapperClass = cn(
    'inline-flex flex-shrink-0 items-center justify-center rounded-full',
    sizeClasses[size],
    className
  );
  // The dot is rendered once and shared across the two branches below.
  const dot = <span class={cn('rounded-full w-full h-full', bgClass, pulse && 'animate-pulse')} />;

  // A labeled dot exposes an accessible image. An unlabeled dot is decorative
  // (the status should also be conveyed by adjacent text), so it is hidden
  // from assistive tech rather than announced as an unnamed graphic.
  if (ariaLabel) {
    return (
      <span class={wrapperClass} role="img" aria-label={ariaLabel}>
        {dot}
      </span>
    );
  }
  return (
    <span class={wrapperClass} aria-hidden="true">
      {dot}
    </span>
  );
}
