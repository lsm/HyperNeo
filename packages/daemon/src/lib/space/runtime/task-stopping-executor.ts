import type { SpaceTask, UpdateSpaceTaskParams } from '@hyperneo/shared';
import type { TaskStoppingExecutor } from '../../tasks/stop-task-execution.ts';
import type { SpaceRuntime } from './space-runtime.ts';

export function createWorkflowTaskStoppingExecutor(
  spaceId: string,
  runtime: Pick<SpaceRuntime, 'stopWorkflowBackedTaskForStatus'>,
  options: Omit<UpdateSpaceTaskParams, 'status'> = {}
): TaskStoppingExecutor<SpaceTask> {
  return {
    stopForStatus: (taskId, targetStatus) =>
      runtime.stopWorkflowBackedTaskForStatus(spaceId, taskId, {
        ...options,
        status: targetStatus,
      }),
  };
}
