import type { SessionStatus } from '@hyperneo/shared';

export type SessionLifecycleTone = 'neutral' | 'progress' | 'success' | 'warning';

export interface SessionLifecycleStatusClasses {
  bg: string;
  text: string;
  border: string;
  soft: string;
  spinner: string;
}

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
