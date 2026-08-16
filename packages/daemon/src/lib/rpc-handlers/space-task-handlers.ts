/**
 * Space Task RPC Handlers
 *
 * RPC handlers for SpaceTask CRUD operations:
 * - spaceTask.create - Create a task in a Space
 * - spaceTask.list   - List tasks in a Space
 * - spaceTask.get    - Get a task by ID
 * - spaceTask.update - Update task fields (metadata and status with transition validation)
 */

import {
  isRateOrUsageLimited,
  isWorkflowRecoveryTransition,
  resolveNodeAgents,
  type CreateSpaceTaskParams,
  type MessageHub,
  type PaginatedSpaceTaskResult,
  type SpaceBlockReason,
  type SpaceTask,
  type SpaceTaskStatus,
  type UpdateSpaceTaskParams,
} from '@hyperneo/shared';

const TERMINAL_TASK_STATUSES = new Set<SpaceTaskStatus>([
  'done',
  'blocked',
  'cancelled',
  'archived',
]);
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import { Logger } from '../logger';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceTaskManager } from '../space/managers/space-task-manager';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service';
import { mapPostApprovalDispatchWarning } from '../space/runtime/post-approval-router';
import type { SpaceGoalService } from '../space/goals/goal-service';
import { arraysEqual } from '../utils/array-utils';

const log = new Logger('space-task-handlers');

