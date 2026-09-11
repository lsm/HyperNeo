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
import { updateTaskFields } from '../tools/update-task-fields.ts';
import { requireMetadataCallerScope, resolveMetadataSessionSpace } from './task-metadata.ts';

const log = new Logger('SpaceTaskDependencies');
type FieldUpdate = Awaited<ReturnType<typeof updateTaskFields>>;

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

export function dependencyUpdateEmittedByRuntime(updated: FieldUpdate): boolean {
  return updated.handledByRuntime;
}

async function persistSpaceDependencies(
  getTaskManager: SpaceTaskDependencyDependencies['getTaskManager'],
  emitTaskUpdated: SpaceTaskDependencyDependencies['emitTaskUpdated'],
  blockExecution: SpaceTaskDependencyDependencies['blockExecution'],
  spaceId: string,
  input: SetTaskDependenciesInput
) {
  const manager = getTaskManager(spaceId);
  return updateTaskFields(
    await manager.getTask(input.taskId),
    () =>
      manager.updateTask(
        input.taskId,
        { dependsOn: input.dependsOn },
        {
          onCascadedTasks: async (tasks) => {
            for (const task of tasks) await emitTaskUpdated(spaceId, task);
          },
        }
      ),
    (taskId) =>
      blockExecution(spaceId, taskId, {
        dependsOn: input.dependsOn,
        status: 'blocked',
        blockReason: 'dependency_added',
        result: 'Dependency added while task was in progress',
        completedAt: null,
      })
  );
}

function createSpaceDependencyReplacer(dependencies: SpaceTaskDependencyDependencies) {
  return (
    superpipe({ ...dependencies, dependencyUpdateEmittedByRuntime })(
      'replace-space-task-dependencies'
    ) as PipelineAPI
  )
    .input(['spaceId', 'input'])
    .pipe(
      persistSpaceDependencies,
      ['getTaskManager', 'emitTaskUpdated', 'blockExecution', 'spaceId', 'input'],
      'updated'
    )
    .pipe((updated: FieldUpdate) => updated.task, 'updated', 'task')
    .pipe('!dependencyUpdateEmittedByRuntime', 'updated')
    .pipe(
      async (
        emit: SpaceTaskDependencyDependencies['emitTaskUpdated'],
        spaceId: string,
        task: SpaceTask
      ) => {
        await emit(spaceId, task).catch((error: unknown) =>
          log.warn('Failed to emit space.task.updated:', error)
        );
      },
      ['emitTaskUpdated', 'spaceId', 'task']
    )
    .endAsync('task') as (spaceId: string, input: SetTaskDependenciesInput) => Promise<SpaceTask>;
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
