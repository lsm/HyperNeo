import type { SidebarSessionStatus } from '../lib/session-sidebar-status.ts';
import { cn } from '../lib/utils.ts';
import { StatusDot } from './ui/StatusDot.tsx';

const ICONS: Record<string, string> = {
  not_started: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  draft: 'm4 16 11-11 4 4L8 20H4Zm9-9 4 4',
  open: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M8 12h8m-4-4v8',
  in_progress: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6',
  review: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  approved: 'm8 12 3 3 5-6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  cancelled: 'm9 9 6 6m0-6-6 6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  stopped: 'M6 6h12v12H6Z',
  rate_limited: 'M6 3h12M6 21h12M7 3v4l10 10v4M17 3v4L7 17v4',
  usage_limited: 'M9 9v6m6-6v6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
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
