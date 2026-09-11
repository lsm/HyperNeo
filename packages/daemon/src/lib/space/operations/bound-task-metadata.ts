import type { SpaceTask, UpdateSpaceTaskParams } from '@hyperneo/shared';
import type { OperationCaller } from '../../operations/registry.ts';
import {
  createTaskMetadataEditor,
  type TaskMetadataInput,
} from '../../operations/task-metadata.ts';
import type { SpaceTaskManager } from '../managers/space-task-manager.ts';

export function isTaskMetadataOnlyUpdate(params: UpdateSpaceTaskParams): boolean {
  const keys = Object.keys(params);
  return (
    keys.length > 0 &&
    keys.every(
      (key) => key === 'title' || key === 'description' || key === 'priority' || key === 'labels'
    )
  );
}

export function createBoundSpaceTaskMetadataEditor(
  spaceId: string,
  taskManager: Pick<SpaceTaskManager, 'updateTask'>,
  options?: Parameters<SpaceTaskManager['updateTask']>[2]
) {
  return createTaskMetadataEditor({
    resolveOwner: () => ({ kind: 'space', spaceId }),
    admit: () => {},
    editStandalone: () => null,
    editSpace: (_spaceId, { taskId, ...metadata }) =>
      taskManager.updateTask(taskId, metadata, options),
  }) as (input: TaskMetadataInput, caller: OperationCaller) => Promise<SpaceTask>;
}
