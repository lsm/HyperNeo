import type { TaskCore } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';

export interface TaskRecoveryExecutor<TTask extends TaskCore = TaskCore> {
  recover(taskId: string, targetStatus: 'open' | 'in_progress'): Promise<TTask>;
}

type RecoveryRejection = 'execution_unavailable' | 'invalid_recovery_status';

export function requireRecoveryExecutor(executor: TaskRecoveryExecutor | undefined) {
  return executor ? { value: executor } : { reason: 'execution_unavailable' as const };
}

export function requireRecoveryTarget(targetStatus: string) {
  return targetStatus === 'open' || targetStatus === 'in_progress'
    ? { value: targetStatus }
    : { reason: 'invalid_recovery_status' as const };
}

export const recoverTaskExecution = (superpipe({})('recover-task-execution') as PipelineAPI)
  .input(['executor', 'taskId', 'targetStatus'])
  .pipe(requireRecoveryExecutor, 'executor', 'result:task')
  .pipe(requireRecoveryTarget, 'targetStatus', 'result:task')
  .pipe(
    (executor: TaskRecoveryExecutor, taskId: string, targetStatus: 'open' | 'in_progress') =>
      executor.recover(taskId, targetStatus),
    ['executor', 'taskId', 'targetStatus'],
    'task'
  )
  .endAsync('task') as <TTask extends TaskCore>(
  executor: TaskRecoveryExecutor<TTask> | undefined,
  taskId: string,
  targetStatus: string
) => Promise<TTask | RecoveryRejection>;
