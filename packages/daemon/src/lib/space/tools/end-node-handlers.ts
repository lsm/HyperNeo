import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus';
import { Logger } from '../../logger';
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceTaskManager } from '../managers/space-task-manager';
import type { SpaceGoalService } from '../goals/goal-service';
import type {
  ApproveTaskInput,
  MarkCompleteInput,
  SubmitForApprovalInput,
} from './task-agent-tool-schemas';
import type { ToolResult } from './tool-result';
import { jsonResult } from './tool-result';
import { normalizeMeaningfulTaskResult } from '../task-result-utils';

const log = new Logger('end-node-handlers');

export interface EndNodeHandlerDeps {
  taskId: string;
  spaceId: string;
  workflow: SpaceWorkflow | null;
  workflowNodeId: string;
  agentName: string;
  taskRepo: SpaceTaskRepository;
  taskManager: Pick<SpaceTaskManager, 'submitTaskForReview'>;
  spaceManager: Pick<SpaceManager, 'getSpace'>;
  internalEventBus?: Pick<InternalEventBus<DaemonInternalEventMap>, 'publish'>;
}

export interface EndNodeHandlers {
  onApproveTask: (args: ApproveTaskInput) => Promise<ToolResult>;
  onSubmitForApproval: (args: SubmitForApprovalInput) => Promise<ToolResult>;
}

