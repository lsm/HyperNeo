import { humanTaskTransitionTargets, type SpaceTaskStatus } from '@hyperneo/shared';

const TRANSITION_LABELS: Record<string, string> = {
  'draft->open': 'Publish',
  'draft->done': 'Mark Done',
  'draft->cancelled': 'Cancel',
  'draft->archived': 'Archive',
  'open->in_progress': 'Start',
  'open->blocked': 'Block',
  'open->review': 'Submit for Review',
  'open->done': 'Mark Done',
  'open->cancelled': 'Cancel',
  'open->archived': 'Archive',
  'in_progress->review': 'Submit for Review',
  'in_progress->done': 'Mark Done',
  'in_progress->blocked': 'Block',
  'in_progress->cancelled': 'Cancel',
  'in_progress->stopped': 'Stop',
  'in_progress->open': 'Move back to Open',
  'in_progress->archived': 'Archive',
  'review->done': 'Approve',
  'review->in_progress': 'Reopen',
  'review->cancelled': 'Cancel',
  'review->archived': 'Archive',
  'review->stopped': 'Stop',
  'approved->done': 'Mark Done',
  'approved->in_progress': 'Reopen',
  'approved->archived': 'Archive',
  'approved->cancelled': 'Cancel',
  'done->open': 'Reopen as Open',
  'done->in_progress': 'Reopen',
  'done->cancelled': 'Cancel',
  'done->archived': 'Archive',
  'blocked->open': 'Reopen',
  'blocked->in_progress': 'Resume',
  'blocked->review': 'Submit for Review',
  'blocked->done': 'Mark Done',
  'blocked->cancelled': 'Cancel',
  'blocked->archived': 'Archive',
  'blocked->stopped': 'Stop',
  'stopped->in_progress': 'Resume',
  'stopped->open': 'Reopen',
  'stopped->review': 'Submit for Review',
  'stopped->done': 'Mark Done',
  'stopped->cancelled': 'Cancel',
  'stopped->archived': 'Archive',
  'cancelled->open': 'Reopen',
  'cancelled->in_progress': 'Resume',
  'cancelled->done': 'Mark Done',
  'cancelled->archived': 'Archive',
  'rate_limited->in_progress': 'Resume',
  'rate_limited->open': 'Reopen',
  'rate_limited->blocked': 'Block',
  'rate_limited->done': 'Mark Done',
  'rate_limited->stopped': 'Stop',
  'rate_limited->cancelled': 'Cancel',
  'rate_limited->archived': 'Archive',
  'usage_limited->in_progress': 'Resume',
  'usage_limited->open': 'Reopen',
  'usage_limited->blocked': 'Block',
  'usage_limited->done': 'Mark Done',
  'usage_limited->stopped': 'Stop',
  'usage_limited->cancelled': 'Cancel',
  'usage_limited->archived': 'Archive',
};

export function getTransitionActions(
  currentStatus: SpaceTaskStatus
): Array<{ target: SpaceTaskStatus; label: string }> {
  return humanTaskTransitionTargets(currentStatus).map((target) => ({
    target,
    label: TRANSITION_LABELS[`${currentStatus}->${target}`] ?? target,
  }));
}

export function filterDirectAttemptTargets<T extends { target: SpaceTaskStatus }>(
  actions: T[],
  task: { hasActiveDirectAttempt?: boolean; taskAgentSessionId?: string | null }
): T[] {
  if (!task.hasActiveDirectAttempt) return actions;
  const allowed: SpaceTaskStatus[] = task.taskAgentSessionId
    ? ['review', 'done', 'blocked', 'cancelled', 'stopped', 'archived']
    : ['cancelled'];
  return actions.filter(({ target }) => allowed.includes(target));
}
