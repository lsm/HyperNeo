import type { Session, SpaceTask, UpdateSpaceTaskParams } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../storage/sqlite-compat.ts';
import {
  setStandaloneTaskDependencies,
  type SetTaskDependenciesInput,
} from '../../../storage/tasks/set-task-dependencies.ts';
import {
  createTaskDependencyEditor,
  type TaskDependencyOwner,
} from '../../operations/task-dependency-editor.ts';
import { Logger } from '../../logger.ts';
import type { SpaceTaskManager } from '../managers/space-task-manager.ts';
import type { SpaceMcpSessionPolicyContext } from '../runtime/space-mcp-session-policy.ts';
import { requireDependencyExecutionBlock } from '../tools/update-task-fields.ts';
import { requireMetadataCallerScope, resolveMetadataSessionSpace } from './task-metadata.ts';

const log = new Logger('SpaceTaskDependencies');
type DependencyState = { previous: SpaceTask | null; task: SpaceTask };

export interface BoundSpaceTaskDependencyDependencies {
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'getTask' | 'updateTask'>;
  emitTaskUpdated: (spaceId: string, task: SpaceTask) => void | Promise<void>;
  blockExecution?: SpaceTaskDependencyDependencies['blockExecution'];
}

export interface SpaceTaskDependencyDependencies extends SpaceMcpSessionPolicyContext {
  db: Database;
  getSession: (sessionId: string) => Session | null;
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'getTask' | 'updateTask'>;
  notifyStandalone: () => void;
  emitTaskUpdated: (spaceId: string, task: SpaceTask) => Promise<void>;
  blockExecution: (
    spaceId: string,
    taskId: string,
    params: UpdateSpaceTaskParams
  ) => Promise<SpaceTask | null>;
}

export async function persistSpaceDependencies(
  getTaskManager: BoundSpaceTaskDependencyDependencies['getTaskManager'],
  emitTaskUpdated: BoundSpaceTaskDependencyDependencies['emitTaskUpdated'],
  spaceId: string,
  input: SetTaskDependenciesInput
): Promise<DependencyState> {
  const manager = getTaskManager(spaceId);
  const previous = await manager.getTask(input.taskId);
  await manager.updateTask(
    input.taskId,
    { dependsOn: input.dependsOn },
    {
      onCascadedTasks: async (tasks) => {
        for (const task of tasks) await publishSpaceDependencyTask(emitTaskUpdated, spaceId, task);
      },
    }
  );
  const task = await manager.getTask(input.taskId);
  if (!task) throw new Error(`Task not found: ${input.taskId}`);
  return { previous, task };
}

export async function publishSpaceDependencyTask(
  emit: BoundSpaceTaskDependencyDependencies['emitTaskUpdated'],
  spaceId: string,
  task: SpaceTask
): Promise<SpaceTask> {
  try {
    await emit(spaceId, task);
  } catch (error) {
    log.warn('Failed to emit space.task.updated:', error);
  }
  return task;
}

export function selectSpaceDependencyCompletion(
  state: DependencyState,
  blockExecution: BoundSpaceTaskDependencyDependencies['blockExecution'],
  emit: BoundSpaceTaskDependencyDependencies['emitTaskUpdated']
): (spaceId: string, task: SpaceTask) => Promise<SpaceTask> {
  const blocked = requireDependencyExecutionBlock(state.previous, state.task);
  return blockExecution && 'value' in blocked
    ? async (spaceId, task) => {
        const updated = await blockExecution(spaceId, task.id, {
          status: 'blocked',
          blockReason: 'dependency_added',
          result: 'Dependency added while task was in progress',
          completedAt: null,
        });
        if (!updated) throw new Error(`Failed to block workflow-backed task ${task.id}`);
        return updated;
      }
    : (spaceId, task) => publishSpaceDependencyTask(emit, spaceId, task);
}

export function createSpaceDependencyReplacer(dependencies: BoundSpaceTaskDependencyDependencies) {
  return (superpipe({ ...dependencies })('replace-space-task-dependencies') as PipelineAPI)
    .input(['spaceId', 'input'])
    .pipe(
      persistSpaceDependencies,
      ['getTaskManager', 'emitTaskUpdated', 'spaceId', 'input'],
      'state'
    )
    .pipe(
      selectSpaceDependencyCompletion,
      ['state', 'blockExecution', 'emitTaskUpdated'],
      'complete'
    )
    .pipe(
      (
        complete: ReturnType<typeof selectSpaceDependencyCompletion>,
        spaceId: string,
        state: DependencyState
      ) => complete(spaceId, state.task),
      ['complete', 'spaceId', 'state'],
      'task'
    )
    .endAsync('task') as (spaceId: string, input: SetTaskDependenciesInput) => Promise<SpaceTask>;
}

export function isTaskDependenciesOnlyUpdate(params: UpdateSpaceTaskParams): boolean {
  return params.dependsOn !== undefined && Object.keys(params).every((key) => key === 'dependsOn');
}

export function createBoundSpaceTaskDependencyEditor(
  spaceId: string,
  dependencies: BoundSpaceTaskDependencyDependencies
) {
  const replace = createSpaceDependencyReplacer(dependencies);
  return (input: SetTaskDependenciesInput) => replace(spaceId, input);
}

export function createSpaceTaskDependencyEditor(dependencies: SpaceTaskDependencyDependencies) {
  const { db, getSession, notifyStandalone } = dependencies;
  return createTaskDependencyEditor({
    resolveOwner: (taskId): TaskDependencyOwner | null => {
      const row = db.prepare('SELECT space_id FROM space_tasks WHERE id = ?').get(taskId) as {
        space_id: string | null;
      } | null;
      return !row
        ? null
        : row.space_id === null
          ? { kind: 'standalone' }
          : { kind: 'space', spaceId: row.space_id };
    },
    admit: (owner, caller) => {
      const session =
        owner.kind === 'space' && caller.source === 'mcp' && caller.sessionId
          ? getSession(caller.sessionId)
          : null;
      const scope = requireMetadataCallerScope(
        owner,
        caller,
        resolveMetadataSessionSpace(session, dependencies)
      );
      if ('reason' in scope)
        throw new Error('Task dependency updates require a session in the owning Space');
    },
    replaceStandalone: (input) => setStandaloneTaskDependencies(db, input, notifyStandalone),
    replaceSpace: createSpaceDependencyReplacer(dependencies),
  });
}
