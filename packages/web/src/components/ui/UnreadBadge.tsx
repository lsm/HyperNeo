import { cn } from '../../lib/utils';

export interface UnreadBadgeProps {
  count: number;
  max?: number;
  className?: string;
}

export function UnreadBadge({ count, max = 99, className }: UnreadBadgeProps) {
  if (count <= 0) {
    return null;
  }

  const display = count > max ? `${max}+` : String(count);

  return (
    <span
      class={cn(
        'inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full text-[10px] font-semibold tabular-nums',
        'bg-blue-600 text-white',
        className
      )}
    >
      {display}
      <span class="sr-only"> unread</span>
    </span>
  );
}
