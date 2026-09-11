import type { SpaceTask } from '@hyperneo/shared';
import type { TaskRecoveryExecutor } from '../../tasks/recover-task-execution.ts';
import type { SpaceRuntime } from './space-runtime.ts';
import type { SpaceRuntimeService } from './space-runtime-service.ts';

export function createWorkflowTaskRecoveryExecutor(
  spaceId: string,
  runtime:
    | Pick<SpaceRuntimeService, 'recoverWorkflowBackedTask'>
    | Pick<SpaceRuntime, 'recoverWorkflowBackedTask'>,
  options?: Parameters<SpaceRuntimeService['recoverWorkflowBackedTask']>[3]
): TaskRecoveryExecutor<SpaceTask> {
  return {
    recover: async (taskId, targetStatus) => {
      const recovered = await runtime.recoverWorkflowBackedTask(
        spaceId,
        taskId,
        targetStatus,
        ...(options === undefined ? [] : [options])
      );
      return 'task' in recovered ? recovered.task : recovered;
    },
  };
}
