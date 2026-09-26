import type { SidebarSessionStatus } from '../lib/session-sidebar-status.ts';
import { cn } from '../lib/utils.ts';
import { StatusDot } from './ui/StatusDot.tsx';

const ICONS: Record<string, string> = {
  queued: 'M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  waiting_for_input:
    'M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  pending_worktree_choice:
    'M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  rate_limit_cooldown: 'M6 3h12M6 21h12M7 3v4l10 10v4M17 3v4L7 17v4',
  interrupted: 'M12 8v5m0 3h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  blocked: 'M12 8v5m0 3h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  paused: 'M8 5v14M16 5v14',
  ended: 'm5 12 4 4L19 6',
  done: 'm5 12 4 4L19 6',
  archived: 'M4 8h16v12H4ZM3 4h18v4H3ZM9 12h6',
};

const TONES = {
  neutral: 'text-fg-faint',
  info: 'text-accent',
  progress: 'text-warning',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  special: 'text-cat-purple',
};

export function SessionActivityIndicator({ status }: { status: SidebarSessionStatus }) {
  const icon = ICONS[status.kind ?? ''];
  return (
    <span
      class={cn('inline-flex h-4 w-4 shrink-0 items-center justify-center', TONES[status.tone])}
      role="img"
      aria-label={status.label}
      title={status.label}
    >
      {status.pulse ? (
        <span class="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-r-transparent motion-reduce:animate-none" />
      ) : icon ? (
        <svg
          class="h-3.5 w-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path d={icon} stroke-width={1.7} stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      ) : (
        <StatusDot tone={status.tone} size="xs" />
      )}
    </span>
  );
}
