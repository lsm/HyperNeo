import type { ComponentChildren } from 'preact';
import { cn } from '../../lib/utils';

type StatusBadgeTone =
  | 'neutral'
  | 'info'
  | 'progress'
  | 'success'
  | 'warning'
  | 'danger'
  | 'special';

const toneSoftClasses: Record<StatusBadgeTone, string> = {
  neutral: 'border-fg-faint/30 bg-fg-faint/10 text-fg-muted',
  info: 'border-accent/30 bg-accent/10 text-accent',
  progress: 'border-warning/30 bg-warning/10 text-warning',
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  danger: 'border-danger/30 bg-danger/10 text-danger',
  special: 'border-cat-purple/30 bg-cat-purple/10 text-cat-purple',
};

export interface StatusBadgeProps {
  tone: StatusBadgeTone;
  label?: string;
  className?: string;
  children?: ComponentChildren;
}

export function StatusBadge({ tone, label, className, children }: StatusBadgeProps) {
  return (
    <span
      class={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap',
        toneSoftClasses[tone],
        className
      )}
    >
      {label ?? children}
    </span>
  );
}
