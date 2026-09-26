import { cn } from '../../lib/utils';

export interface UnreadBadgeProps {
  count: number;
  className?: string;
}

export function UnreadBadge({ count, className }: UnreadBadgeProps) {
  if (count <= 0) return null;
  return (
    <span
      role="img"
      aria-label={`${count} unread ${count === 1 ? 'message' : 'messages'}`}
      title="Unread messages"
      class={cn('inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-accent', className)}
    />
  );
}
