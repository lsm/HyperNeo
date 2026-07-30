/**
 * StatusBadge Component
 *
 * A soft-bordered status chip driven by an indicator tone.
 */

import type { ComponentChildren } from 'preact';
import { INDICATOR_TONES, type IndicatorTone } from '../../lib/indicator-tokens';
import { cn } from '../../lib/utils';

export interface StatusBadgeProps {
  /** Indicator tone that drives the badge color. */
  tone: IndicatorTone;
  /** Badge text. */
  label?: string;
  /** Additional CSS classes. */
  className?: string;
  /** Child content; used when label is not provided. */
  children?: ComponentChildren;
}

/**
 * Render a soft status badge.
 */
export function StatusBadge({ tone, label, className, children }: StatusBadgeProps) {
  return (
    <span
      class={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        INDICATOR_TONES[tone].soft,
        className
      )}
    >
      {label ?? children}
    </span>
  );
}
