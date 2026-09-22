import type { Session, SpaceTask } from '@hyperneo/shared';
import type { Database } from '../../storage/sqlite-compat.ts';
import { editStandaloneTask } from '../../storage/tasks/edit-task.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { createTaskMetadataEditor, type TaskMetadataOwner } from './metadata-editor.ts';
import { Logger } from '../logger.ts';
import type { SpaceTaskManager } from './task-manager.ts';
import { resolveSessionSpaceId } from '../space/runtime/space-caller-scope.ts';
import type { SpaceMcpSessionPolicyContext } from '../space/runtime/space-mcp-session-policy.ts';

const log = new Logger('SpaceTaskMetadata');

export interface SpaceTaskMetadataDependencies extends SpaceMcpSessionPolicyContext {
  db: Database;
  getSession: (sessionId: string) => Session | null;
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'updateTask' | 'submitTaskForReview'>;
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
  return resolveSessionSpaceId(session, context);
}

export function resolveSpaceTaskOwner(db: Database, taskId: string): TaskMetadataOwner | null {
  const row = db.prepare('SELECT space_id FROM space_tasks WHERE id = ?').get(taskId) as {
    space_id: string | null;
  } | null;
  return !row
    ? null
    : row.space_id === null
      ? { kind: 'standalone' }
      : { kind: 'space', spaceId: row.space_id };
}

export type TaskCallerAdmissionDependencies = Pick<SpaceTaskMetadataDependencies, 'getSession'> &
  SpaceMcpSessionPolicyContext;

function resolveAdmittedSession(
  owner: TaskMetadataOwner,
  caller: OperationCaller,
  deps: TaskCallerAdmissionDependencies
): Session | null {
  return owner.kind === 'space' && caller.source === 'mcp' && caller.sessionId
    ? deps.getSession(caller.sessionId)
    : null;
}

export function requireActiveMetadataCallerSession(
  owner: TaskMetadataOwner,
  caller: OperationCaller,
  session: Session | null
): { value: true } | { reason: string } {
  return owner.kind === 'standalone' || caller.source !== 'mcp' || session?.status === 'active'
    ? { value: true }
    : { reason: 'Task mutations require an active session in the owning Space' };
}

export function admitSpaceTaskCaller(
  owner: TaskMetadataOwner,
  caller: OperationCaller,
  deps: TaskCallerAdmissionDependencies
): { value: true } | { reason: string } {
  const session = resolveAdmittedSession(owner, caller, deps);
  return requireMetadataCallerScope(owner, caller, resolveMetadataSessionSpace(session, deps));
}

export function admitSpaceTaskMutation(
  owner: TaskMetadataOwner,
  caller: OperationCaller,
  deps: TaskCallerAdmissionDependencies
): { value: true } | { reason: string } {
  const session = resolveAdmittedSession(owner, caller, deps);
  const scope = requireMetadataCallerScope(
    owner,
    caller,
    resolveMetadataSessionSpace(session, deps)
  );
  return 'reason' in scope ? scope : requireActiveMetadataCallerSession(owner, caller, session);
}

export function createSpaceTaskMetadataEditor(dependencies: SpaceTaskMetadataDependencies) {
  const { db, getTaskManager, notifyStandalone, emitTaskUpdated } = dependencies;
  return createTaskMetadataEditor({
    resolveOwner: (taskId) => resolveSpaceTaskOwner(db, taskId),
    admit: (owner, caller) => {
      const scope = admitSpaceTaskMutation(owner, caller, dependencies);
      if ('reason' in scope) return { accepted: false, reason: 'task_update_denied' };
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
