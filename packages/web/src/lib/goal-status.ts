import type { SpaceGoalStatus } from '@hyperneo/shared';
import { getToneClasses, type IndicatorTone, type ToneClassSet } from './indicator-tokens.js';

export interface GoalStatusConfig {
  tone: IndicatorTone;
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

export function getGoalStatusClasses(status: SpaceGoalStatus): ToneClassSet {
  return getToneClasses(GOAL_STATUS_CONFIG[status].tone);
}
