import type { SpaceTask } from '@hyperneo/shared';
import type { TaskRecoveryExecutor } from '../../tasks/recover-task-execution.ts';
import type { SpaceRuntimeService } from './space-runtime-service.ts';

export function createWorkflowTaskRecoveryExecutor(
  spaceId: string,
  runtime: Pick<SpaceRuntimeService, 'recoverWorkflowBackedTask'>
): TaskRecoveryExecutor<SpaceTask> {
  return {
    recover: (taskId, targetStatus) =>
      runtime.recoverWorkflowBackedTask(spaceId, taskId, targetStatus),
  };
}
