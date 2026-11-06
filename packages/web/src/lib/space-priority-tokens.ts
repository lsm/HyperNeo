import type { SpaceTaskPriority } from '@hyperneo/shared';

export type PriorityIndicatorTone = 'neutral' | 'warning' | 'danger';

export function getPriorityIndicatorTone(priority: SpaceTaskPriority): PriorityIndicatorTone {
  switch (priority) {
    case 'high':
      return 'warning';
    case 'urgent':
      return 'danger';
    default:
      return 'neutral';
  }
}
