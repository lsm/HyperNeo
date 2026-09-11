import type { SpaceTask } from '@hyperneo/shared';
import type { TaskParkingExecutor } from '../../tasks/park-task-execution.ts';
import type { SpaceRuntime } from './space-runtime.ts';

export function createWorkflowTaskParkingExecutor(
  spaceId: string,
  runtime: Pick<SpaceRuntime, 'parkStoppedWorkflowTask'>
): TaskParkingExecutor<SpaceTask> {
  return {
    park: (taskId) => runtime.parkStoppedWorkflowTask(spaceId, taskId),
  };
}