export interface MarkCompleteHandlerDeps {
  taskId: string;
  spaceId: string;
  taskRepo: Pick<SpaceTaskRepository, 'getTask'>;
  resolveResultArtifactSummary?: (task: SpaceTask) => string | null;
  callerSessionId?: string;
  requiresPostApprovalOwner?: boolean;
  taskManager: Pick<SpaceTaskManager, 'setTaskStatus' | 'updateTask'>;
  internalEventBus?: Pick<InternalEventBus<DaemonInternalEventMap>, 'publish'>;
  goalService?: Pick<SpaceGoalService, 'getGoal' | 'updateGoal' | 'handleTaskTerminal'>;
  assertPrMerged?: (task: SpaceTask) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface PrMergedGateDeps {
  resolvePrUrl: (task: SpaceTask) => string;
  requirePrUrl?: boolean;
  getPrState: (prUrl: string) => Promise<string>;
}

export function createPrMergedGate(
  deps: PrMergedGateDeps
): (task: SpaceTask) => Promise<{ ok: true } | { ok: false; error: string }> {
  const { resolvePrUrl, requirePrUrl = false, getPrState } = deps;
  return async (task) => {
    const prUrl = resolvePrUrl(task);
    if (!prUrl) {
      return requirePrUrl
        ? {
            ok: false,
            error:
              "mark_complete merge gate: could not resolve the run's PR URL. " +
              'The task stays approved until a PR link is available and its merge is confirmed.',
          }
        : { ok: true };
    }

    let state: string;
    try {
      state = await getPrState(prUrl);
    } catch (err) {
      return {
        ok: false,
        error:
          `mark_complete merge gate: could not verify the run's PR state for ${prUrl} ` +
          `(${err instanceof Error ? err.message : String(err)}). The task stays approved until the PR is confirmed merged.`,
      };
    }

    if (state === 'MERGED') return { ok: true };
    if (state === 'OPEN') {
      return {
        ok: false,
        error:
          `mark_complete merge gate: the run's PR is still OPEN (${prUrl}). ` +
          `Merge it before calling mark_complete (gh pr merge), then retry.`,
      };
    }
    return {
      ok: false,
      error:
        `mark_complete merge gate: the run's PR is ${state} (${prUrl}), not merged. ` +
        `The task stays approved; resolve the PR before calling mark_complete.`,
    };
  };
}

export function createMarkCompleteHandler(
  deps: MarkCompleteHandlerDeps
): (args: MarkCompleteInput) => Promise<ToolResult> {
  const {
    taskId,
    spaceId,
    taskRepo,
    taskManager,
    internalEventBus,
    goalService,
    resolveResultArtifactSummary,
    callerSessionId,
    requiresPostApprovalOwner = false,
    assertPrMerged,
  } = deps;

  const handleGoalTerminal = (task: SpaceTask, fromStatus: SpaceTask['status']): void => {
    if (!goalService) return;
    try {
      goalService.handleTaskTerminal(task.id, { fromStatus });
    } catch (err) {
      log.warn(
        `Goal terminal handling threw for task "${task.id}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const emitTaskUpdated = (task: SpaceTask): void => {
    if (!internalEventBus) return;
    void internalEventBus
      .publish('space.task.updated', { sessionId: 'global', spaceId, taskId: task.id, task })
      .catch((err: unknown) => {
        log.warn(
          `Failed to emit space.task.updated for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  };

  return async (args: MarkCompleteInput): Promise<ToolResult> => {
    const task = taskRepo.getTask(taskId);
    if (!task) return jsonResult({ success: false, error: `Task not found: ${taskId}` });

    if (task.status !== 'approved') {
      return jsonResult({
        success: false,
        error:
          `task is not in \`approved\` status (current: \`${task.status}\`); did you mean \`approve_task\`? ` +
          `mark_complete only transitions an already-approved task from 'approved' to 'done'.`,
      });
    }

    if (requiresPostApprovalOwner && !task.postApprovalSessionId) {
      return jsonResult({
        success: false,
        error:
          'mark_complete is blocked until the routed post-approval session is recorded on the task.',
      });
    }
    if (
      task.postApprovalSessionId &&
      (!callerSessionId || task.postApprovalSessionId !== callerSessionId)
    ) {
      return jsonResult({
        success: false,
        error: `mark_complete is restricted to the routed post-approval session ${task.postApprovalSessionId}.`,
      });
    }

    if (assertPrMerged) {
      const gate = await assertPrMerged(task);
      if (!gate.ok) {
        return jsonResult({ success: false, error: gate.error });
      }
    }

    let goalUpdate: {
      goalId: string;
      updates: NonNullable<MarkCompleteInput['goal_update']>;
    } | null = null;
    if (args.goal_update) {
      if (!goalService) {
        return jsonResult({
          success: false,
          error: 'Goal update is not available in this context.',
        });
      }
      if (!task.goalId) {
        return jsonResult({
          success: false,
          error: 'Cannot apply goal_update: this task is not linked to a goal.',
        });
      }
      const goal = goalService.getGoal(task.goalId);
      if (!goal || goal.spaceId !== task.spaceId) {
        return jsonResult({ success: false, error: `Goal not found: ${task.goalId}` });
      }
      goalUpdate = { goalId: goal.id, updates: args.goal_update };
    }

    try {
      const artifactSummary = normalizeMeaningfulTaskResult(resolveResultArtifactSummary?.(task));
      const reportedSummary = normalizeMeaningfulTaskResult(task.reportedSummary);
      const existingResult = normalizeMeaningfulTaskResult(task.result);
      const result = artifactSummary ?? existingResult ?? reportedSummary ?? 'Task completed.';
      const updated = await taskManager.setTaskStatus(taskId, 'done', {
        approvalSource: task.approvalSource ?? 'agent',
        result,
        reportedSummary: artifactSummary ?? reportedSummary ?? undefined,
        onCascadedTasks: async (cascadedTasks) => {
          for (const cascadedTask of cascadedTasks) emitTaskUpdated(cascadedTask);
        },
      });
      if (goalUpdate) {
        goalService?.updateGoal(
          goalUpdate.goalId,
          {
            summary: goalUpdate.updates.summary,
            progress: goalUpdate.updates.progress,
            metrics: goalUpdate.updates.metrics,
            nextSteps: goalUpdate.updates.nextSteps,
          },
          { source: 'workflow_node_agent', sourceTaskId: taskId }
        );
      }
      handleGoalTerminal(updated, task.status);
      emitTaskUpdated(updated);
      log.info(
        `post-approval.complete: spaceId=${spaceId} taskId=${taskId} outcome=done mode=${task.postApprovalSessionId ? 'spawn' : 'inline'}`
      );
      return jsonResult({
        success: true,
        taskId,
        message: 'Post-approval work finished. Task transitioned to done.',
      });
    } catch (err) {
      return jsonResult({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export function createEndNodeHandlers(deps: EndNodeHandlerDeps): EndNodeHandlers {
  const {
    taskId,
    spaceId,
    workflow,
    workflowNodeId,
    taskRepo,
    taskManager,
    spaceManager,
    internalEventBus,
  } = deps;

  const emitTaskUpdated = (task: SpaceTask): void => {
    if (!internalEventBus) return;
    void internalEventBus
      .publish('space.task.updated', { sessionId: 'global', spaceId, taskId: task.id, task })
      .catch((err: unknown) => {
        log.warn(
          `Failed to emit space.task.updated for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  };

  return {
    onApproveTask: async (_args: ApproveTaskInput) => {
      const space = await spaceManager.getSpace(spaceId);
      const currentLevel = space?.autonomyLevel ?? 1;
      const required = workflow?.completionAutonomyLevel ?? 5;
      if (currentLevel < required) {
        return jsonResult({
          success: false,
          error: `approve_task not permitted: space autonomy level ${currentLevel} < workflow completionAutonomyLevel ${required}. If work is approved/QA-passed and all findings are resolved, use submit_for_approval as the terminal human sign-off path. Do not use either terminal tool while findings, QA failures, or dispatch work remain open.`,
        });
      }

      const task = taskRepo.getTask(taskId);
      if (!task) return jsonResult({ success: false, error: `Task not found: ${taskId}` });

      try {
        const updated = taskRepo.updateTask(taskId, {
          reportedStatus: 'done',
          pendingCheckpointType: null,
          pendingCompletionSubmittedByNodeId: workflowNodeId,
          pendingCompletionSubmittedAt: null,
          pendingCompletionReason: null,
          postApprovalSourceNodeId: workflowNodeId,
        });
        if (updated) emitTaskUpdated(updated);
        return jsonResult({
          success: true,
          taskId,
          message:
            'Task approved for completion. The completion-action pipeline will now resolve terminal status.',
        });
      } catch (err) {
        return jsonResult({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    onSubmitForApproval: async (args: SubmitForApprovalInput) => {
      const task = taskRepo.getTask(taskId);
      if (!task) return jsonResult({ success: false, error: `Task not found: ${taskId}` });

      try {
        const updated = await taskManager.submitTaskForReview(taskId, {
          submittedByNodeId: workflowNodeId,
          reason: args.reason ?? null,
        });
        emitTaskUpdated(updated);
        return jsonResult({
          success: true,
          taskId,
          message: `Task submitted for human review${args.reason ? ` (reason: ${args.reason})` : ''}. A human must approve or reject via the UI before the workflow continues.`,
        });
      } catch (err) {
        return jsonResult({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
