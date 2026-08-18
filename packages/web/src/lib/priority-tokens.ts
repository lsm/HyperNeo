import type { SpaceTaskPriority } from '@hyperneo/shared';
import type { IndicatorTone } from './indicator-tokens.js';

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