function isPlainWorkflowModelOverrideMap(value: unknown): value is Record<string, string> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function validateWorkflowModelOverrides(
  task: SpaceTask,
  workflowManager: SpaceWorkflowManager,
  overrides: unknown,
  workflowId: string | null | undefined = task.preferredWorkflowId
): Promise<Record<string, string> | null | undefined> {
  if (overrides === undefined) return undefined;
  if (task.workflowRunId || task.startedAt) {
    throw new Error('Workflow model overrides are locked after the task starts');
  }
  if (overrides === null) return null;
  if (!isPlainWorkflowModelOverrideMap(overrides)) {
    throw new Error('workflowModelOverrides must be a string map');
  }
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== 'string') {
      throw new Error('workflowModelOverrides must be a string map');
    }
    const cleanKey = key.trim();
    const cleanValue = value.trim();
    if (cleanKey && cleanValue) clean[cleanKey] = cleanValue;
  }
  if (!workflowId) {
    if (Object.keys(clean).length > 0) {
      throw new Error('Select a workflow before setting model overrides');
    }
    return null;
  }
  const workflow = workflowManager.getWorkflow(workflowId);
  if (!workflow || workflow.spaceId !== task.spaceId) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }
  if (workflow.disabled) {
    throw new Error('Cannot set model overrides for a disabled workflow');
  }
  const validKeys = new Set<string>();
  for (const node of workflow.nodes) {
    for (const agent of resolveNodeAgents(node)) {
      validKeys.add(`${node.id}:${agent.name}`);
    }
  }
  for (const key of Object.keys(clean)) {
    if (!validKeys.has(key)) {
      throw new Error(`Invalid workflow model override target: ${key}`);
    }
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

/**
 * Factory that creates a SpaceTaskManager bound to a specific spaceId.
 * Injected so tests can substitute a mock manager.
 */
export type SpaceTaskManagerFactory = (spaceId: string) => SpaceTaskManager;

export function setupSpaceTaskHandlers(
  messageHub: MessageHub,
  spaceManager: SpaceManager,
  workflowManager: SpaceWorkflowManager,
  taskManagerFactory: SpaceTaskManagerFactory,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  spaceRuntimeService?: SpaceRuntimeService,
  spaceGoalService?: Pick<SpaceGoalService, 'handleTaskTerminal'>
): void {
  // ─── spaceTask.create ───────────────────────────────────────────────────────
  messageHub.onRequest('spaceTask.create', async (data) => {
    const params = data as CreateSpaceTaskParams & { draft?: boolean; goalId?: unknown };

    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }
    if (!params.title || params.title.trim() === '') {
      throw new Error('title is required');
    }
    // description is required but may be an empty string — reject only null/undefined
    if (params.description === undefined || params.description === null) {
      throw new Error('description must not be null');
    }

    // Verify space exists
    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) {
      throw new Error(`Space not found: ${params.spaceId}`);
    }

    const taskManager = taskManagerFactory(params.spaceId);
    const {
      spaceId,
      draft,
      id: _id,
      goalId: _goalId,
      createdBy: _cb,
      createdBySession: _cbs,
      ...rest
    } = params as typeof params & { id?: unknown };

    // The draft flag is an alias for status: 'draft'. Reject contradictory
    // input instead of silently allowing status to override draft: true.
    if (draft && rest.status && rest.status !== 'draft') {
      throw new Error('draft: true cannot be combined with a non-draft status');
    }
    if (draft) {
      rest.status = 'draft';
    }
    const task = await taskManager.createTask(rest);

    internalEventBus
      .publish('space.task.created', {
        sessionId: 'global',
        spaceId,
        taskId: task.id,
        task,
      })
      .catch((err) => {
        log.warn('Failed to emit space.task.created:', err);
      });

    return task;
  });

  // ─── spaceTask.list ─────────────────────────────────────────────────────────
  //
  // Two response shapes for backward compatibility:
  //
  //   1. Legacy / overview call: `{ spaceId, includeArchived? }` →
  //      returns `SpaceTask[]` (full list, no pagination). Used by the
  //      initial space-overview load, sidebar badge counts, and tab counts.
  //
  //   2. Paginated single-group call: any of `status`, `limit`, `offset`,
  //      or `blockReason` provided → returns `PaginatedSpaceTaskResult`
  //      `{ tasks, total }`. Used by the Tasks view's per-group Prev/Next
  //      pagination (10 items per status group).
  //
  // `blockReason` is treated as a tri-state filter: omitted (undefined) =
  // ignore the column; `null` = match rows with no reason set; a value =
  // match exactly. The Action tab uses this to split blocked rows into
  // "Needs Input" / "Gate Pending" / generic-"Blocked" buckets. `blockReason`
  // requires `status === 'blocked'` — combining it with another status
  // filter would silently return an empty page (the data shape doesn't
  // support that combination), so we reject it loudly instead.
  messageHub.onRequest('spaceTask.list', async (data) => {
    const params = data as {
      spaceId: string;
      includeArchived?: boolean;
      status?: SpaceTaskStatus;
      blockReason?: SpaceBlockReason | null;
      blockReasonNotIn?: SpaceBlockReason[];
      limit?: number;
      offset?: number;
    };

    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }

    // Verify space exists
    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) {
      throw new Error(`Space not found: ${params.spaceId}`);
    }

    const taskManager = taskManagerFactory(params.spaceId);

    const usePagination =
      params.status !== undefined ||
      params.limit !== undefined ||
      params.offset !== undefined ||
      params.blockReason !== undefined ||
      params.blockReasonNotIn !== undefined;

    if (!usePagination) {
      return taskManager.listTasks(params.includeArchived ?? false);
    }

    if (params.status === undefined) {
      throw new Error('status is required when paginating spaceTask.list');
    }
    if (
      (params.blockReason !== undefined || params.blockReasonNotIn !== undefined) &&
      params.status !== 'blocked'
    ) {
      throw new Error("blockReason / blockReasonNotIn filter requires status === 'blocked'");
    }
    if (params.blockReason !== undefined && params.blockReasonNotIn !== undefined) {
      throw new Error('blockReason and blockReasonNotIn are mutually exclusive');
    }

    const limit = params.limit ?? 10;
    const offset = params.offset ?? 0;
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error('limit must be a positive number');
    }
    if (!Number.isFinite(offset) || offset < 0) {
      throw new Error('offset must be a non-negative number');
    }

    const result: PaginatedSpaceTaskResult = await taskManager.listTasksByStatusPaginated(
      params.status,
      params.blockReason,
      limit,
      offset,
      params.blockReasonNotIn
    );
    return result;
  });

  // ─── spaceTask.get ──────────────────────────────────────────────────────────
  messageHub.onRequest('spaceTask.get', async (data) => {
    const params = data as { spaceId: string; taskId: string };

    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }
    if (!params.taskId) {
      throw new Error('taskId is required');
    }

    // Verify space exists (consistent with create/list validation pattern)
    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) {
      throw new Error(`Space not found: ${params.spaceId}`);
    }

    const taskManager = taskManagerFactory(params.spaceId);
    const task = await taskManager.getTask(params.taskId);
    if (!task) {
      throw new Error(`Task not found: ${params.taskId}`);
    }

    return task;
  });

  // ─── spaceTask.update ───────────────────────────────────────────────────────
  messageHub.onRequest('spaceTask.update', async (data) => {
    const params = data as {
      spaceId: string;
      taskId: string;
      goalId?: unknown;
    } & UpdateSpaceTaskParams;

    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }
    if (!params.taskId) {
      throw new Error('taskId is required');
    }

    // `expectedStatuses` is a storage-only optimistic-concurrency guard: a
    // client-supplied list would let the caller widen (or, as [], silently
    // refuse) the atomic status predicate. Strip it from the untyped request
    // payload before the spread reaches the manager.
    delete (params as { expectedStatuses?: unknown }).expectedStatuses;
    const { spaceId, taskId, goalId: _goalId, ...updateParams } = params;

    // Verify space exists — consistent with create/list/get validation.
    // Without this check, a bad spaceId would surface as "Task not found" rather
    // than "Space not found", which is misleading.
    const space = await spaceManager.getSpace(spaceId);
    if (!space) {
      throw new Error(`Space not found: ${spaceId}`);
    }

    const taskManager = taskManagerFactory(spaceId);
    const currentTaskForOverrides = await taskManager.getTask(taskId);
    if (!currentTaskForOverrides) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const nextWorkflowId = Object.hasOwn(updateParams, 'preferredWorkflowId')
      ? updateParams.preferredWorkflowId
      : currentTaskForOverrides.preferredWorkflowId;
    const taskForOverrideValidation =
      updateParams.status === 'in_progress' &&
      updateParams.status !== currentTaskForOverrides.status
        ? { ...currentTaskForOverrides, status: updateParams.status, startedAt: Date.now() }
        : currentTaskForOverrides;
    const workflowSelectionChanged =
      Object.hasOwn(updateParams, 'preferredWorkflowId') &&
      updateParams.preferredWorkflowId !== currentTaskForOverrides.preferredWorkflowId;
    const validatedWorkflowModelOverrides = await validateWorkflowModelOverrides(
      taskForOverrideValidation,
      workflowManager,
      updateParams.workflowModelOverrides,
      nextWorkflowId
    );
    if (validatedWorkflowModelOverrides !== undefined) {
      updateParams.workflowModelOverrides = validatedWorkflowModelOverrides;
    } else if (workflowSelectionChanged) {
      updateParams.workflowModelOverrides = null;
    }
    const ensureWorkflowOverridesStillUnlocked = async (fields: Record<string, unknown>) => {
      if (!Object.hasOwn(fields, 'workflowModelOverrides')) return;
      const latestTask = await taskManager.getTask(taskId);
      if (!latestTask) {
        throw new Error(`Task not found: ${taskId}`);
      }
      if (latestTask.workflowRunId || latestTask.startedAt) {
        throw new Error('Workflow model overrides are locked after the task starts');
      }
    };

    let task: SpaceTask;
    let emitTaskUpdated = true;
    let handleGoalTerminal = true;
    const emitCascadedTasks = async (cascadedTasks: SpaceTask[]) => {
      if (!emitTaskUpdated) return;
      for (const cascadedTask of cascadedTasks) {
        await internalEventBus.publish('space.task.updated', {
          sessionId: 'global',
          spaceId,
          taskId: cascadedTask.id,
          task: cascadedTask,
        });
      }
    };

    const updateTaskWithRuntimeDependencyBlock = async (
      currentTask: SpaceTask
    ): Promise<{ task: SpaceTask; handledByRuntime: boolean }> => {
      let dependencyCheckResult: SpaceTask | null = null;
      let runtimeForDependencyBlock: SpaceRuntimeService | null = null;
      let dependencyAddedToActiveWorkflow = false;
      if (
        spaceRuntimeService &&
        updateParams.dependsOn !== undefined &&
        currentTask.status === 'in_progress' &&
        currentTask.workflowRunId &&
        !arraysEqual(currentTask.dependsOn ?? [], updateParams.dependsOn)
      ) {
        const {
          taskAgentSessionId: _taskAgentSessionId,
          workflowRunId: _workflowRunId,
          ...safeParams
        } = updateParams;
        dependencyCheckResult = await taskManager.updateTask(taskId, safeParams, {
          onCascadedTasks: emitCascadedTasks,
        });
        dependencyAddedToActiveWorkflow =
          dependencyCheckResult.status === 'blocked' &&
          dependencyCheckResult.blockReason === 'dependency_added';
        runtimeForDependencyBlock = spaceRuntimeService;
      }

      if (dependencyAddedToActiveWorkflow && runtimeForDependencyBlock) {
        return {
          task: await runtimeForDependencyBlock.stopWorkflowBackedTask(spaceId, taskId, {
            ...updateParams,
            status: 'blocked',
            blockReason: 'dependency_added',
            result: 'Dependency added while task was in progress',
            completedAt: null,
          }),
          handledByRuntime: true,
        };
      }

      if (dependencyCheckResult) {
        const pointerParams: UpdateSpaceTaskParams = {};
        if ('taskAgentSessionId' in updateParams) {
          pointerParams.taskAgentSessionId = updateParams.taskAgentSessionId;
        }
        if ('workflowRunId' in updateParams) {
          pointerParams.workflowRunId = updateParams.workflowRunId;
        }
        if (Object.keys(pointerParams).length > 0) {
          dependencyCheckResult = await taskManager.updateTask(taskId, pointerParams, {
            onCascadedTasks: emitCascadedTasks,
          });
        }
      }

      return {
        task:
          dependencyCheckResult ??
          (await taskManager.updateTask(taskId, updateParams, {
            onCascadedTasks: emitCascadedTasks,
          })),
        handledByRuntime: false,
      };
    };

    // Route to setTaskStatus only when the status is actually changing.
    // Sending the current status as part of a broader metadata update must not
    // trigger a transition check (same→same is not in the transition table and
    // would throw a misleading "Invalid status transition" error).
    if (updateParams.status !== undefined) {
      // Fetch the current task to compare status before routing
      const currentTask = await taskManager.getTask(taskId);
      if (!currentTask) {
        throw new Error(`Task not found: ${taskId}`);
      }

      if (updateParams.status !== currentTask.status) {
        if (
          currentTask.workflowRunId &&
          isWorkflowRecoveryTransition(currentTask.status, updateParams.status)
        ) {
          if (!spaceRuntimeService) {
            throw new Error(
              `Cannot recover workflow-backed task ${taskId}: SpaceRuntimeService is unavailable.`
            );
          }
          task = await spaceRuntimeService.recoverWorkflowBackedTask(
            spaceId,
            taskId,
            updateParams.status
          );
          emitTaskUpdated = false;

          const {
            status: _s,
            result: _r,
            approvalReason: _ar,
            cancelReason: _cr,
            ...otherFields
          } = updateParams;
          if (Object.keys(otherFields).length > 0) {
            emitTaskUpdated = true;
            await ensureWorkflowOverridesStillUnlocked(otherFields);
            task = await taskManager.updateTask(taskId, otherFields, {
              onCascadedTasks: emitCascadedTasks,
            });
          }
        } else {
          // Tear down the workflow session when an active/paused task moves to a
          // stopped state. The 'blocked' target is restricted to rate/usage-
          // limited origins (a rate-limited task blocked manually must release
          // its armed cooldown session) so this stays scoped to the rate-limit
          // work — manually blocking a running `in_progress` task is unchanged
          // from before this PR (out of scope here).
          const fromActivePaused =
            currentTask.status === 'in_progress' ||
            currentTask.status === 'blocked' ||
            isRateOrUsageLimited(currentTask.status);
          const toStopped = updateParams.status === 'open' || updateParams.status === 'cancelled';
          const toBlockedFromPaused =
            updateParams.status === 'blocked' && isRateOrUsageLimited(currentTask.status);
          const shouldStopWorkflowForStatus =
            !!currentTask.workflowRunId && fromActivePaused && (toStopped || toBlockedFromPaused);
          // Reject bare transitions into `review`. Every task that lands in
          // `review` MUST carry the pending-completion fields so
          // `PendingTaskCompletionBanner` renders and approvals route through
          // `PostApprovalRouter`. Callers must use `spaceTask.submitForReview`
          // (UI) or the agent `submit_for_approval` tool — both go through
          // `SpaceTaskManager.submitTaskForReview` which writes the metadata
          // atomically. Without this guard a stray `update({status:'review'})`
          // would re-introduce the banner-less generic-button flow.
          if (updateParams.status === 'review') {
            throw new Error(
              `spaceTask.update cannot transition a task into 'review' directly. ` +
                `Use spaceTask.submitForReview (or the agent submit_for_approval tool) ` +
                `so the pending-completion fields get stamped and the approval banner renders.`
            );
          }
          // Reject bare transitions into `approved`. The `approved` status
          // is owned by the post-approval pipeline:
          //   - human approvals → `spaceTask.approvePendingCompletion`,
          //     which dispatches `PostApprovalRouter` (it calls
          //     `setTaskStatus(approved)` with the right metadata).
          //   - agent approvals → the runtime's reactive
          //     `reportedStatus='done'` handler, again routing through
          //     `PostApprovalRouter`.
          // A bare `update({status:'approved'})` would skip the awareness
          // event, the post-approval dispatch, and the approval-source
          // stamping — the same kind of gap the `→ review` guard above
          // closes on the entry side.
          if (updateParams.status === 'approved') {
            throw new Error(
              `spaceTask.update cannot transition a task into 'approved' directly. ` +
                `Use spaceTask.approvePendingCompletion (UI Approve banner) or let the ` +
                `runtime's post-approval router handle the transition — both stamp the ` +
                `approval metadata and dispatch the configured post-approval step.`
            );
          }
          // Reject archiving a task that belongs to an ACTIVE (non-terminal)
          // workflow run. Archiving it would strand the run: listByWorkflowRun
          // excludes archived tasks, so processRunTick early-returns on the
          // now-empty list and no reconciliation cancels the orphan — the run
          // stays `in_progress` forever with no canonical task to advance.
          // G1 (task #849) widened this from review/approved→archived to
          // open→archived (every run task's initial state). Tasks with no run,
          // and tasks on terminal (done/cancelled) runs, archive normally.
          // Direct the caller to Cancel, which routes through cancelWorkflowRun
          // and tears the run down properly.
          if (
            updateParams.status === 'archived' &&
            currentTask.workflowRunId &&
            spaceRuntimeService?.isWorkflowRunActive(currentTask.workflowRunId)
          ) {
            throw new Error(
              `Cannot archive task ${taskId}: it belongs to an active workflow run ` +
                `(${currentTask.workflowRunId}). Cancel the run instead (the task ` +
                `Cancel action or spaceWorkflowRun.cancel) so its agents and ` +
                `lifecycle are torn down — archiving would leave the run stranded.`
            );
          }
          if (shouldStopWorkflowForStatus) {
            if (!spaceRuntimeService) {
              throw new Error(
                `Cannot stop workflow-backed task ${taskId}: SpaceRuntimeService is unavailable.`
              );
            }
            task = await spaceRuntimeService.stopWorkflowBackedTaskForStatus(
              spaceId,
              taskId,
              updateParams
            );
            emitTaskUpdated = false;
            handleGoalTerminal = false;
          } else {
            // Status is changing — validate via setTaskStatus (enforces transitions).
            // `approvalReason` is stamped on review→done; `cancelReason` is
            // persisted into the same underlying column for review→cancelled
            // transitions (and other terminal rejections). We map both onto the
            // manager's `approvalReason` option because the DB schema keeps a
            // single `approval_reason` column doubling as audit trail for
            // approvals *and* rejections.
            const mappedReason =
              updateParams.status === 'cancelled'
                ? (updateParams.cancelReason ?? updateParams.approvalReason ?? undefined)
                : (updateParams.approvalReason ?? undefined);

            task = await taskManager.setTaskStatus(taskId, updateParams.status, {
              result: Object.hasOwn(updateParams, 'result') ? updateParams.result : undefined,
              reportedSummary: Object.hasOwn(updateParams, 'reportedSummary')
                ? updateParams.reportedSummary
                : undefined,
              // Human-initiated approval when transitioning from review → done
              approvalSource:
                currentTask.status === 'review' && updateParams.status === 'done'
                  ? 'human'
                  : undefined,
              approvalReason: mappedReason,
            });

            // When the transition alone cannot carry the rejection reason (e.g.
            // review → cancelled — setTaskStatus only stamps approvalReason on
            // review→done), apply it in a follow-up write. Keeps the audit trail
            // complete regardless of direction.
            if (
              updateParams.status === 'cancelled' &&
              (updateParams.cancelReason ?? updateParams.approvalReason)
            ) {
              task = await taskManager.updateTask(
                taskId,
                {
                  approvalReason: updateParams.cancelReason ?? updateParams.approvalReason ?? null,
                },
                { onCascadedTasks: emitCascadedTasks }
              );
            }

            // When a status transition is combined with other field updates
            // (e.g. taskAgentSessionId), those fields are silently dropped by
            // setTaskStatus. Apply them in a follow-up updateTask call so
            // callers can atomically set status + metadata in one RPC.
            const {
              status: _s,
              result: _r,
              approvalReason: _ar,
              cancelReason: _cr,
              ...otherFields
            } = updateParams;
            if (Object.keys(otherFields).length > 0) {
              await ensureWorkflowOverridesStillUnlocked(otherFields);
              task = await taskManager.updateTask(taskId, otherFields, {
                onCascadedTasks: emitCascadedTasks,
              });
            }
          }
        }
      } else {
        // Status is the same — treat as a regular field update.
        // updateParams still contains the unchanged status field; SpaceTaskManager.updateTask
        // strips it internally (guard: params.status !== task.status is false) so no
        // transition check fires and the status column is left untouched in the DB.
        await ensureWorkflowOverridesStillUnlocked(updateParams);
        const dependencyUpdate = await updateTaskWithRuntimeDependencyBlock(currentTask);
        task = dependencyUpdate.task;
        if (dependencyUpdate.handledByRuntime) {
          emitTaskUpdated = false;
          handleGoalTerminal = false;
        }
      }
    } else {
      // No status field — general field update
      const currentTask = await taskManager.getTask(taskId);
      if (!currentTask) {
        throw new Error(`Task not found: ${taskId}`);
      }
      await ensureWorkflowOverridesStillUnlocked(updateParams);
      const dependencyUpdate = await updateTaskWithRuntimeDependencyBlock(currentTask);
      task = dependencyUpdate.task;
      if (dependencyUpdate.handledByRuntime) {
        emitTaskUpdated = false;
        handleGoalTerminal = false;
      }
    }

    // Best-effort goal terminal handling — must not abort the RPC response.
    if (handleGoalTerminal && spaceGoalService && TERMINAL_TASK_STATUSES.has(task.status)) {
      try {
        spaceGoalService.handleTaskTerminal(task.id);
      } catch (err) {
        log.warn(
          `Goal terminal handling threw for task "${task.id}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (emitTaskUpdated) {
      internalEventBus
        .publish('space.task.updated', {
          sessionId: 'global',
          spaceId,
          taskId,
          task,
        })
        .catch((err) => {
          log.warn('Failed to emit space.task.updated:', err);
        });
    }

    return task;
  });

  // ─── spaceTask.recoverWorkflow ────────────────────────────────────────────
  messageHub.onRequest('spaceTask.recoverWorkflow', async (data) => {
    const params = data as {
      spaceId: string;
      taskId: string;
      status: 'open' | 'in_progress';
    };

    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.taskId) throw new Error('taskId is required');
    if (params.status !== 'open' && params.status !== 'in_progress') {
      throw new Error(`status must be 'open' or 'in_progress'`);
    }
    if (!spaceRuntimeService) {
      throw new Error(
        `Cannot recover workflow-backed task ${params.taskId}: SpaceRuntimeService is unavailable.`
      );
    }

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) {
      throw new Error(`Space not found: ${params.spaceId}`);
    }

    return spaceRuntimeService.recoverWorkflowBackedTask(
      params.spaceId,
      params.taskId,
      params.status
    );
  });

  // ─── spaceTask.submitForReview ──────────────────────────────────────────────
  // User-initiated counterpart to the agent `submit_for_approval` tool. Both
  // paths converge on `SpaceTaskManager.submitTaskForReview`, which atomically
  // transitions the task into `review` and stamps the pending-completion
  // fields that drive `PendingTaskCompletionBanner`. Without this RPC the UI
  // "Submit for Review" button degraded to a bare status update — landing the
  // task in `review` with no banner, no metadata, and a generic Approve button
  // that bypassed `PostApprovalRouter`. After unification, every task in
  // `review` is banner-eligible regardless of who submitted it.
  //
  // `pendingCompletionSubmittedByNodeId` is set to `null` for user-initiated
  // submissions — same semantics as a Task Agent self-submit. The post-
  // approval router treats both identically (no waiting end-node session to
  // resume; awareness events are best-effort).
  messageHub.onRequest('spaceTask.submitForReview', async (data) => {
    const params = data as {
      spaceId: string;
      taskId: string;
      reason?: string | null;
    };

    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.taskId) throw new Error('taskId is required');

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) {
      throw new Error(`Space not found: ${params.spaceId}`);
    }

    const taskManager = taskManagerFactory(params.spaceId);
    const task = await taskManager.submitTaskForReview(params.taskId, {
      submittedByNodeId: null,
      reason: params.reason ?? null,
    });

    internalEventBus
      .publish('space.task.updated', {
        sessionId: 'global',
        spaceId: params.spaceId,
        taskId: params.taskId,
        task,
      })
      .catch((err) => {
        log.warn('Failed to emit space.task.updated:', err);
      });

    return task;
  });

  // ─── spaceTask.approvePendingCompletion ─────────────────────────────────────
  // Design v2 (Task #39): human approval / rejection for tasks paused at a
  // `submit_for_approval` checkpoint (`pendingCheckpointType === 'task_completion'`).
  //
  // - `approved: true`  → transitions the task review → done, stamps approval
  //   metadata, clears pending-completion fields, and fires `space.task.updated`.
  // - `approved: false` → transitions the task back to in_progress so the end-node
  //   agent can revise its output; clears pending-completion fields. The optional
  //   `reason` is written to `approvalReason` as a rejection rationale.
  //
  // The handler refuses to operate on tasks that are not paused at a
  // `task_completion` checkpoint to avoid accidentally closing in-flight work.
  messageHub.onRequest('spaceTask.approvePendingCompletion', async (data) => {
    const params = data as {
      spaceId: string;
      taskId: string;
      approved: boolean;
      reason?: string | null;
    };

    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.taskId) throw new Error('taskId is required');
    if (typeof params.approved !== 'boolean') throw new Error('approved must be a boolean');

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) {
      throw new Error(`Space not found: ${params.spaceId}`);
    }

    const taskManager = taskManagerFactory(params.spaceId);
    const currentTask = await taskManager.getTask(params.taskId);
    if (!currentTask) {
      throw new Error(`Task not found: ${params.taskId}`);
    }

    if (currentTask.pendingCheckpointType !== 'task_completion') {
      throw new Error(
        `Task ${params.taskId} is not awaiting submit_for_approval review ` +
          `(pendingCheckpointType=${currentTask.pendingCheckpointType ?? 'null'}).`
      );
    }

    if (currentTask.status !== 'review') {
      throw new Error(
        `Task ${params.taskId} is not in 'review' status ` + `(current: ${currentTask.status}).`
      );
    }

    let task: SpaceTask;
    if (params.approved) {
      if (!spaceRuntimeService) {
        throw new Error(
          'spaceRuntimeService is required to approve pending completion — post-approval routing is the sole approval path.'
        );
      }
      // Delegate to the PostApprovalRouter. `dispatchPostApproval` transitions
      // review → approved (via SpaceTaskManager.setTaskStatus, stamping
      // `approvalReason` from `contextExtras`) and dispatches the configured
      // post-approval step (no-route → done, or spawn fresh node-agent). The
      // pending-completion fields are cleared by a `finally` around
      // `router.route()` inside `dispatchPostApproval` (Layer B invariant), so
      // by the time we re-read below they are null regardless of which router
      // branch ran — or whether the dispatch threw.
      //
      // Layer C robustness: the review → approved status transition commits
      // BEFORE the async post-approval dispatch. If that dispatch throws (e.g.
      // an SDK `"user interrupted"` abort during sub-session spawn — reproducer
      // task #847), the approval is nonetheless durable, so we must NOT surface
      // the raw throw: the user would assume the click failed and click again,
      // hitting the double-approval guard. Instead, confirm the task reached
      // `approved` and capture the failure as a post-approval-blocked reason so
      // the UI surfaces a recovery banner. If the status transition itself
      // failed (task never reached `approved`), rethrow — the approval did not
      // happen.
      try {
        await spaceRuntimeService.dispatchPostApproval(params.spaceId, params.taskId, 'human', {
          approvalReason: params.reason ?? null,
        });
      } catch (dispatchErr) {
        const afterCommit = await taskManager.getTask(params.taskId);
        if (afterCommit?.status !== 'approved') throw dispatchErr;
        const detail = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
        log.warn(
          `approvePendingCompletion: post-approval dispatch failed for task ${params.taskId} ` +
            `after status commit (${detail}); capturing as post-approval-blocked`
        );
        await taskManager.updateTask(params.taskId, {
          postApprovalBlockedReason: mapPostApprovalDispatchWarning(detail),
        });
      }
      // Re-read the task so the caller sees the post-router state.
      const refreshed = await taskManager.getTask(params.taskId);
      if (!refreshed) throw new Error(`Task not found: ${params.taskId}`);
      task = refreshed;
    } else {
      // review → in_progress (reject). Reason captured as `approvalReason`
      // for audit. `setTaskStatus` nulls the pending-completion fields in
      // the same UPDATE (centralised "exit review" cleanup), so the
      // follow-up `updateTask` only stamps the rejection reason.
      task = await taskManager.setTaskStatus(params.taskId, 'in_progress');
      task = await taskManager.updateTask(params.taskId, {
        approvalReason: params.reason ?? null,
      });
    }

    internalEventBus
      .publish('space.task.updated', {
        sessionId: 'global',
        spaceId: params.spaceId,
        taskId: params.taskId,
        task,
      })
      .catch((err) => {
        log.warn('Failed to emit space.task.updated:', err);
      });

    return task;
  });

  // ─── spaceTask.publish ─────────────────────────────────────────────────────
  // Promote a draft task to `open` so the orchestrator can pick it up.
  // This is the only valid transition out of `draft` — enforced by
  // VALID_SPACE_TASK_TRANSITIONS. The handler validates the current status
  // before delegating to SpaceTaskManager.publishTask.
  messageHub.onRequest('spaceTask.publish', async (data) => {
    const params = data as { spaceId: string; taskId: string };

    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.taskId) throw new Error('taskId is required');

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) {
      throw new Error(`Space not found: ${params.spaceId}`);
    }

    const taskManager = taskManagerFactory(params.spaceId);
    const currentTask = await taskManager.getTask(params.taskId);
    if (!currentTask) {
      throw new Error(`Task not found: ${params.taskId}`);
    }

    if (currentTask.status !== 'draft') {
      throw new Error(
        `Task ${params.taskId} is not in 'draft' status (current: ${currentTask.status}). Only draft tasks can be published.`
      );
    }

    const task = await taskManager.publishTask(params.taskId);

    internalEventBus
      .publish('space.task.updated', {
        sessionId: 'global',
        spaceId: params.spaceId,
        taskId: params.taskId,
        task,
      })
      .catch((err) => {
        log.warn('Failed to emit space.task.updated:', err);
      });

    return task;
  });
}
