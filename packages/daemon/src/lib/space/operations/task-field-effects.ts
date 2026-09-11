import type { SpaceTask, UpdateSpaceTaskParams } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { Logger } from '../../logger.ts';
import { arraysEqual } from '../../utils/array-utils.ts';
import type { SpaceTaskManager } from '../managers/space-task-manager.ts';
import { requireDependencyExecutionBlock } from '../tools/update-task-fields.ts';

const log = new Logger('SpaceTaskFields');
export interface SpaceTaskFieldEffects {
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'getTask' | 'updateTask'>;
  emitTaskUpdated: (spaceId: string, task: SpaceTask) => void | Promise<void>;
  blockExecution?: (
    spaceId: string,
    taskId: string,
    fields: UpdateSpaceTaskParams
  ) => Promise<SpaceTask | null>;
}
export interface SpaceTaskFieldState {
  previous: SpaceTask | null;
  task: SpaceTask;
  deferred: UpdateSpaceTaskParams;
}
export interface SpaceTaskFieldResult {
  task: SpaceTask;
  handledByRuntime: boolean;
}

export function selectSpaceTaskFieldWrite(
  previous: SpaceTask | null,
  fields: UpdateSpaceTaskParams,
  hasExecutor: boolean
) {
  if (
    !hasExecutor ||
    previous?.status !== 'in_progress' ||
    !previous.workflowRunId ||
    fields.dependsOn === undefined ||
    arraysEqual(previous.dependsOn ?? [], fields.dependsOn)
  ) {
    return { fields, deferred: {} as UpdateSpaceTaskParams };
  }
  const { taskAgentSessionId: _session, workflowRunId: _run, ...safe } = fields;
  const deferred: UpdateSpaceTaskParams = {};
  if ('taskAgentSessionId' in fields) deferred.taskAgentSessionId = fields.taskAgentSessionId;
  if ('workflowRunId' in fields) deferred.workflowRunId = fields.workflowRunId;
  return { fields: safe, deferred };
}

export async function publishSpaceTaskFieldUpdate(
  emit: SpaceTaskFieldEffects['emitTaskUpdated'],
  spaceId: string,
  task: SpaceTask
) {
  try {
    await emit(spaceId, task);
  } catch (error) {
    log.warn('Failed to emit space.task.updated:', error);
  }
  return task;
}

export async function persistSpaceTaskFields(
  getTaskManager: SpaceTaskFieldEffects['getTaskManager'],
  emit: SpaceTaskFieldEffects['emitTaskUpdated'],
  blockExecution: SpaceTaskFieldEffects['blockExecution'],
  spaceId: string,
  taskId: string,
  fields: UpdateSpaceTaskParams
): Promise<SpaceTaskFieldState> {
  const manager = getTaskManager(spaceId);
  let previous: SpaceTask | null = null;
  let deferred: UpdateSpaceTaskParams = {};
  await manager.updateTask(taskId, fields, {
    prepareExecutionPointers: (current) => {
      previous = { ...current };
      const write = selectSpaceTaskFieldWrite(previous, fields, !!blockExecution);
      deferred = write.deferred;
      const prepared: UpdateSpaceTaskParams = write.fields;
      return {
        workflowRunId: prepared.workflowRunId,
        taskAgentSessionId: prepared.taskAgentSessionId,
      };
    },
    onCascadedTasks: async (tasks) => {
      for (const task of tasks) await publishSpaceTaskFieldUpdate(emit, spaceId, task);
    },
  });
  const task = await manager.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return { previous, task, deferred };
}

export async function blockSpaceTaskForDependency(
  blockExecution: NonNullable<SpaceTaskFieldEffects['blockExecution']>,
  spaceId: string,
  task: SpaceTask
) {
  const updated = await blockExecution(spaceId, task.id, {
    status: 'blocked',
    blockReason: 'dependency_added',
    result: 'Dependency added while task was in progress',
    completedAt: null,
  });
  if (!updated) throw new Error(`Failed to block workflow-backed task ${task.id}`);
  return updated;
}

export function selectSpaceTaskFieldCompletion(
  state: SpaceTaskFieldState,
  blockExecution: SpaceTaskFieldEffects['blockExecution'],
  getTaskManager: SpaceTaskFieldEffects['getTaskManager']
) {
  const block = requireDependencyExecutionBlock(state.previous, state.task);
  return blockExecution && 'value' in block
    ? async (spaceId: string): Promise<SpaceTaskFieldResult> => ({
        task: await blockSpaceTaskForDependency(blockExecution, spaceId, state.task),
        handledByRuntime: true,
      })
    : async (spaceId: string): Promise<SpaceTaskFieldResult> => ({
        task:
          Object.keys(state.deferred).length > 0
            ? await getTaskManager(spaceId).updateTask(state.task.id, state.deferred)
            : state.task,
        handledByRuntime: false,
      });
}

export function createSpaceTaskFieldUpdater(dependencies: SpaceTaskFieldEffects) {
  return (superpipe({ ...dependencies })('update-space-task-fields') as PipelineAPI)
    .input(['spaceId', 'taskId', 'fields'])
    .pipe(
      persistSpaceTaskFields,
      ['getTaskManager', 'emitTaskUpdated', 'blockExecution', 'spaceId', 'taskId', 'fields'],
      'state'
    )
    .pipe(selectSpaceTaskFieldCompletion, ['state', 'blockExecution', 'getTaskManager'], 'complete')
    .pipe(
      (complete: ReturnType<typeof selectSpaceTaskFieldCompletion>, spaceId: string) =>
        complete(spaceId),
      ['complete', 'spaceId'],
      'outcome'
    )
    .endAsync('outcome') as (
    spaceId: string,
    taskId: string,
    fields: UpdateSpaceTaskParams
  ) => Promise<SpaceTaskFieldResult>;
}
