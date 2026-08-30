import { cn } from '../../lib/utils';

type StatusDotTone = 'neutral' | 'info' | 'progress' | 'success' | 'warning' | 'danger' | 'special';

const toneBgClasses: Record<StatusDotTone, string> = {
  neutral: 'bg-fg-faint',
  info: 'bg-accent',
  progress: 'bg-warning',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  special: 'bg-cat-purple',
};

export interface StatusDotProps {
  tone: StatusDotTone;
  size?: 'xs' | 'sm' | 'md';
  pulse?: boolean;
  className?: string;
  'aria-label'?: string;
}

const sizeClasses = {
  xs: 'w-1.5 h-1.5',
  sm: 'w-2 h-2',
  md: 'w-2.5 h-2.5',
} as const;

export function StatusDot({
  tone,
  size = 'sm',
  pulse = false,
  className,
  'aria-label': ariaLabel,
}: StatusDotProps) {
  const bgClass = toneBgClasses[tone];
  const wrapperClass = cn(
    'inline-flex flex-shrink-0 items-center justify-center rounded-full',
    sizeClasses[size],
    className
  );
  const dot = <span class={cn('rounded-full w-full h-full', bgClass, pulse && 'animate-pulse')} />;

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
