/**
 * WorkflowRunStatusMachine
 *
 * Defines the valid status transitions for the agent-centric workflow run lifecycle.
 *
 * Lifecycle:
 *   pending        → in_progress   (startWorkflowRun promotes immediately after creation)
 *   pending        → cancelled     (error during run initialization before tasks created)
 *   in_progress    → done          (all agents reached terminal status)
 *   in_progress    → blocked       (agent failed or gate blocked requiring human action)
 *   in_progress    → cancelled     (explicit cancellation via API)
 *   blocked        → in_progress   (human resolved the blocking issue)
 *   blocked        → cancelled     (explicit cancellation while blocked)
 *   done           → in_progress   (reopen: follow-up message to a "finished" run)
 *   cancelled      → in_progress   (reopen: resume a previously cancelled run)
 *
 * The only true tombstone for the unit of work is `SpaceTask.archivedAt`;
 * workflow-run status is a *lifecycle* state that can re-enter `in_progress`
 * as long as the parent task has not been archived. See ChannelRouter for the
 * archive check that guards reopen.
 */

import type { WorkflowRunStatus } from '@hyperneo/shared';

/**
 * Map from a source status to the set of allowed target statuses.
 *
 * `done` and `cancelled` are NOT terminal — they can re-enter `in_progress` when
 * the parent task is still live (not archived). The archive check lives in
 * ChannelRouter; this table just permits the transition.
 */
export const VALID_TRANSITIONS: Readonly<
  Record<WorkflowRunStatus, ReadonlySet<WorkflowRunStatus>>
> = {
  pending: new Set<WorkflowRunStatus>(['in_progress', 'cancelled']),
  in_progress: new Set<WorkflowRunStatus>(['done', 'blocked', 'cancelled']),
  blocked: new Set<WorkflowRunStatus>(['in_progress', 'cancelled']),
  done: new Set<WorkflowRunStatus>(['in_progress']),
  cancelled: new Set<WorkflowRunStatus>(['in_progress']),
};

/**
 * Returns true when transitioning from `from` to `to` is a valid lifecycle step.
 */
export function canTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): boolean {
  return VALID_TRANSITIONS[from].has(to);
}

/**
 * Throws a descriptive error when the transition is invalid.
 * No-ops when the transition is valid — callers can proceed unconditionally.
 *
 * @param from  Current status of the run.
 * @param to    Desired next status.
 * @param runId Optional run ID for a more actionable error message.
 * @throws {Error} when the transition is not permitted.
 */
export function assertValidTransition(
  from: WorkflowRunStatus,
  to: WorkflowRunStatus,
  runId?: string
): void {
  if (!canTransition(from, to)) {
    const ctx = runId ? ` (run ${runId})` : '';
    throw new Error(
      `Invalid workflow run status transition${ctx}: '${from}' → '${to}'. ` +
        `Allowed from '${from}': [${[...VALID_TRANSITIONS[from]].join(', ') || 'none'}]`
    );
  }
}
