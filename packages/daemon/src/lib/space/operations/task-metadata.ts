import type { Session, SpaceTask } from '@hyperneo/shared';
import type { Database } from '../../../storage/sqlite-compat.ts';
import { editStandaloneTask } from '../../../storage/tasks/edit-task.ts';
import type { OperationCaller } from '../../operations/registry.ts';
import {
  createTaskMetadataEditor,
  type TaskMetadataOwner,
} from '../../operations/task-metadata.ts';
import { Logger } from '../../logger.ts';
import type { SpaceTaskManager } from '../managers/space-task-manager.ts';
import {
  resolveSpaceMcpSessionPolicy,
  type SpaceMcpSessionPolicyContext,
} from '../runtime/space-mcp-session-policy.ts';

const log = new Logger('SpaceTaskMetadata');

export interface SpaceTaskMetadataDependencies extends SpaceMcpSessionPolicyContext {
  db: Database;
  getSession: (sessionId: string) => Session | null;
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'updateTask'>;
  notifyStandalone: () => void;
  emitTaskUpdated: (spaceId: string, task: SpaceTask) => Promise<void>;
}

export function requireMetadataCallerScope(
  owner: TaskMetadataOwner,
  caller: OperationCaller,
  callerSpaceId: string | undefined
): { value: true } | { reason: string } {
  return owner.kind === 'standalone' ||
    caller.source === 'rpc' ||
    caller.source === 'internal' ||
    owner.spaceId === callerSpaceId
    ? { value: true }
    : { reason: 'Task metadata updates require a session in the owning Space' };
}

export function resolveMetadataSessionSpace(
  session: Session | null,
  context: SpaceMcpSessionPolicyContext
): string | undefined {
  if (!session) return undefined;
  return (
    resolveSpaceMcpSessionPolicy(session, context).spaceId ??
    (session.type === 'space_chat' ? session.id.match(/^space:chat:(.+)$/)?.[1] : undefined)
  );
}

export function createSpaceTaskMetadataEditor(dependencies: SpaceTaskMetadataDependencies) {
  const { db, getSession, getTaskManager, notifyStandalone, emitTaskUpdated } = dependencies;
  return createTaskMetadataEditor({
    resolveOwner: (taskId) => {
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
      if ('reason' in scope) throw new Error(scope.reason);
    },
    editStandalone: (input) => editStandaloneTask(db, input, notifyStandalone),
    editSpace: (spaceId, { taskId, ...metadata }) =>
      getTaskManager(spaceId).updateTask(taskId, metadata),
    afterEdit: async (owner, task) => {
      if (owner.kind === 'space') {
        await emitTaskUpdated(owner.spaceId, task as SpaceTask).catch((error: unknown) => {
          log.warn('Failed to emit space.task.updated:', error);
        });
      }
    },
  });
}
