import type { ComponentChildren } from 'preact';
import { INDICATOR_TONES, type IndicatorTone } from '../../lib/indicator-tokens';
import { cn } from '../../lib/utils';

export interface StatusBadgeProps {
  tone: IndicatorTone;
  label?: string;
  className?: string;
  children?: ComponentChildren;
}

export function StatusBadge({ tone, label, className, children }: StatusBadgeProps) {
  return (
    <span
      class={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap',
        INDICATOR_TONES[tone].soft,
        className
      )}
    >
      {label ?? children}
    </span>
  );
}
