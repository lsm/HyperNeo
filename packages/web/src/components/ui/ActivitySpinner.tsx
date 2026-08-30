import { cn } from '../../lib/utils';
import { Spinner } from './Spinner';

type ActivitySpinnerTone =
  | 'neutral'
  | 'info'
  | 'progress'
  | 'success'
  | 'warning'
  | 'danger'
  | 'special';

const toneSpinnerClasses: Record<ActivitySpinnerTone, string> = {
  neutral: 'border-fg-faint',
  info: 'border-accent',
  progress: 'border-warning',
  success: 'border-success',
  warning: 'border-warning',
  danger: 'border-danger',
  special: 'border-cat-purple',
};

export interface ActivitySpinnerProps {
  tone?: ActivitySpinnerTone;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}

export function ActivitySpinner({ tone = 'info', size = 'xs', className }: ActivitySpinnerProps) {
  return (
    <Spinner
      size={size}
      color={toneSpinnerClasses[tone]}
      className={cn('flex-shrink-0', className)}
    />
  );
}
