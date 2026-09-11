import type { TaskCore } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';

export interface TaskParkingExecutor<TTask extends TaskCore = TaskCore> {
  park(taskId: string): Promise<TTask | null>;
}

export function requireParkingExecutor(executor: TaskParkingExecutor | undefined) {
  return executor ? { value: executor } : { reason: 'execution_unavailable' as const };
}

export const parkTaskExecution = (superpipe({})('park-task-execution') as PipelineAPI)
  .input(['executor', 'taskId'])
  .pipe(requireParkingExecutor, 'executor', 'result:task')
  .pipe(
    (executor: TaskParkingExecutor, taskId: string) => executor.park(taskId),
    ['executor', 'taskId'],
    'task'
  )
  .endAsync('task') as <TTask extends TaskCore>(
  executor: TaskParkingExecutor<TTask> | undefined,
  taskId: string
) => Promise<TTask | null | 'execution_unavailable'>;
