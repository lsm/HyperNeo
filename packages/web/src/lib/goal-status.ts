import type { SpaceGoalStatus } from '@hyperneo/shared';

export type GoalStatusTone = 'neutral' | 'info' | 'success' | 'warning';

export interface GoalStatusClasses {
  bg: string;
  text: string;
  border: string;
  soft: string;
  spinner: string;
}

const GOAL_STATUS_TONE_CLASSES: Record<GoalStatusTone, GoalStatusClasses> = {
  neutral: {
    bg: 'bg-fg-faint',
    text: 'text-fg-muted',
    border: 'border-fg-faint/30',
    soft: 'border-fg-faint/30 bg-fg-faint/10 text-fg-muted',
    spinner: 'border-fg-faint',
  },
  info: {
    bg: 'bg-accent',
    text: 'text-accent',
    border: 'border-accent/30',
    soft: 'border-accent/30 bg-accent/10 text-accent',
    spinner: 'border-accent',
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

export interface GoalStatusConfig {
  tone: GoalStatusTone;
  label: string;
}

export const GOAL_STATUS_CONFIG: Record<SpaceGoalStatus, GoalStatusConfig> = {
  active: { tone: 'success', label: 'Active' },
  paused: { tone: 'warning', label: 'Paused' },
  completed: { tone: 'info', label: 'Completed' },
  archived: { tone: 'neutral', label: 'Archived' },
};

export function getGoalStatusConfig(status: SpaceGoalStatus): GoalStatusConfig {
  return GOAL_STATUS_CONFIG[status];
}

export function getGoalStatusClasses(status: SpaceGoalStatus): GoalStatusClasses {
  return GOAL_STATUS_TONE_CLASSES[GOAL_STATUS_CONFIG[status].tone];
}
