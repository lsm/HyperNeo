import { cn } from '../../lib/utils';

export interface SpinnerProps {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  color?: string;
  className?: string;
}

const sizeClasses = {
  xs: 'w-3 h-3 border',
  sm: 'w-4 h-4 border-2',
  md: 'w-5 h-5 border-2',
  lg: 'w-6 h-6 border-2',
} as const;

export function Spinner({ size = 'sm', color = 'border-fg-faint', className }: SpinnerProps) {
  return (
    <div
      class={cn(
        'rounded-full animate-spin border-t-transparent',
        sizeClasses[size],
        color,
        className
      )}
      role="status"
      aria-label="Loading"
    />
  );
}
