import type { SpaceTaskStatus } from '@hyperneo/shared';
import { getToneClasses, type IndicatorTone, type ToneClassSet } from './indicator-tokens.js';

export interface TaskStatusConfig {
  tone: IndicatorTone;
  label: string;
}

export const TASK_STATUS_CONFIG: Record<SpaceTaskStatus, TaskStatusConfig> = {
  draft: { tone: 'neutral', label: 'Draft' },
  open: { tone: 'neutral', label: 'Open' },
  in_progress: { tone: 'info', label: 'In Progress' },
  review: { tone: 'special', label: 'Awaiting Review' },
  approved: { tone: 'success', label: 'Approved' },
  done: { tone: 'success', label: 'Done' },
  blocked: { tone: 'danger', label: 'Blocked' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  archived: { tone: 'neutral', label: 'Archived' },
  rate_limited: { tone: 'warning', label: 'Rate Limited' },
  usage_limited: { tone: 'warning', label: 'Usage Limited' },
};

export function getTaskStatusConfig(status: SpaceTaskStatus): TaskStatusConfig {
  return TASK_STATUS_CONFIG[status];
}

export function getTaskStatusClasses(status: SpaceTaskStatus): ToneClassSet {
  return getToneClasses(TASK_STATUS_CONFIG[status].tone);
}
