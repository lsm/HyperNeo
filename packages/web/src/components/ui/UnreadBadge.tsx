/**
 * UnreadBadge Component
 *
 * Numeric unread indicator. Returns null when there is nothing to show and
 * caps the display at `max`.
 */

import { INDICATOR_TONES } from '../../lib/indicator-tokens';
import { cn } from '../../lib/utils';

export interface UnreadBadgeProps {
  /** Number of unread items. */
  count: number;
  /** Maximum value to display before showing `{max}+`. */
  max?: number;
  /** Additional CSS classes. */
  className?: string;
}

/**
 * Render a numeric unread badge.
 */
export function UnreadBadge({ count, max = 99, className }: UnreadBadgeProps) {
  if (count <= 0) {
    return null;
  }

  const display = count > max ? `${max}+` : String(count);

  return (
    <span
      class={cn(
        'inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full text-[10px] font-semibold tabular-nums',
        INDICATOR_TONES.info.bg,
        'text-white',
        className
      )}
    >
      {display}
    </span>
  );
}
