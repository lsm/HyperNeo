import type { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import type { SpaceWorkspaceRepository } from '../../storage/repositories/space-workspace-repository.ts';
import type {
  WorkspaceRegistryClaim,
  WorkspaceRegistrySnapshot,
  WorkspaceValidationIo,
  WorkspaceValidationRejection,
} from './validation-pipeline.ts';

export type WorkspaceRegistryReader = Pick<SpaceRepository, 'getSpace' | 'listSpaces'>;

export type WorkspaceStore = Pick<
  SpaceWorkspaceRepository,
  | 'create'
  | 'createUnclaimed'
  | 'findOwnerByPath'
  | 'getById'
  | 'listBySpace'
  | 'updateLabel'
  | 'delete'
>;

export interface WorkspaceSessionReferences {
  countActiveSessionsByWorkspacePath(spaceId: string, workspacePath: string): number;
}

export interface WorkspaceTaskReferences {
  countActiveTasksByWorkspacePath(spaceId: string, workspacePath: string): number;
}

export interface WorkspaceGoalReferences {
  countActiveGoalsByWorkspacePath(spaceId: string, workspacePath: string): number;
}

export interface SpaceWorkspaceManagerDeps {
  spaces: WorkspaceRegistryReader;
  workspaces: WorkspaceStore;
  sessionReferences: WorkspaceSessionReferences;
  taskReferences: WorkspaceTaskReferences;
  goalReferences: WorkspaceGoalReferences;
  io?: WorkspaceValidationIo;
  transaction?: <T>(fn: () => T) => T;
}

export class WorkspaceRegistrationError extends Error {
  constructor(
    message: string,
    readonly reason: WorkspaceValidationRejection['reason'],
    readonly verdict: WorkspaceValidationRejection
  ) {
    super(message);
    this.name = 'WorkspaceRegistrationError';
  }
}

export class WorkspaceRemovalBlockedError extends Error {
  constructor(
    message: string,
    readonly reason: 'primary' | 'active_sessions' | 'active_tasks' | 'active_goals'
  ) {
    super(message);
    this.name = 'WorkspaceRemovalBlockedError';
  }
}

export function buildRegistrySnapshot(
  spaces: WorkspaceRegistryReader,
  workspaces: WorkspaceStore,
  targetSpaceId: string
): WorkspaceRegistrySnapshot {
  const claims: WorkspaceRegistryClaim[] = [];
  let workspaceCountForSpace = 0;
  for (const space of spaces.listSpaces(true)) {
    const rows = workspaces.listBySpace(space.id);
    const paths = new Set<string>();
    let hasPrimaryRow = false;
    for (const row of rows) {
      claims.push({
        spaceId: row.spaceId,
        path: row.path,
        source: row.isPrimary ? 'space_primary_path' : 'registered_workspace',
      });
      paths.add(row.path);
      if (row.isPrimary) hasPrimaryRow = true;
    }
    if (!hasPrimaryRow && space.workspacePath) {
      claims.push({ spaceId: space.id, path: space.workspacePath, source: 'space_primary_path' });
      paths.add(space.workspacePath);
    }
    if (space.id === targetSpaceId) workspaceCountForSpace = paths.size;
  }
  return { claims, workspaceCountForSpace };
}
