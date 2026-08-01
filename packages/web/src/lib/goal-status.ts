/**
 * Goal Status Mapping
 *
 * Single source of truth for mapping SpaceGoalStatus values to an indicator
 * tone and human-readable label.
 */

import type { SpaceGoalStatus } from '@hyperneo/shared';
import { getToneClasses, type IndicatorTone, type ToneClassSet } from './indicator-tokens.js';

/**
 * Configuration for a single goal status.
 */
export interface GoalStatusConfig {
  tone: IndicatorTone;
  label: string;
}

/**
 * Maps every SpaceGoalStatus to its canonical tone and label.
 */
export const GOAL_STATUS_CONFIG: Record<SpaceGoalStatus, GoalStatusConfig> = {
  active: { tone: 'success', label: 'Active' },
  paused: { tone: 'warning', label: 'Paused' },
  completed: { tone: 'success', label: 'Completed' },
  archived: { tone: 'neutral', label: 'Archived' },
};

/**
 * Return the tone + label config for a goal status.
 */
export function getGoalStatusConfig(status: SpaceGoalStatus): GoalStatusConfig {
  return GOAL_STATUS_CONFIG[status];
}

/**
 * Return the indicator class set for a goal status.
 */
export function getGoalStatusClasses(status: SpaceGoalStatus): ToneClassSet {
  return getToneClasses(GOAL_STATUS_CONFIG[status].tone);
}
