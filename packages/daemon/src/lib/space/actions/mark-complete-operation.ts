import superpipe, { type PipelineAPI } from 'superpipe';
import type { OperationOutcome } from '../../operations/invoke.ts';
import type { OperationCaller } from '../../operations/registry.ts';
import type { SpaceGoalService } from '../goals/goal-service.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import type { MarkCompleteInput } from '../tools/task-agent-tool-schemas.ts';
import { jsonResult, type ToolResult } from '../tools/tool-result.ts';

type GoalUpdatePayload = NonNullable<MarkCompleteInput['goal_update']>;
type GoalUpdateTarget = { goalId: string; spaceId: string; update: GoalUpdatePayload } | null;

export interface MarkCompleteOperationDeps {
  taskId: string;
  mySessionId: string;
  invoke: (input: { taskId: string }, caller: OperationCaller) => Promise<OperationOutcome>;
  taskRepo?: Pick<SpaceTaskRepository, 'getTask'>;
  goalService?: Pick<SpaceGoalService, 'getGoal' | 'updateGoal'>;
}

export function requireGoalServiceForUpdate(
  params: MarkCompleteInput,
  deps: MarkCompleteOperationDeps
): { value: GoalUpdatePayload | null } | { reason: ToolResult } {
  const update = params.goal_update;
  if (!update) return { value: null };
  if (!deps.goalService)
    return {
      reason: jsonResult({
        success: false,
        error: 'Goal update is not available in this context.',
      }),
    };
  return { value: update };
}

export function requireTaskGoalLink(
  update: GoalUpdatePayload | null,
  deps: MarkCompleteOperationDeps
): { value: GoalUpdateTarget } | { reason: ToolResult } {
  if (!update) return { value: null };
  const task = deps.taskRepo?.getTask(deps.taskId);
  if (!task?.goalId)
    return {
      reason: jsonResult({
        success: false,
        error: 'Cannot apply goal_update: this task is not linked to a goal.',
      }),
    };
  return { value: { goalId: task.goalId, spaceId: task.spaceId, update } };
}

export function requireGoalExists(
  pending: GoalUpdateTarget,
  deps: MarkCompleteOperationDeps
): { value: GoalUpdateTarget } | { reason: ToolResult } {
  if (!pending) return { value: null };
  const goal = deps.goalService?.getGoal(pending.goalId);
  if (!goal || goal.spaceId !== pending.spaceId)
    return { reason: jsonResult({ success: false, error: `Goal not found: ${pending.goalId}` }) };
  return { value: { goalId: goal.id, spaceId: goal.spaceId, update: pending.update } };
}

export async function invokeCompleteTaskOperation(
  deps: MarkCompleteOperationDeps
): Promise<OperationOutcome> {
  return deps.invoke({ taskId: deps.taskId }, { source: 'mcp', sessionId: deps.mySessionId });
}

export async function applyGoalUpdateEffect(
  outcome: OperationOutcome,
  target: GoalUpdateTarget,
  deps: MarkCompleteOperationDeps
): Promise<string | null> {
  const accepted =
    outcome.kind === 'completed' && (outcome.value as { accepted?: boolean })?.accepted === true;
  if (!target || !accepted) return null;
  try {
    await deps.goalService?.updateGoal(
      target.goalId,
      {
        summary: target.update.summary,
        progress: target.update.progress,
        metrics: target.update.metrics,
        nextSteps: target.update.nextSteps,
      },
      { source: 'workflow_node_agent', sourceTaskId: deps.taskId }
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function formatMarkCompleteResult(
  outcome: OperationOutcome,
  goalUpdateError: string | null
): ToolResult {
  if (outcome.kind !== 'completed')
    return { ...jsonResult({ code: outcome.code, message: outcome.message }), isError: true };
  return jsonResult(
    goalUpdateError
      ? { ...(outcome.value as Record<string, unknown>), goalUpdateError }
      : outcome.value
  );
}

export const runMarkCompleteOperation = (superpipe({})('mark-complete-operation') as PipelineAPI)
  .input(['params', 'deps'])
  .pipe(requireGoalServiceForUpdate, ['params', 'deps'], 'result:outcome')
  .pipe(requireTaskGoalLink, ['outcome', 'deps'], 'result:outcome')
  .pipe(requireGoalExists, ['outcome', 'deps'], 'result:outcome')
  .pipe(invokeCompleteTaskOperation, ['deps'], 'operationOutcome')
  .pipe(applyGoalUpdateEffect, ['operationOutcome', 'outcome', 'deps'], 'goalUpdateError')
  .pipe(formatMarkCompleteResult, ['operationOutcome', 'goalUpdateError'], 'outcome')
  .endAsync('outcome') as (
  params: MarkCompleteInput,
  deps: MarkCompleteOperationDeps
) => Promise<ToolResult>;
