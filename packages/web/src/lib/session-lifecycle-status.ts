import type { SessionStatus } from '@hyperneo/shared';
import { getToneClasses, type IndicatorTone, type ToneClassSet } from './indicator-tokens.js';

export interface SessionLifecycleStatusConfig {
  tone: IndicatorTone;
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

export function getSessionLifecycleStatusClasses(status: SessionStatus): ToneClassSet {
  return getToneClasses(SESSION_LIFECYCLE_STATUS_CONFIG[status].tone);
}
