/**
 * CompletionDetector
 *
 * Determines whether a workflow run is complete by inspecting the canonical
 * `SpaceTask` — never `NodeExecution`. Per the workflow completion contract:
 *
 *   - Node-execution statuses (`idle`, `cancelled`, etc.) are about per-execution
 *     lifecycle, NOT workflow completion. An idle end-node may still re-activate
 *     via cyclic re-entry; a cancelled execution may be a transient error.
 *   - The single source of truth for "this workflow is finished" is the canonical
 *     `SpaceTask` linked to the workflow run.
 *
 * Two completion signals — both inspected here:
 *
 *  1. `task.status` is terminal (`done` | `cancelled`) — the canonical task
 *     has reached its end state, either via runtime resolution or human override.
 *     Note: `archived` is also a terminal status but we treat it as "out of scope"
 *     here — completion handling is for active workflow lifecycle, not soft-delete.
 *
 *  2. `task.reportedStatus` is non-null — the end-node agent reported its result
 *     by writing the field directly (task is the single source of truth). The
 *     runtime's tick will resolve the final task status on the next pass through
 *     `resolveTaskApproval` (which honors the supervised-mode review gate — i.e.
 *     `completionAutonomyLevel`). Returning true here causes that resolution to fire.
 *
 * TODO: stall detection (gap #13) — once nothing is `pending`/`in_progress` and
 * the task is still `in_progress` with no `reportedStatus`, the workflow is
 * stalled (e.g. dead-loop, all agents idle waiting for input). That detection
 * is out of scope for this change; see `docs/space-autonomy-hitl-gaps-claude-opus-4-6.md`.
 */

import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';

export interface CompletionOptions {
  /** Workflow run to inspect */
  workflowRunId: string;
}

export class CompletionDetector {
  constructor(private readonly taskRepo: SpaceTaskRepository) {}

  /**
   * Returns true when the workflow run is complete or the runtime should
   * resolve completion on the next tick.
   *
   * - `true` when the canonical task's `status` is terminal (`done` | `cancelled`),
   *   OR when `reportedStatus` is non-null (agent has reported a result that the
   *   runtime should now resolve through completion-actions).
   * - `false` when the task is missing, in a non-terminal status, and the agent
   *   has not reported a result yet.
   *
   * Returns `false` when no canonical task is linked to the run — the workflow
   * has not started yet from the user-facing perspective.
   */
  isComplete(options: CompletionOptions): boolean {
    const tasks = this.taskRepo.listByWorkflowRun(options.workflowRunId);
    if (tasks.length === 0) return false;

    // A run can have multiple tasks (rare); any single terminal/reported task
    // signals completion intent.
    for (const task of tasks) {
      if (task.status === 'done' || task.status === 'cancelled') return true;
      if (task.reportedStatus !== null) return true;
    }
    return false;
  }
}
