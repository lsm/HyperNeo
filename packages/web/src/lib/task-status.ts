/**
 * Task Status Mapping
 *
 * Single source of truth for mapping SpaceTaskStatus values to an indicator
 * tone and human-readable label.
 */

import type { SpaceTaskStatus } from '@hyperneo/shared';
import { getToneClasses, type IndicatorTone, type ToneClassSet } from './indicator-tokens.js';

/**
 * Configuration for a single task status.
 */
export interface TaskStatusConfig {
  tone: IndicatorTone;
  label: string;
}

/**
 * Maps every SpaceTaskStatus to its canonical tone and label.
 */
export const TASK_STATUS_CONFIG: Record<SpaceTaskStatus, TaskStatusConfig> = {
  draft: { tone: 'neutral', label: 'Draft' },
  open: { tone: 'neutral', label: 'Open' },
  in_progress: { tone: 'info', label: 'In Progress' },
  review: { tone: 'special', label: 'Awaiting Review' },
  approved: { tone: 'success', label: 'Approved' },
  done: { tone: 'success', label: 'Done' },
  // `blocked` reads as danger (red): a blocked task needs attention to unblock,
  // which is closer to an error state than the softer warning (amber) tone used
  // for paused/waiting. Keeps list, sidebar, and detail panels consistent.
  blocked: { tone: 'danger', label: 'Blocked' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  archived: { tone: 'neutral', label: 'Archived' },
};

/**
 * Return the tone + label config for a task status.
 */
export function getTaskStatusConfig(status: SpaceTaskStatus): TaskStatusConfig {
  return TASK_STATUS_CONFIG[status];
}

/**
 * Return the indicator class set for a task status.
 */
export function getTaskStatusClasses(status: SpaceTaskStatus): ToneClassSet {
  return getToneClasses(TASK_STATUS_CONFIG[status].tone);
}
