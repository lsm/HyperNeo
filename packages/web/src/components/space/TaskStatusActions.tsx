import type { SpaceTaskStatus } from '@hyperneo/shared';

/**
 * Valid status transitions mirroring the daemon's VALID_SPACE_TASK_TRANSITIONS.
 * Kept in sync manually — the shared package doesn't export this constant.
 */
export const VALID_TASK_TRANSITIONS: Record<SpaceTaskStatus, SpaceTaskStatus[]> = {
  draft: ['open', 'archived'],
  open: ['in_progress', 'blocked', 'review', 'done', 'cancelled', 'archived'],
  in_progress: ['open', 'review', 'done', 'blocked', 'cancelled'],
  review: ['done', 'in_progress', 'cancelled', 'archived'],
  // `approved` is the post-approval staging status. Conservative transition
  // set (`done` / `in_progress` / `archived` / `cancelled`) gives manual
  // escape hatches if the PostApprovalRouter is unable to advance a task
  // automatically. (`approved → blocked` stays intentionally absent.)
  approved: ['done', 'in_progress', 'archived', 'cancelled'],
  done: ['in_progress', 'archived'],
  blocked: ['open', 'in_progress', 'review', 'done', 'cancelled', 'archived'],
  cancelled: ['open', 'in_progress', 'done', 'archived'],
  // Runtime-set paused states (rate/usage cap). Manual escape hatches only:
  // resume, reopen, block, cancel, or archive. Not user-transitionable TO.
  rate_limited: ['in_progress', 'open', 'blocked', 'cancelled', 'archived'],
  usage_limited: ['in_progress', 'open', 'blocked', 'cancelled', 'archived'],
  archived: [],
};

/**
 * Human-readable labels for each transition, keyed by `from -> to`.
 */
export const TRANSITION_LABELS: Record<string, string> = {
  'draft->open': 'Publish',
  'draft->archived': 'Archive',
  'open->in_progress': 'Start',
  'open->blocked': 'Block',
  'open->review': 'Submit for Review',
  'open->done': 'Mark Done',
  'open->cancelled': 'Cancel',
  'open->archived': 'Archive',
  'in_progress->open': 'Pause',
  'in_progress->review': 'Submit for Review',
  'in_progress->done': 'Mark Done',
  'in_progress->blocked': 'Block',
  'in_progress->cancelled': 'Cancel',
  'review->done': 'Approve',
  'review->in_progress': 'Reopen',
  'review->cancelled': 'Cancel',
  'review->archived': 'Archive',
  // `approved` exit edges. The PostApprovalRouter normally advances tasks
  // past this status; these labels render only when a manual transition is
  // needed (e.g. router failure, or admin intervention).
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
  'cancelled->open': 'Reopen',
  'cancelled->in_progress': 'Resume',
  'cancelled->done': 'Mark Done',
  'cancelled->archived': 'Archive',
  // Runtime-set paused states (rate/usage cap). Manual escape hatches: resume,
  // reopen, or cancel. The runtime auto-resumes on cooldown fire; these render
  // only for manual intervention.
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

/**
 * Tailwind color classes per transition target for visual distinction.
 */
const TRANSITION_STYLES: Record<string, string> = {
  in_progress: 'text-blue-300 hover:text-blue-200',
  review: 'text-purple-300 hover:text-purple-200',
  approved: 'text-emerald-300 hover:text-emerald-200',
  done: 'text-green-300 hover:text-green-200',
  blocked: 'text-amber-300 hover:text-amber-200',
  cancelled: 'text-red-300 hover:text-red-200',
  open: 'text-gray-300 hover:text-gray-100',
  archived: 'text-gray-400 hover:text-gray-300',
};

/**
 * Returns the list of valid transition actions from a given status.
 */
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
  /**
   * Type of checkpoint the task is paused at, if any. When set to
   * `task_completion`, the generic Approve/Reject transitions are hidden and
   * routed through `PendingTaskCompletionBanner` instead — that banner shows
   * what the approval actually does, which the generic buttons can't.
   */
  pendingCheckpointType?: 'gate' | 'task_completion' | null;
}

export function TaskStatusActions({
  status,
  onTransition,
  disabled,
  pendingCheckpointType,
}: TaskStatusActionsProps) {
  const allActions = getTransitionActions(status);
  // `review` is always "awaiting human approval via a dedicated banner":
  //
  //   - `task_completion` checkpoint → `PendingTaskCompletionBanner` owns
  //     Approve / Send back, routed through `approvePendingCompletion` so the
  //     PostApprovalRouter runs and approval metadata is stamped.
  //   - `gate` checkpoint            → `PendingGateBanner` owns Approve /
  //     Reject; bypassing it via the generic button would mark the task done
  //     without opening the gate.
  //
  // After unification, every fresh `review` task carries
  // `pendingCheckpointType === 'task_completion'` (set by the unified
  // `submitTaskForReview` helper) — so the banner is always present and the
  // generic Approve / Cancel buttons would never be the right answer. We hide
  // them whenever the task is in `review`, regardless of `pendingCheckpointType`,
  // so legacy data (older tasks that landed in `review` before unification with
  // a null checkpoint type) still routes through the banner once they're
  // approved through other means. Non-approval transitions (Reopen → in_progress,
  // Archive) stay visible as escape hatches.
  const actions =
    status === 'review' ||
    pendingCheckpointType === 'task_completion' ||
    pendingCheckpointType === 'gate'
      ? allActions.filter(({ target }) => target !== 'done' && target !== 'cancelled')
      : allActions;

  if (actions.length === 0) {
    return (
      <p class="text-xs text-gray-400" data-testid="task-status-no-actions">
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
          class={`px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${TRANSITION_STYLES[target] ?? 'text-gray-300 hover:text-gray-100'}`}
          data-testid={`task-action-${target}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
