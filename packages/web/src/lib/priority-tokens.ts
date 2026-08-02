/**
 * Priority Tokens
 *
 * Maps a Space task/goal priority to its unified indicator tone so the priority
 * badge in every inspect-panel header derives its color from the #777 palette
 * instead of per-panel ad-hoc classes.
 */

import type { SpaceTaskPriority } from '@hyperneo/shared';
import type { IndicatorTone } from './indicator-tokens.js';

/**
 * Return the unified indicator tone for a priority. `low`/`normal` read as
 * neutral, `high` as warning, and `urgent` as danger — matching how the same
 * tones are used for status across the rest of the UI.
 */
export function getPriorityIndicatorTone(priority: SpaceTaskPriority): IndicatorTone {
  switch (priority) {
    case 'high':
      return 'warning';
    case 'urgent':
      return 'danger';
    default:
      return 'neutral';
  }
}
