/**
 * SpaceTaskManager - Space task management with status transitions
 *
 * Handles:
 * - Creating space tasks with dependency validation
 * - Status transitions (open -> in_progress -> done/blocked/cancelled -> archived)
 * - Task assignment and progress tracking
 */

import type { Database as BunDatabase } from '../../../storage/sqlite-compat';
import type {
  InternalCreateSpaceTaskParams,
  SpaceApprovalSource,
  SpaceBlockReason,
  SpaceTask,
  SpaceTaskStatus,
  UpdateSpaceTaskParams,
} from '@hyperneo/shared';
import { isRateOrUsageLimited } from '@hyperneo/shared';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository';
import { Logger } from '../../logger';
import type { EvolutionScopeService } from '../evolution-scope-service';
import { arraysEqual } from '../../utils/array-utils';

const log = new Logger('space-task-manager');

/**
 * Valid task status transitions for space tasks
 * Maps current status -> allowed next statuses
 */
export const VALID_SPACE_TASK_TRANSITIONS: Record<SpaceTaskStatus, SpaceTaskStatus[]> = {
  draft: ['open', 'archived'], // Only publish or archive
  // `review` is allowed from `open` so that a review node can call
  // `submit_for_approval` even when the task has not yet transitioned to
  // `in_progress` (e.g. review-only workflow or runtime scheduling edge).
  // `archived` lets the user shelve a queued task without first cancelling or
  // waiting for the runtime to flip it to `in_progress` — every other non-
  // terminal status already allows `→ archived`, so this closes the asymmetry.
  open: ['in_progress', 'blocked', 'review', 'done', 'cancelled', 'archived'],
  // `in_progress → approved` is the end-node `approve_task` path (PR 2/5 of
  // the task-agent-as-post-approval-executor refactor). It replaces the
  // `in_progress → done` shortcut that the completion-action pipeline used
  // to take.
  in_progress: ['open', 'review', 'approved', 'done', 'blocked', 'cancelled'],
  // `review → approved` is the human-approves-the-work path — the
  // `approvePendingCompletion` RPC handler takes a task out of `review`
  // into `approved` so the post-approval router can dispatch.
  review: ['done', 'approved', 'in_progress', 'cancelled', 'archived'],
  // `approved → done` is driven by `mark_complete` (post-approval agent)
  // or the runtime fallback on session termination. `approved → cancelled`
  // lets the user drop an approved-but-now-unwanted task directly instead of
  // the two-step Reopen → Cancel (the existing "exit approved" cleanup below
  // nulls the post-approval fields). `approved → blocked` is intentionally
  // absent: a failing post-approval session leaves the task in `approved`
  // with `postApprovalBlockedReason` set and surfaces via
  // `PendingPostApprovalBanner`.
  approved: ['done', 'in_progress', 'archived', 'cancelled'],
  done: ['in_progress', 'archived'], // Reactivate or archive
  // `review` is allowed from `blocked` so that a review node can call
  // `submit_for_approval` after the task was parked in `blocked` (e.g.
  // waiting for a dependency or a prior human-input gate). `done` mirrors the
  // `cancelled → done` recovery affordance: a blocked task whose work is
  // provably complete (e.g. dependency unblocked after the work finished) can
  // be marked done directly instead of Reopen → in_progress → done.
  blocked: ['open', 'in_progress', 'review', 'done', 'cancelled', 'archived'], // Restart/cancel/complete + archive
  cancelled: ['open', 'in_progress', 'done', 'archived'], // Restart, complete, or archive
  // Runtime-set paused states (rate/usage cap). Auto-resume → in_progress; a
  // user can cancel or archive. Not user-transitionable TO (only the runtime
  // sets them).
  rate_limited: ['in_progress', 'open', 'blocked', 'cancelled', 'archived'],
  usage_limited: ['in_progress', 'open', 'blocked', 'cancelled', 'archived'],
  archived: [], // True terminal state — no going back
};

/**
 * Check if a space task status transition is valid
 */
