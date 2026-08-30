import type { SessionStatus } from '@hyperneo/shared';

export type SessionLifecycleTone = 'neutral' | 'progress' | 'success' | 'warning';

export interface SessionLifecycleStatusClasses {
  bg: string;
  text: string;
  border: string;
  soft: string;
  spinner: string;
}

const SESSION_LIFECYCLE_TONE_CLASSES: Record<SessionLifecycleTone, SessionLifecycleStatusClasses> =
  {
    neutral: {
      bg: 'bg-fg-faint',
      text: 'text-fg-muted',
      border: 'border-fg-faint/30',
      soft: 'border-fg-faint/30 bg-fg-faint/10 text-fg-muted',
      spinner: 'border-fg-faint',
    },
    progress: {
      bg: 'bg-warning',
      text: 'text-warning',
      border: 'border-warning/30',
      soft: 'border-warning/30 bg-warning/10 text-warning',
      spinner: 'border-warning',
    },
    success: {
      bg: 'bg-success',
      text: 'text-success',
      border: 'border-success/30',
      soft: 'border-success/30 bg-success/10 text-success',
      spinner: 'border-success',
    },
    warning: {
      bg: 'bg-warning',
      text: 'text-warning',
      border: 'border-warning/30',
      soft: 'border-warning/30 bg-warning/10 text-warning',
      spinner: 'border-warning',
    },
  };

export interface SessionLifecycleStatusConfig {
  tone: SessionLifecycleTone;
  label: string;
}

export const SESSION_LIFECYCLE_STATUS_CONFIG: Record<SessionStatus, SessionLifecycleStatusConfig> =
  {
    active: { tone: 'success', label: 'Active' },
    pending_worktree_choice: { tone: 'progress', label: 'Pending' },
    paused: { tone: 'warning', label: 'Paused' },
    ended: { tone: 'neutral', label: 'Ended' },
    archived: { tone: 'neutral', label: 'Archived' },
  };

export function getSessionLifecycleStatusConfig(
  status: SessionStatus
): SessionLifecycleStatusConfig {
  return SESSION_LIFECYCLE_STATUS_CONFIG[status];
}

export function getSessionLifecycleStatusClasses(
  status: SessionStatus
): SessionLifecycleStatusClasses {
  return SESSION_LIFECYCLE_TONE_CLASSES[SESSION_LIFECYCLE_STATUS_CONFIG[status].tone];
}
