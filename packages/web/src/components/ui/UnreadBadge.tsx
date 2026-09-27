import { cn } from '../../lib/utils';

export interface UnreadBadgeProps {
  count: number;
  unread?: boolean;
  className?: string;
}

export function UnreadBadge({ count, unread = false, className }: UnreadBadgeProps) {
  if (count <= 0 && !unread) return null;
  return (
    <span
      role="img"
      aria-label={
        count > 0 ? `${count} unread ${count === 1 ? 'message' : 'messages'}` : 'Has updates'
      }
      title={count > 0 ? 'Unread messages' : 'Has updates'}
      class={cn('inline-flex h-[18px] w-[17px] shrink-0 items-center justify-center', className)}
    >
      <span class="sidebar-unread-mark h-[7px] w-[7px] rounded-full" />
    </span>
  );
}
