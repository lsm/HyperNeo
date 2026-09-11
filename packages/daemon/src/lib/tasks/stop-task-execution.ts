import type { TaskCore } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';

export type TaskStopTarget = 'open' | 'cancelled' | 'blocked';

export interface TaskStoppingExecutor<TTask extends TaskCore = TaskCore> {
  stopForStatus(taskId: string, targetStatus: TaskStopTarget): Promise<TTask | null>;
}

export function requireStoppingExecutor(executor: TaskStoppingExecutor | undefined) {
  return executor ? { value: executor } : { reason: 'execution_unavailable' as const };
}

export function requireStopTarget(targetStatus: string) {
  return targetStatus === 'open' || targetStatus === 'cancelled' || targetStatus === 'blocked'
    ? { value: targetStatus }
    : { reason: 'invalid_stop_status' as const };
}

export async function executeTaskStopping<TTask extends TaskCore>(
  executor: TaskStoppingExecutor<TTask>,
  taskId: string,
  targetStatus: TaskStopTarget
): Promise<{ value: TTask } | { reason: null }> {
  const task = await executor.stopForStatus(taskId, targetStatus);
  return task === null ? { reason: null } : { value: task };
}

export const stopTaskExecution = (superpipe({})('stop-task-execution') as PipelineAPI)
  .input(['executor', 'taskId', 'targetStatus'])
  .pipe(requireStoppingExecutor, 'executor', 'result:task')
  .pipe(requireStopTarget, 'targetStatus', 'result:task')
  .pipe(executeTaskStopping, ['executor', 'taskId', 'targetStatus'], 'result:task')
  .endAsync('task') as <TTask extends TaskCore>(
  executor: TaskStoppingExecutor<TTask> | undefined,
  taskId: string,
  targetStatus: string
) => Promise<TTask | null | 'execution_unavailable' | 'invalid_stop_status'>;
