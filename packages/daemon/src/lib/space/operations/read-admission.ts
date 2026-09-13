import type { Database } from '../../../storage/sqlite-compat.ts';
import type { OperationCaller } from '../../operations/registry.ts';
import type { SpaceMcpSessionPolicyContext } from '../runtime/space-mcp-session-policy.ts';
import {
  admitSpaceTaskCaller,
  resolveSpaceTaskOwner,
  type SpaceTaskMetadataDependencies,
} from './task-metadata.ts';

export type TaskReadAdmissionDependencies = Pick<SpaceTaskMetadataDependencies, 'getSession'> &
  SpaceMcpSessionPolicyContext;

export function admitTaskRead(
  db: Database,
  taskId: string,
  caller: OperationCaller,
  deps: TaskReadAdmissionDependencies
): boolean {
  const owner = resolveSpaceTaskOwner(db, taskId);
  return owner === null || 'value' in admitSpaceTaskCaller(owner, caller, deps);
}

export function admitSpaceScope(
  spaceId: string | undefined,
  caller: OperationCaller,
  deps: TaskReadAdmissionDependencies
): boolean {
  return (
    spaceId === undefined ||
    'value' in admitSpaceTaskCaller({ kind: 'space', spaceId }, caller, deps)
  );
}
