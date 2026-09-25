import type { SpaceTaskStatus } from '@hyperneo/shared';

export type TaskStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'special';

export interface TaskStatusClasses {
  bg: string;
  text: string;
  border: string;
  soft: string;
  spinner: string;
  wash: string;
  rail: string;
}

const TASK_STATUS_TONE_CLASSES: Record<TaskStatusTone, TaskStatusClasses> = {
  neutral: {
    bg: 'bg-fg-faint',
    text: 'text-fg-muted',
    border: 'border-fg-faint/30',
    soft: 'border-fg-faint/30 bg-fg-faint/10 text-fg-muted',
    spinner: 'border-fg-faint',
    wash: '',
    rail: 'bg-fg-faint/50',
  },
  info: {
    bg: 'bg-accent',
    text: 'text-accent',
    border: 'border-accent/30',
    soft: 'border-accent/30 bg-accent/10 text-accent',
    spinner: 'border-accent',
    wash: 'bg-accent/5',
    rail: 'bg-accent',
  },
  success: {
    bg: 'bg-success',
    text: 'text-success',
    border: 'border-success/30',
    soft: 'border-success/30 bg-success/10 text-success',
    spinner: 'border-success',
    wash: 'bg-success/5',
    rail: 'bg-success',
  },
  warning: {
    bg: 'bg-warning',
    text: 'text-warning',
    border: 'border-warning/30',
    soft: 'border-warning/30 bg-warning/10 text-warning',
    spinner: 'border-warning',
    wash: 'bg-warning/5',
    rail: 'bg-warning',
  },
  danger: {
    bg: 'bg-danger',
    text: 'text-danger',
    border: 'border-danger/30',
    soft: 'border-danger/30 bg-danger/10 text-danger',
    spinner: 'border-danger',
    wash: 'bg-danger/5',
    rail: 'bg-danger',
  },
  special: {
    bg: 'bg-cat-purple',
    text: 'text-cat-purple',
    border: 'border-cat-purple/30',
    soft: 'border-cat-purple/30 bg-cat-purple/10 text-cat-purple',
    spinner: 'border-cat-purple',
    wash: 'bg-cat-purple/5',
    rail: 'bg-cat-purple',
  },
};

export interface TaskStatusConfig {
  tone: TaskStatusTone;
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
  stopped: { tone: 'neutral', label: 'Stopped' },
};

export function getTaskStatusConfig(status: SpaceTaskStatus): TaskStatusConfig {
  return TASK_STATUS_CONFIG[status];
}

export function getTaskStatusClasses(status: SpaceTaskStatus): TaskStatusClasses {
  return TASK_STATUS_TONE_CLASSES[TASK_STATUS_CONFIG[status].tone];
}
