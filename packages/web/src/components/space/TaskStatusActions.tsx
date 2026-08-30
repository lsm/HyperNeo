import type { SpaceTaskStatus } from '@hyperneo/shared';

export const VALID_TASK_TRANSITIONS: Record<SpaceTaskStatus, SpaceTaskStatus[]> = {
  draft: ['open', 'archived'],
  open: ['in_progress', 'blocked', 'review', 'done', 'cancelled', 'archived'],
  in_progress: ['review', 'done', 'blocked', 'cancelled', 'stopped'],
  review: ['done', 'in_progress', 'cancelled', 'archived', 'stopped'],
  approved: ['done', 'in_progress', 'archived', 'cancelled'],
  done: ['in_progress', 'archived'],
  blocked: ['open', 'in_progress', 'review', 'done', 'cancelled', 'archived', 'stopped'],
  cancelled: ['open', 'in_progress', 'done', 'archived'],
  rate_limited: ['in_progress', 'open', 'blocked', 'cancelled', 'archived'],
  usage_limited: ['in_progress', 'open', 'blocked', 'cancelled', 'archived'],
  archived: [],
  stopped: ['in_progress', 'cancelled', 'archived'],
};

export const TRANSITION_LABELS: Record<string, string> = {
  'draft->open': 'Publish',
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
  'review->done': 'Approve',
  'review->in_progress': 'Reopen',
  'review->cancelled': 'Cancel',
  'review->archived': 'Archive',
  'review->stopped': 'Stop',
  'approved->done': 'Mark Done',
  'approved->in_progress': 'Reopen',
  'approved->archived': 'Archive',
  'approved->cancelled': 'Cancel',
  'done->in_progress': 'Reopen',
  'done->archived': 'Archive',
  'blocked->open': 'Reopen',
  'blocked->in_progress': 'Resume',
  'blocked->review': 'Submit for Review',
  'blocked->done': 'Mark Done',
  'blocked->cancelled': 'Cancel',
  'blocked->archived': 'Archive',
  'blocked->stopped': 'Stop',
  'stopped->in_progress': 'Resume',
  'stopped->cancelled': 'Cancel',
  'stopped->archived': 'Archive',
  'cancelled->open': 'Reopen',
  'cancelled->in_progress': 'Resume',
  'cancelled->done': 'Mark Done',
  'cancelled->archived': 'Archive',
  'rate_limited->in_progress': 'Resume',
  'rate_limited->open': 'Reopen',
  'rate_limited->blocked': 'Block',
  'rate_limited->cancelled': 'Cancel',
  'rate_limited->archived': 'Archive',
  'usage_limited->in_progress': 'Resume',
  'usage_limited->open': 'Reopen',
  'usage_limited->blocked': 'Block',
  'usage_limited->cancelled': 'Cancel',
  'usage_limited->archived': 'Archive',
};

const TRANSITION_STYLES: Record<string, string> = {
  in_progress: 'text-accent-soft hover:text-accent-soft',
  review: 'text-cat-purple hover:text-cat-purple',
  approved: 'text-success-soft hover:text-success-soft',
  done: 'text-success-soft hover:text-success-soft',
  blocked: 'text-warning hover:text-warning-soft',
  cancelled: 'text-danger-soft hover:text-danger-soft',
  open: 'text-fg-soft hover:text-fg',
  archived: 'text-fg-muted hover:text-fg-soft',
  stopped: 'text-fg-soft hover:text-fg',
};

export function getTransitionActions(
  currentStatus: SpaceTaskStatus
): Array<{ target: SpaceTaskStatus; label: string }> {
  const targets = VALID_TASK_TRANSITIONS[currentStatus] ?? [];
  return targets.map((target) => ({
    target,
    label: TRANSITION_LABELS[`${currentStatus}->${target}`] ?? target,
  }));
}

interface TaskStatusActionsProps {
  status: SpaceTaskStatus;
  onTransition: (newStatus: SpaceTaskStatus) => void;
  disabled?: boolean;
  pendingCheckpointType?: 'task_completion' | null;
}

export function TaskStatusActions({
  status,
  onTransition,
  disabled,
  pendingCheckpointType,
}: TaskStatusActionsProps) {
  const allActions = getTransitionActions(status);
  const actions =
    status === 'review' || pendingCheckpointType === 'task_completion'
      ? allActions.filter(({ target }) => target !== 'done' && target !== 'cancelled')
      : allActions;

  if (actions.length === 0) {
    return (
      <p class="text-xs text-fg-muted" data-testid="task-status-no-actions">
        No status actions available.
      </p>
    );
  }

  return (
    <div class="flex flex-wrap items-center gap-2" data-testid="task-status-actions">
      {actions.map(({ target, label }) => (
        <button
          key={target}
          type="button"
          onClick={() => onTransition(target)}
          disabled={disabled}
          class={`px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${TRANSITION_STYLES[target] ?? 'text-fg-soft hover:text-fg'}`}
          data-testid={`task-action-${target}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
