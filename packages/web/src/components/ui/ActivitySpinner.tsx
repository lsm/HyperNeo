/**
 * ActivitySpinner Component
 *
 * A small tone-aware spinner for list rows and inline activity indicators.
 * Wraps the base Spinner component and derives its border color from the
 * indicator tone.
 */

import { INDICATOR_TONES, type IndicatorTone } from '../../lib/indicator-tokens';
import { cn } from '../../lib/utils';
import { Spinner } from './Spinner';

export interface ActivitySpinnerProps {
  /** Indicator tone that drives the spinner color. */
  tone?: IndicatorTone;
  /** Spinner size. */
  size?: 'xs' | 'sm' | 'md';
  /** Additional CSS classes. */
  className?: string;
}

/**
 * Render a tone-aware activity spinner.
 */
export function ActivitySpinner({ tone = 'info', size = 'xs', className }: ActivitySpinnerProps) {
  return (
    <Spinner
      size={size}
      color={INDICATOR_TONES[tone].spinner}
      className={cn('flex-shrink-0', className)}
    />
  );
}
