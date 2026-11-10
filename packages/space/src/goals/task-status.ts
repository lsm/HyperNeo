import type { SpaceTask } from '@hyperneo/shared';
import { isRateOrUsageLimited } from '@hyperneo/shared';

export function isActiveTaskStatus(status: SpaceTask['status']): boolean {
  return (
    status === 'open' ||
    status === 'in_progress' ||
    status === 'review' ||
    status === 'approved' ||
    isRateOrUsageLimited(status)
  );
}

export function isTerminalTaskStatus(status: SpaceTask['status']): boolean {
  return (
    status === 'done' || status === 'blocked' || status === 'cancelled' || status === 'archived'
  );
}
