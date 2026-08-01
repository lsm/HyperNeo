/**
 * Session Lifecycle Status Mapping
 *
 * Maps user-facing session lifecycle states to indicator tones and labels.
 */

import type { SessionStatus } from '@hyperneo/shared';
import { getToneClasses, type IndicatorTone, type ToneClassSet } from './indicator-tokens.js';

/**
 * Configuration for a single session lifecycle status.
 */
export interface SessionLifecycleStatusConfig {
  tone: IndicatorTone;
  label: string;
}

/**
 * Maps session lifecycle statuses to their canonical tone and label.
 */
export const SESSION_LIFECYCLE_STATUS_CONFIG: Record<SessionStatus, SessionLifecycleStatusConfig> =
  {
    active: { tone: 'success', label: 'Active' },
    pending_worktree_choice: { tone: 'progress', label: 'Pending' },
    paused: { tone: 'warning', label: 'Paused' },
    ended: { tone: 'neutral', label: 'Ended' },
    archived: { tone: 'neutral', label: 'Archived' },
  };

/**
 * Return the tone + label config for a session lifecycle status.
 */
export function getSessionLifecycleStatusConfig(
  status: SessionStatus
): SessionLifecycleStatusConfig {
  return SESSION_LIFECYCLE_STATUS_CONFIG[status];
}

/**
 * Return the indicator class set for a session lifecycle status.
 */
export function getSessionLifecycleStatusClasses(status: SessionStatus): ToneClassSet {
  return getToneClasses(SESSION_LIFECYCLE_STATUS_CONFIG[status].tone);
}
