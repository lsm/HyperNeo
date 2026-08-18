import { INDICATOR_TONES, type IndicatorTone } from '../../lib/indicator-tokens';
import { cn } from '../../lib/utils';
import { Spinner } from './Spinner';

export interface ActivitySpinnerProps {
  tone?: IndicatorTone;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}

export function ActivitySpinner({ tone = 'info', size = 'xs', className }: ActivitySpinnerProps) {
  return (
    <Spinner
      size={size}
      color={INDICATOR_TONES[tone].spinner}
      className={cn('flex-shrink-0', className)}
    />
  );
}