export function isValidSpaceTaskTransition(from: SpaceTaskStatus, to: SpaceTaskStatus): boolean {
  return VALID_SPACE_TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

export class SpaceTaskManager {
  private taskRepo: SpaceTaskRepository;

  constructor(
    private db: BunDatabase,
    private spaceId: string,
    private reactiveDb?: ReactiveDatabase,
    private evolutionScopeService?: EvolutionScopeService
  ) {
    this.taskRepo = new SpaceTaskRepository(db, reactiveDb);
  }

  /**
   * Create a task in this space
   */
  async createTask(params: Omit<InternalCreateSpaceTaskParams, 'spaceId'>): Promise<SpaceTask> {
    // Validate dependency task IDs exist in this space
    if (params.dependsOn && params.dependsOn.length > 0) {
      await this.validateDependencyIds(params.dependsOn);
    }

    return this.taskRepo.createTask({ ...params, spaceId: this.spaceId });
  }

  /**
   * Get a task by ID (validates it belongs to this space)
   */
  async getTask(taskId: string): Promise<SpaceTask | null> {
    const task = this.taskRepo.getTask(taskId);
    if (task && task.spaceId === this.spaceId) {
      return task;
    }
    return null;
  }

  /**
   * Get a task by its space-scoped numeric ID (e.g. task #5)
   */
  async getTaskByNumber(taskNumber: number): Promise<SpaceTask | null> {
    return this.taskRepo.getTaskByNumber(this.spaceId, taskNumber);
  }

  /**
   * List tasks in this space
   */
  async listTasks(includeArchived = false): Promise<SpaceTask[]> {
    return this.taskRepo.listBySpace(this.spaceId, includeArchived);
  }

  /**
   * List tasks by status
   */
  async listTasksByStatus(status: SpaceTaskStatus): Promise<SpaceTask[]> {
    return this.taskRepo.listByStatus(this.spaceId, status);
  }

  /**
   * List tasks by status, paginated, with the total count for the matching set.
   *
   * Used by the UI Tasks view to render a single TaskGroup card with Prev/Next
   * pagination. `blockReason` is an optional secondary filter so the Action
   * tab can split blocked tasks into "Needs Input" / "Gate Pending" / generic
   * "Blocked" groups without round-tripping the whole status set.
   *
   * Pass `blockReason: null` to filter for blocked rows with no reason set;
   * omit the param to ignore the column entirely. `blockReasonNotIn` is the
   * inverse — used by the generic "Blocked" bucket to include every blocked
   * row whose reason is NOT one of the attention-required values. The two
   * filters are mutually exclusive.
   */
  async listTasksByStatusPaginated(
    status: SpaceTaskStatus,
    blockReason: SpaceBlockReason | null | undefined,
    limit: number,
    offset = 0,
    blockReasonNotIn?: SpaceBlockReason[]
  ): Promise<{ tasks: SpaceTask[]; total: number }> {
    return this.taskRepo.listBySpaceAndStatus(
      this.spaceId,
      status,
      blockReason,
      limit,
      offset,
      blockReasonNotIn
    );
  }

  /**
   * List tasks belonging to a specific workflow run
   */
  async listTasksByWorkflowRun(workflowRunId: string): Promise<SpaceTask[]> {
    return this.taskRepo.listByWorkflowRun(workflowRunId);
  }

  /**
   * Update task status with validation
   */
  async setTaskStatus(
    taskId: string,
    newStatus: SpaceTaskStatus,
    options?: {
      result?: string | null;
      reportedSummary?: string | null;
      blockReason?: SpaceBlockReason;
      approvalSource?: SpaceApprovalSource;
      // `null` explicitly clears a prior value; `undefined` leaves any
      // existing approvalReason untouched on transitions that carry the
      // stamp forward (see the approved → done mirror below).
      approvalReason?: string | null;
      /** Optional callback invoked with tasks cascaded by this transition. */
      onCascadedTasks?: (cascaded: SpaceTask[]) => Promise<void>;
    }
  ): Promise<SpaceTask> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (!isValidSpaceTaskTransition(task.status, newStatus)) {
      throw new Error(
        `Invalid status transition from '${task.status}' to '${newStatus}'. ` +
          `Allowed: ${VALID_SPACE_TASK_TRANSITIONS[task.status].join(', ') || 'none'}`
      );
    }

    const updates: Parameters<SpaceTaskRepository['updateTask']>[1] = { status: newStatus };

    if (newStatus === 'done' || newStatus === 'blocked') {
      if (options?.result !== undefined) {
        updates.result = options.result;
      } else if (!task.result && options?.reportedSummary !== null) {
        // Backfill result from reportedSummary so terminal tasks never reach
        // `done`/`blocked` with a null result when a summary exists.
        const summary = options?.reportedSummary ?? task.reportedSummary;
        if (summary) updates.result = summary;
      } else if (task.status === 'blocked' && newStatus === 'done') {
        // Clear a stale failure `result` when marking a blocked task done (the
        // new G2 edge) without a fresh completion result — the failure text no
        // longer represents the task state, and captureCompletedTaskEvidence
        // would otherwise record the error as the successful outcome. Respect
        // an explicit `reportedSummary: null` (no summary) — only fall back to
        // the stored summary when the option is undefined. (task #849, G2)
        const summary =
          options?.reportedSummary !== undefined ? options.reportedSummary : task.reportedSummary;
        updates.result = summary ?? null;
      }
      if (options?.reportedSummary !== undefined) {
        updates.reportedSummary = options.reportedSummary;
      }
    }

    // Stamp blockReason when entering blocked; clear it when leaving. The
    // reactivation block below also clears it (plus result/approval metadata)
    // for blocked → open/in_progress; this explicit clear covers the remaining
    // exits (done/cancelled/archived/review) so a non-blocked task never
    // carries a stale failure classification like `dependency_failed`.
    // (G2, task #849)
    if (newStatus === 'blocked') {
      updates.blockReason = options?.blockReason ?? null;
    } else if (task.status === 'blocked') {
      updates.blockReason = null;
    }

    // Stamp approval metadata when transitioning from review → done
    if (task.status === 'review' && newStatus === 'done') {
      updates.approvalSource = options?.approvalSource ?? null;
      updates.approvalReason = options?.approvalReason ?? null;
      updates.approvedAt = Date.now();
    } else if (
      task.status === 'in_progress' &&
      newStatus === 'done' &&
      options?.approvalSource !== undefined
    ) {
      // Validation-only completion (`complete_validation_task`) stamps its
      // agent-approval metadata atomically with the in_progress → done commit.
      // Gated on an EXPLICIT approvalSource so every other caller of this
      // transition (which passes no approval options) is unaffected — their
      // approval fields stay untouched rather than being nulled or stamped.
      updates.approvalSource = options.approvalSource;
      updates.approvalReason = options.approvalReason ?? null;
      updates.approvedAt = Date.now();
    }

    // Stamp approval metadata when transitioning into the `approved` status
    // (in_progress → approved, review → approved). Post-approval routing uses
    // this as the canonical mid-lifecycle stamp before the Task Agent / spawned
    // sub-session transitions the task forward to `done` via `mark_complete`.
    if (newStatus === 'approved') {
      updates.approvalSource = options?.approvalSource ?? null;
      updates.approvalReason = options?.approvalReason ?? null;
      updates.approvedAt = Date.now();
    }

    // Mirror the approval stamp on approved → done (via `mark_complete`),
    // carrying through the original approvalSource so the audit trail is
    // preserved once the task reaches its terminal state.
    if (task.status === 'approved' && newStatus === 'done') {
      if (options?.approvalSource !== undefined) {
        updates.approvalSource = options.approvalSource;
      }
      if (options?.approvalReason !== undefined) {
        updates.approvalReason = options.approvalReason;
      }
    }

    // Clear result when restarting or deprioritizing.
    // Covers blocked, cancelled, done → reactivation, in_progress → open (pause),
    // and review → in_progress (human rejection).
    if (
      (task.status === 'blocked' && (newStatus === 'open' || newStatus === 'in_progress')) ||
      (task.status === 'cancelled' && (newStatus === 'open' || newStatus === 'in_progress')) ||
      (task.status === 'done' && newStatus === 'in_progress') ||
      (task.status === 'in_progress' && newStatus === 'open') ||
      (task.status === 'review' && newStatus === 'in_progress')
    ) {
      updates.result = null;
      updates.reportedSummary = null;
      // Clear block reason and approval metadata on reactivation
      updates.blockReason = null;
      updates.approvalSource = null;
      updates.approvalReason = null;
      updates.approvedAt = null;
      // Clear the durable post-approval source too — it belongs to a prior
      // approval attempt and must not survive reactivation. Mirrors
      // `recoverWorkflowBackedTask` (space-runtime.ts) and realises the
      // backfill-restriction intent that this field is only meaningful during
      // an in-flight approval attempt (task #851).
      updates.postApprovalSourceNodeId = null;
    }

    // Clear pending-completion fields when leaving `review` for any non-review
    // status, AND when entering `approved` from any source (review → approved,
    // in_progress → approved).
    //
    // Previously the `review → approved` transition deliberately kept
    // `pendingCompletionSubmittedByNodeId` set so PostApprovalRouter could read
    // the submitting workflow node during the `approved` state — the router/finally
    // cleared it later. That was a non-atomic multi-step state change: a crash
    // between the `approved` commit and the cleanup stranded the task in
    // `approved` with stale pending fields (the parked shape from #816/#848).
    // The router now resolves its source from the dedicated durable
    // `postApprovalSourceNodeId` field (NOT one of these), so the pending fields
    // no longer need to survive into `approved` and are cleared in the same
    // UPDATE that commits the status. A task can never be observed in `approved`
    // with any pending-completion field set (task #851).
    if ((task.status === 'review' && newStatus !== 'review') || newStatus === 'approved') {
      updates.pendingCheckpointType = null;
      updates.pendingCompletionSubmittedByNodeId = null;
      updates.pendingCompletionSubmittedAt = null;
      updates.pendingCompletionReason = null;
    }

    // Clear the durable source node when a review attempt is ABORTED — i.e. any
    // exit from `review` that does not reach `approved` (human reject →
    // in_progress, cancel, direct-done, archive). `postApprovalSourceNodeId` is
    // stamped for the CURRENT approval attempt, so aborting that attempt must
    // not leave a stale submitter that a later dispatch could read. It
    // deliberately survives `review → approved` (the router reads it while the
    // task is `approved`) and is cleared on leaving `approved`. (task #851.)
    if (task.status === 'review' && newStatus !== 'review' && newStatus !== 'approved') {
      updates.postApprovalSourceNodeId = null;
    }

    // Clear post-approval tracking fields on any transition out of `approved`.
    //
    // Mirrors (and replaces) the follow-up `updateTask` formerly issued by
    // the agent `mark_complete` tool. After this change, the `approved →
    // done` transition writes status='done' and nulls the post-approval
    // fields in a single repository UPDATE — closing the race window where
    // a reader could observe `status='done'` with stale
    // `postApprovalSessionId`/`postApprovalStartedAt`/`postApprovalBlockedReason`.
    // Also covers UI-driven escape hatches (`approved → in_progress`,
    // `approved → archived`) which previously left these fields lingering.
    if (task.status === 'approved' && newStatus !== 'approved') {
      updates.postApprovalSessionId = null;
      updates.postApprovalStartedAt = null;
      updates.postApprovalBlockedReason = null;
      updates.postApprovalSourceNodeId = null;
    }

    const updated = this.taskRepo.updateTask(taskId, updates);
    if (!updated) {
      throw new Error(`Failed to update task: ${taskId}`);
    }

    // Gap 2 fix: when a task reaches `done`, auto-unblock any dependents
    // whose dependency constraints are now fully met. This runs in
    // `setTaskStatus` (not just `updateTaskAndEmit`) so that all done
    // paths — direct tool/handler calls included — trigger the cascade.
    // Wrapped in try-catch so a failed unblock (e.g. concurrent status
    // change making blocked→open invalid) does not abort the parent
    // `done` transition — the parent write is already committed.
    if (newStatus === 'done') {
      try {
        this.evolutionScopeService?.captureCompletedTaskEvidence({ taskId });
      } catch (err) {
        log.warn(
          `Forge evidence capture threw for task "${taskId}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
      try {
        const unblocked = await this.unblockDependentTasks(taskId);
        if (unblocked.length > 0 && options?.onCascadedTasks) {
          await options.onCascadedTasks(unblocked);
        }
      } catch {
        // Best-effort: unblock failures must not roll back the
        // already-committed done transition. The tick loop will
        // re-evaluate blocked dependents on the next cycle.
      }
    }

    // Archive is the true task tombstone — ChannelRouter hard-blocks sends to
    // an archived task, so its workflow run can never reopen. Drop the run's
    // dead-loop event history now. This is the deliberate counterpart to
    // keeping done/cancelled history: those are reopenable (a peer send flips
    // the run back to `in_progress`), so they must retain their rolling-window
    // state; archive is the one status where retention is pure table growth
    // with no rate-gate value. This is the chokepoint for tool- and RPC-driven
    // archives; the duplicate-reconcile archive path runs through
    // SpaceRuntime.updateTaskAndEmit with `archiveSource: 'system_reconcile'`
    // and detaches the run before it reaches here (correctly — the canonical
    // task's run stays active, so it must not be cleared).
    //
    // Clear only when EVERY task for the run is archived, mirroring
    // ChannelRouter.isParentTaskArchived (a run is dead only when all its
    // tasks are tombstoned). In one-task-per-run this is the first archive;
    // for a legacy/inconsistent run with several tasks, clearing on the first
    // archive would let a still-live sibling resume a runaway exchange with a
    // fresh dead-loop budget. A run with zero tasks is left alone (no
    // tombstone evidence — same as the router's empty-list rule). Best-effort:
    // a failure is logged, never aborts the already-committed archive.
    if (newStatus === 'archived' && updated.workflowRunId) {
      const runTasks = this.taskRepo.listByWorkflowRunIncludingArchived(updated.workflowRunId);
      if (runTasks.length > 0 && runTasks.every((t) => t.archivedAt != null)) {
        try {
          new ChannelCycleRepository(this.db).resetAllForRun(updated.workflowRunId);
        } catch (err) {
          log.warn(
            `Failed to clear dead-loop history for archived run "${updated.workflowRunId}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    return updated;
  }

  // updateTaskProgress has been removed — progress tracking moved to node-level executions

  /**
   * Start a task (mark as in_progress)
   */
  async startTask(taskId: string): Promise<SpaceTask> {
    return this.setTaskStatus(taskId, 'in_progress');
  }

  /**
   * Publish a draft task — transition from `draft` to `open`.
   *
   * This is the only way to make a draft task runnable. The orchestrator
   * never picks up tasks in `draft` status; this method promotes the task
   * to `open` so the runtime's tick loop can attach a workflow and start it.
   *
   * @throws if the task is not in `draft` status
   */
  async publishTask(taskId: string): Promise<SpaceTask> {
    return this.setTaskStatus(taskId, 'open');
  }

  /**
   * Submit a task for human review.
   *
   * Single entry point for both the agent `submit_for_approval` tool and the
   * UI "Submit for Review" button. Atomically transitions a task into `review`
   * and stamps the pending-completion metadata that drives the
   * `PendingTaskCompletionBanner` — meaning every task that lands in `review`
   * is guaranteed to carry the banner-eligible fields.
   *
   * Three callers, one set of writes:
   *   - End-node `submit_for_approval` (passes a real `submittedByNodeId`)
   *   - Task Agent `submit_for_approval` (passes `null` — orchestrator has no
   *     workflow node)
   *   - UI "Submit for Review" RPC (passes `null` — user-initiated)
   *
   * Atomicity is load-bearing: the entire write — `status='review'` plus the
   * pending-completion fields — is issued as a single `taskRepo.updateTask`
   * call (one SQL UPDATE). A two-step write (`setTaskStatus` + a follow-up
   * pending-* update) would expose the exact banner-less in-between state
   * this PR is meant to eliminate: any concurrent reader landing between the
   * two writes would see `status='review' / pendingCheckpointType=null`. The
   * transition is validated inline against `isValidSpaceTaskTransition` so an
   * illegal source status (`done`, `archived`, …) throws before the write.
   */
  async submitTaskForReview(
    taskId: string,
    opts: {
      /**
       * Workflow node ID of the submitting agent, or `null` when there is no
       * waiting end-node session (Task Agent self-submit, UI submit). Used by
       * `PostApprovalRouter` to distinguish agent-initiated vs user-initiated
       * approvals when emitting awareness events.
       */
      submittedByNodeId: string | null;
      /** Optional human-readable reason; surfaces in the approval banner. */
      reason: string | null;
    }
  ): Promise<SpaceTask> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Inline transition validation. Mirrors the check in `setTaskStatus` —
    // kept here (rather than delegating) so the status flip and the pending-*
    // stamp can happen in a single SQL UPDATE.
    //
    // Re-submitting while already in `review` is intentionally idempotent ONLY
    // when the existing checkpoint is `task_completion` (multi-cycle workflows
    // where the agent re-submits after a prior submit_for_approval).  Other
    // checkpoint types — notably `gate` set by handleGatePendingApproval — must
    // NOT be overwritten because the runtime relies on `pendingCheckpointType:
    // 'gate'` to reactivate the task when the gate opens.
    if (task.status === 'review') {
      if (task.pendingCheckpointType !== 'task_completion' && task.pendingCheckpointType != null) {
        throw new Error(
          `Cannot re-submit task in 'review' with pendingCheckpointType '${task.pendingCheckpointType}'. ` +
            `Only 'task_completion' checkpoints can be refreshed.`
        );
      }
    } else if (!isValidSpaceTaskTransition(task.status, 'review')) {
      throw new Error(
        `Invalid status transition from '${task.status}' to 'review'. ` +
          `Allowed: ${VALID_SPACE_TASK_TRANSITIONS[task.status].join(', ') || 'none'}`
      );
    }

    // Single atomic write: status flip + pending-completion stamp in one
    // repository UPDATE. No reader can observe `status='review'` without the
    // pending-* fields populated, which is the whole point of this helper.
    // Clear `blockReason` so a task parked in `blocked` (e.g. with
    // `dependency_failed`) doesn't carry that stale classification into
    // `review` — this path bypasses `setTaskStatus`, so the exit-from-blocked
    // clear there doesn't run. No-op for non-blocked sources. (task #849, G2)
    const updated = this.taskRepo.updateTask(taskId, {
      status: 'review',
      pendingCheckpointType: 'task_completion',
      pendingCompletionSubmittedByNodeId: opts.submittedByNodeId,
      pendingCompletionSubmittedAt: Date.now(),
      pendingCompletionReason: opts.reason,
      blockReason: null,
      // Stamp the durable source node in the same UPDATE so the post-approval
      // router/dispatch can resolve it after the pending fields are atomically
      // cleared on entering `approved` (task #851).
      postApprovalSourceNodeId: opts.submittedByNodeId,
    });
    if (!updated) {
      throw new Error(`Failed to submit task for review: ${taskId}`);
    }
    return updated;
  }

  /**
   * Complete a task
   */
  async completeTask(taskId: string, result: string): Promise<SpaceTask> {
    return this.setTaskStatus(taskId, 'done', { result });
  }

  /**
   * Fail a task (mark as blocked)
   */
  async failTask(
    taskId: string,
    error?: string,
    blockReason?: SpaceBlockReason
  ): Promise<SpaceTask> {
    return this.setTaskStatus(taskId, 'blocked', {
      ...(error ? { result: error } : {}),
      blockReason,
    });
  }

  /**
   * Cancel a task and cascade to pending dependents
   */
  async cancelTask(taskId: string): Promise<SpaceTask> {
    const all = await this.cancelTaskCascade(taskId);
    return all[0];
  }

  /**
   * Cancel task and cascade to pending dependents recursively
   */
  async cancelTaskCascade(taskId: string): Promise<SpaceTask[]> {
    return this.doCancelCascade(taskId, []);
  }

  private async doCancelCascade(taskId: string, acc: SpaceTask[]): Promise<SpaceTask[]> {
    const result = await this.setTaskStatus(taskId, 'cancelled');
    acc.push(result);

    const pendingTasks = await this.listTasksByStatus('open');
    for (const t of pendingTasks) {
      if (t.dependsOn?.includes(taskId)) {
        await this.doCancelCascade(t.id, acc);
      }
    }

    return acc;
  }

  /**
   * Promote draft tasks created by a planning task to pending
   */
  async promoteDraftTasks(creatorTaskId: string): Promise<number> {
    return this.taskRepo.promoteDraftTasksByCreator(creatorTaskId);
  }

  /**
   * Archive a task - transitions to 'archived' status and sets archivedAt timestamp.
   * Validates that the current status allows transitioning to 'archived'.
   */
  async archiveTask(taskId: string): Promise<SpaceTask> {
    // Delegate to setTaskStatus so that workflow cleanup logic runs:
    // - Clear pendingCheckpointType/pendingCompletion* when leaving 'review'
    // - Clear postApproval* fields when leaving 'approved'
    // updateTask also stamps archived_at when status is 'archived'.
    return this.setTaskStatus(taskId, 'archived');
  }

  /**
   * Delete a task
   */
  async deleteTask(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (!task) {
      return false;
    }

    return this.taskRepo.deleteTask(taskId);
  }

  /**
   * Update task fields directly (non-status fields).
   * For status transitions use setTaskStatus instead.
   */
  async updateTask(
    taskId: string,
    params: UpdateSpaceTaskParams,
    options?: {
      /** Optional callback invoked with tasks cascaded by dependency changes. */
      onCascadedTasks?: (cascaded: SpaceTask[]) => Promise<void>;
    }
  ): Promise<SpaceTask> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Status changes must go through setTaskStatus for transition validation
    if (params.status !== undefined && params.status !== task.status) {
      throw new Error('Use setTaskStatus to change task status — it enforces valid transitions');
    }

    // Validate dependency IDs if being updated
    if (params.dependsOn !== undefined) {
      await this.validateDependencyIds(params.dependsOn, taskId);
    }

    // Detect whether dependsOn is being changed (and to what)
    const depsChanged =
      params.dependsOn !== undefined && !arraysEqual(task.dependsOn ?? [], params.dependsOn);

    // Strip status from the update params so the repo call is clean
    const { status: _status, ...repoParams } = params;
    const updated = this.taskRepo.updateTask(taskId, repoParams);
    if (!updated) {
      throw new Error(`Failed to update task: ${taskId}`);
    }

    // Gap 1 fix: if dependsOn was changed, re-check dependency constraints.
    // - in_progress + unmet deps: block the task
    // - blocked (dependency_added/dependency_failed) + now met: reopen
    // - open + unmet deps: tick loop handles it
    if (depsChanged) {
      const depsMet = await this.areDependenciesMet(updated);
      if (!depsMet && updated.status === 'in_progress') {
        const blocked = await this.setTaskStatus(taskId, 'blocked', {
          blockReason: 'dependency_added',
          result: 'Dependency added while task was in progress',
        });
        // Cascade: block any in_progress tasks that depend on this
        // newly-blocked task (mirrors updateTaskAndEmit cascade).
        const cascaded = await this.blockDependentTasks(taskId);
        if (cascaded.length > 0 && options?.onCascadedTasks) {
          await options.onCascadedTasks(cascaded);
        }
        return blocked;
      } else if (
        depsMet &&
        updated.status === 'blocked' &&
        (updated.blockReason === 'dependency_added' || updated.blockReason === 'dependency_failed')
      ) {
        return this.setTaskStatus(taskId, 'open');
      }
    }

    return updated;
  }

  /**
   * Retry a failed, cancelled, or done task.
   * Done/cancelled tasks are reactivated to in_progress; blocked tasks reset to open.
   * Optionally updates the description on retry.
   *
   * This is a daemon-internal method called by Space Agent MCP tools (not exposed via RPC handlers).
   */
  async retryTask(taskId: string, options?: { description?: string }): Promise<SpaceTask> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const retryableStatuses: SpaceTaskStatus[] = ['blocked', 'cancelled', 'done'];
    if (!retryableStatuses.includes(task.status)) {
      throw new Error(
        `Cannot retry task in '${task.status}' status. Task must be in 'blocked', 'cancelled', or 'done' status.`
      );
    }

    // Transition to in_progress for done/cancelled (reactivation), open for blocked
    const targetStatus: SpaceTaskStatus =
      task.status === 'done' || task.status === 'cancelled' ? 'in_progress' : 'open';
    // Transition first — if this fails, the description is untouched (no partial state)
    const retried = await this.setTaskStatus(taskId, targetStatus);

    // Apply optional description update after successful status transition
    if (options?.description !== undefined) {
      return this.updateTask(taskId, { description: options.description });
    }

    return retried;
  }

  /**
   * Reassign a task to a different agent.
   * Only allowed for tasks in 'open', 'blocked', 'cancelled', or 'done' status.
   *
   * This is a daemon-internal method called by Space Agent MCP tools (not exposed via RPC handlers).
   * TODO: Update callers to use new status values — customAgentId/assignedAgent fields removed.
   */
  async reassignTask(
    taskId: string,
    _customAgentId?: string | null,
    _assignedAgent?: string
  ): Promise<SpaceTask> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const allowedStatuses: SpaceTaskStatus[] = ['open', 'blocked', 'cancelled', 'done'];
    if (!allowedStatuses.includes(task.status)) {
      throw new Error(
        `Cannot reassign task in '${task.status}' status. Task must be in 'open', 'blocked', 'cancelled', or 'done' status.`
      );
    }

    // Agent assignment fields removed from SpaceTask — return task unchanged
    return task;
  }

  /**
   * Check if all dependencies for a task are met (completed)
   */
  async areDependenciesMet(task: SpaceTask): Promise<boolean> {
    if (!task.dependsOn || task.dependsOn.length === 0) {
      return true;
    }

    for (const depId of task.dependsOn) {
      const dep = await this.getTask(depId);
      if (!dep || dep.status !== 'done') {
        return false;
      }
    }

    return true;
  }

  /**
   * Block in_progress tasks that depend on the given (failed/blocked) task
   * with 'dependency_failed'. Open tasks are intentionally NOT blocked here —
   * they haven't started yet, so they should remain `open` and be skipped
   * naturally by `areDependenciesMet()` on the next runtime tick. Blocking
   * them would prevent them from ever auto-starting once their dependency
   * completes (they'd need a manual retry).
   *
   * For cancellation propagation (a terminal parent that won't be retried),
   * use `cancelDependentTasks` instead — it cancels both `open` and
   * `in_progress` dependents so they don't wait forever on an unmet dep.
   *
   * Recurses: if task B (in_progress) depends on A and task C (in_progress)
   * depends on B, blocking A cascades to both B and C.
   */
  async blockDependentTasks(taskId: string): Promise<SpaceTask[]> {
    return this.doBlockCascade(taskId, []);
  }

  /**
   * Cancel both `open` and `in_progress` tasks that depend on the given
   * (already-cancelled) task. Cancellation is terminal-but-restartable —
   * propagating `cancelled` keeps dependents from waiting forever on a
   * parent that will never reach `done`. A user can still retry the chain
   * by reactivating from the root.
   *
   * Use this from runtime paths where the parent has *already* been set to
   * `cancelled`. The API-level `cancelTaskCascade` is the one-shot version
   * that sets the root and cascades open dependents in a single call.
   *
   * Recurses through transitive dependents.
   */
  async cancelDependentTasks(taskId: string): Promise<SpaceTask[]> {
    return this.doCancelDependentsCascade(taskId, []);
  }

  private async doBlockCascade(taskId: string, acc: SpaceTask[]): Promise<SpaceTask[]> {
    // Include rate/usage-limited dependents: a paused dependent must be blocked
    // when its prerequisite fails, otherwise recoverRateLimitedTasks would later
    // restore it to in_progress despite the unmet dependency.
    const dependents = [
      ...(await this.listTasksByStatus('in_progress')),
      ...(await this.listTasksByStatus('rate_limited')),
      ...(await this.listTasksByStatus('usage_limited')),
    ];
    for (const t of dependents) {
      // Skip tasks already blocked by a prior recursive path in this cascade
      if (acc.some((a) => a.id === t.id)) continue;
      if (t.dependsOn?.includes(taskId)) {
        const blocked = await this.setTaskStatus(t.id, 'blocked', {
          blockReason: 'dependency_failed',
          result: `Dependency task ${taskId} failed or was cancelled`,
        });
        acc.push(blocked);
        await this.doBlockCascade(t.id, acc);
      }
    }
    return acc;
  }

  private async doCancelDependentsCascade(
    taskId: string,
    acc: SpaceTask[],
    visited: Set<string> = new Set()
  ): Promise<SpaceTask[]> {
    // Walk through ALL non-archived tasks so we can traverse intermediate
    // `cancelled` dependents to reach their (still-open) descendants. We
    // only *transition* `open`/`in_progress` tasks. Recursion only continues
    // through tasks we just cancelled OR that were already `cancelled` —
    // dependents in `done`/`review`/`approved`/`blocked` represent intact
    // intermediate state, so their downstream descendants have a satisfied
    // (or independently-failed) dependency edge and must not be transitively
    // cancelled. Example: A retried→cancelled, B (deps:[A]) already done,
    // C (deps:[B]) open — C must remain runnable because B is satisfied.
    const allTasks = await this.listTasks(false /* includeArchived */);
    for (const t of allTasks) {
      if (visited.has(t.id)) continue;
      if (!t.dependsOn?.includes(taskId)) continue;
      visited.add(t.id);

      let propagate = false;
      if (
        t.status === 'open' ||
        t.status === 'in_progress' ||
        // A dependent paused on a rate/usage cap must be cancelled too —
        // otherwise recoverRateLimitedTasks would later restore it to
        // in_progress and resume work despite the cancelled prerequisite.
        isRateOrUsageLimited(t.status)
      ) {
        const cancelled = await this.setTaskStatus(t.id, 'cancelled', {
          result: `Dependency task ${taskId} was cancelled`,
        });
        acc.push(cancelled);
        propagate = true;
      } else if (t.status === 'cancelled') {
        // Already-cancelled intermediate: keep traversing so we can reach
        // any still-open descendants that depend on this branch.
        propagate = true;
      }

      if (propagate) {
        await this.doCancelDependentsCascade(t.id, acc, visited);
      }
    }
    return acc;
  }

  /**
   * Unblock dependent tasks whose `dependency_failed` / `dependency_added`
   * block reason is now fully resolved because all their deps reached `done`.
   *
   * Called after a task transitions to `done` - finds every task in the
   * same space that depends on the completed task, re-evaluates their full
   * dependency set, and transitions eligible blocked tasks back to `open`
   * so the tick loop can pick them up.
   */
  async unblockDependentTasks(taskId: string): Promise<SpaceTask[]> {
    const unblocked: SpaceTask[] = [];
    const allTasks = await this.listTasks(false /* includeArchived */);
    for (const t of allTasks) {
      if (t.status !== 'blocked') continue;
      if (t.blockReason !== 'dependency_failed' && t.blockReason !== 'dependency_added') continue;
      if (!t.dependsOn?.includes(taskId)) continue;
      // Re-check ALL deps for this task
      const depsMet = await this.areDependenciesMet(t);
      if (depsMet) {
        try {
          const reopened = await this.setTaskStatus(t.id, 'open');
          unblocked.push(reopened);
        } catch {
          // Per-dependent: a concurrent status change (e.g. archive)
          // can make blocked→open invalid. Skip this dependent and
          // continue with the rest rather than aborting the cascade.
        }
      }
    }
    return unblocked;
  }

  /**
   * Validate that dependency IDs exist in this space and don't create cycles.
   * @param depIds - dependency task IDs to validate
   * @param taskId - the task being created/updated (omit for new tasks)
   */
  private async validateDependencyIds(depIds: string[], taskId?: string): Promise<void> {
    for (const depId of depIds) {
      if (taskId && depId === taskId) {
        throw new Error('A task cannot depend on itself');
      }
      const dep = await this.getTask(depId);
      if (!dep) {
        throw new Error(`Dependency task not found in space: ${depId}`);
      }
    }

    // Cycle detection: build adjacency from existing tasks + proposed deps
    if (taskId && depIds.length > 0) {
      const allTasks = await this.listTasks(true);
      const adj = new Map<string, string[]>();
      for (const t of allTasks) {
        if (t.id === taskId) {
          adj.set(t.id, [...depIds]); // use proposed deps
        } else {
          adj.set(t.id, [...(t.dependsOn ?? [])]);
        }
      }
      if (this.hasCycle(adj)) {
        throw new Error('Adding these dependencies would create a circular dependency');
      }
    }
  }

  /**
   * DFS cycle detection on a directed graph.
   * Returns true if any cycle exists.
   */
  private hasCycle(adj: Map<string, string[]>): boolean {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    for (const id of adj.keys()) {
      color.set(id, WHITE);
    }

    const dfs = (node: string): boolean => {
      color.set(node, GRAY);
      for (const neighbor of adj.get(node) ?? []) {
        const c = color.get(neighbor);
        if (c === GRAY) return true; // back edge → cycle
        if (c === WHITE && dfs(neighbor)) return true;
      }
      color.set(node, BLACK);
      return false;
    };

    for (const id of adj.keys()) {
      if (color.get(id) === WHITE && dfs(id)) return true;
    }
    return false;
  }
}
