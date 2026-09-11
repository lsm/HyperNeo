import type { TaskCore } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';

export interface TaskParkingExecutor<TTask extends TaskCore = TaskCore> {
  park(taskId: string): Promise<TTask | null>;
}

export function requireParkingExecutor(executor: TaskParkingExecutor | undefined) {
  return executor ? { value: executor } : { reason: 'execution_unavailable' as const };
}

export async function executeTaskParking<TTask extends TaskCore>(
  executor: TaskParkingExecutor<TTask>,
  taskId: string
): Promise<{ value: TTask } | { reason: null }> {
  const task = await executor.park(taskId);
  return task === null ? { reason: null } : { value: task };
}

export const parkTaskExecution = (superpipe({})('park-task-execution') as PipelineAPI)
  .input(['executor', 'taskId'])
  .pipe(requireParkingExecutor, 'executor', 'result:task')
  .pipe(executeTaskParking, ['executor', 'taskId'], 'result:task')
  .endAsync('task') as <TTask extends TaskCore>(
  executor: TaskParkingExecutor<TTask> | undefined,
  taskId: string
) => Promise<TTask | null | 'execution_unavailable'>;
