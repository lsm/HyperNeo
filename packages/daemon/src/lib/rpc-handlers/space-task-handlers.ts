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

import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { Logger } from '../logger.ts';
import type { SpaceManager } from '../space/managers/space-manager.ts';
import type { SpaceTaskManager } from '../space/managers/space-task-manager.ts';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager.ts';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service.ts';
import { mapPostApprovalDispatchWarning } from '../space/runtime/post-approval-router.ts';
import { arraysEqual } from '../utils/array-utils.ts';

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

export type SpaceTaskManagerFactory = (spaceId: string) => SpaceTaskManager;

export function setupSpaceTaskHandlers(
  messageHub: MessageHub,
  spaceManager: SpaceManager,
  workflowManager: SpaceWorkflowManager,
  taskManagerFactory: SpaceTaskManagerFactory,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  spaceRuntimeService?: SpaceRuntimeService
): void {
  messageHub.onRequest('spaceTask.create', async (data) => {
    const params = data as CreateSpaceTaskParams & { draft?: boolean; goalId?: unknown };

    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }
    if (!params.title || params.title.trim() === '') {
      throw new Error('title is required');
    }
    if (params.description === undefined || params.description === null) {
      throw new Error('description must not be null');
    }

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

    if (draft && rest.status && rest.status !== 'draft') {
      throw new Error('draft: true cannot be combined with a non-draft status');
    }
    if (draft) {
      rest.status = 'draft';
    }
    if (rest.status === 'stopped') {
      throw new Error(
        `spaceTask.create cannot create a task with initial status 'stopped'. ` +
          `Tasks are stopped through the task Stop action once it lands — ` +
          `'stopped' is a dormant capability until then.`
      );
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

  messageHub.onRequest('spaceTask.get', async (data) => {
    const params = data as { spaceId: string; taskId: string };

    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }
    if (!params.taskId) {
      throw new Error('taskId is required');
    }

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

    const { spaceId, taskId, goalId: _goalId, ...updateParams } = params;

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

    if (updateParams.status !== undefined) {
      const currentTask = await taskManager.getTask(taskId);
      if (!currentTask) {
        throw new Error(`Task not found: ${taskId}`);
      }

      if (updateParams.status !== currentTask.status) {
        if (Object.hasOwn(updateParams, 'workspacePath')) {
          await taskManager.updateTask(
            taskId,
            { workspacePath: updateParams.workspacePath },
            { onCascadedTasks: emitCascadedTasks }
          );
          delete (updateParams as Record<string, unknown>).workspacePath;
        }

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
          const fromActivePaused =
            currentTask.status === 'in_progress' ||
            currentTask.status === 'blocked' ||
            currentTask.status === 'stopped' ||
            isRateOrUsageLimited(currentTask.status);
          const toStopped = updateParams.status === 'open' || updateParams.status === 'cancelled';
          const toBlockedFromPaused =
            updateParams.status === 'blocked' && isRateOrUsageLimited(currentTask.status);
          const shouldStopWorkflowForStatus =
            !!currentTask.workflowRunId && fromActivePaused && (toStopped || toBlockedFromPaused);
          if (updateParams.status === 'review') {
            throw new Error(
              `spaceTask.update cannot transition a task into 'review' directly. ` +
                `Use spaceTask.submitForReview (or the agent submit_for_approval tool) ` +
                `so the pending-completion fields get stamped and the approval banner renders.`
            );
          }
          if (updateParams.status === 'approved') {
            throw new Error(
              `spaceTask.update cannot transition a task into 'approved' directly. ` +
                `Use spaceTask.approvePendingCompletion (UI Approve banner) or let the ` +
                `runtime's post-approval router handle the transition — both stamp the ` +
                `approval metadata and dispatch the configured post-approval step.`
            );
          }
          const parkingStoppedWorkflowTask =
            updateParams.status === 'stopped' && !!currentTask.workflowRunId;
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
          } else if (parkingStoppedWorkflowTask) {
            if (!spaceRuntimeService) {
              throw new Error(
                `Cannot stop workflow-backed task ${taskId}: SpaceRuntimeService is unavailable.`
              );
            }
            task = await spaceRuntimeService.parkStoppedWorkflowTask(spaceId, taskId);
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
            const mappedReason =
              updateParams.status === 'cancelled'
                ? (updateParams.cancelReason ?? updateParams.approvalReason ?? undefined)
                : (updateParams.approvalReason ?? undefined);

            task = await taskManager.setTaskStatus(taskId, updateParams.status, {
              result: Object.hasOwn(updateParams, 'result') ? updateParams.result : undefined,
              reportedSummary: Object.hasOwn(updateParams, 'reportedSummary')
                ? updateParams.reportedSummary
                : undefined,
              approvalSource:
                currentTask.status === 'review' && updateParams.status === 'done'
                  ? 'human'
                  : undefined,
              approvalReason: mappedReason,
            });

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
        await ensureWorkflowOverridesStillUnlocked(updateParams);
        const dependencyUpdate = await updateTaskWithRuntimeDependencyBlock(currentTask);
        task = dependencyUpdate.task;
        if (dependencyUpdate.handledByRuntime) {
          emitTaskUpdated = false;
        }
      }
    } else {
      const currentTask = await taskManager.getTask(taskId);
      if (!currentTask) {
        throw new Error(`Task not found: ${taskId}`);
      }
      await ensureWorkflowOverridesStillUnlocked(updateParams);
      const dependencyUpdate = await updateTaskWithRuntimeDependencyBlock(currentTask);
      task = dependencyUpdate.task;
      if (dependencyUpdate.handledByRuntime) {
        emitTaskUpdated = false;
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
      const refreshed = await taskManager.getTask(params.taskId);
      if (!refreshed) throw new Error(`Task not found: ${params.taskId}`);
      task = refreshed;
    } else {
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
