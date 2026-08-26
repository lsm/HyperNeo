import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import {
  SpaceWorkspaceRepository,
  type SpaceWorkspaceRecord,
} from '../../../storage/repositories/space-workspace-repository.ts';
import {
  nodeWorkspaceValidationIo,
  validateWorkspaceRegistration,
  type WorkspaceRegistryClaim,
  type WorkspaceRegistrySnapshot,
  type WorkspaceValidationIo,
  type WorkspaceValidationRejection,
} from '../workspaces/workspace-validation-pipeline.ts';

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
    readonly reason: 'primary' | 'active_sessions'
  ) {
    super(message);
    this.name = 'WorkspaceRemovalBlockedError';
  }
}

export class SpaceWorkspaceManager {
  private spaceRepo: SpaceRepository;
  private workspaceRepo: SpaceWorkspaceRepository;
  private sessionRepo: SessionRepository;

  constructor(
    db: BunDatabase,
    private io: WorkspaceValidationIo = nodeWorkspaceValidationIo
  ) {
    this.spaceRepo = new SpaceRepository(db);
    this.workspaceRepo = new SpaceWorkspaceRepository(db);
    this.sessionRepo = new SessionRepository(db);
  }

  async registerWorkspace(
    spaceId: string,
    rawPath: string,
    label?: string
  ): Promise<SpaceWorkspaceRecord> {
    const space = this.spaceRepo.getSpace(spaceId);
    if (!space) {
      throw new Error(`Space not found: ${spaceId}`);
    }

    const snapshot = this.buildRegistrySnapshot(spaceId);
    const verdict = await validateWorkspaceRegistration(this.io, snapshot, {
      spaceId,
      rawPath,
    });

    if (!verdict.accepted) {
      throw new WorkspaceRegistrationError(verdict.message, verdict.reason, verdict);
    }

    return this.workspaceRepo.create({
      spaceId,
      path: verdict.canonicalPath,
      label,
      isPrimary: false,
    });
  }

  async removeWorkspace(spaceId: string, workspaceId: string): Promise<boolean> {
    const workspace = this.workspaceRepo.getById(workspaceId);
    if (!workspace || workspace.spaceId !== spaceId) {
      return false;
    }

    if (workspace.isPrimary) {
      throw new WorkspaceRemovalBlockedError('Cannot remove the primary workspace', 'primary');
    }

    if (this.sessionRepo.countActiveSessionsBySpaceAndWorkspacePath(spaceId, workspace.path) > 0) {
      throw new WorkspaceRemovalBlockedError(
        'Cannot remove workspace while active sessions reference it',
        'active_sessions'
      );
    }

    return this.workspaceRepo.delete(spaceId, workspaceId);
  }

  async listWorkspaces(spaceId: string): Promise<SpaceWorkspaceRecord[]> {
    return this.workspaceRepo.listBySpace(spaceId);
  }

  private buildRegistrySnapshot(targetSpaceId: string): WorkspaceRegistrySnapshot {
    const spaces = this.spaceRepo.listSpaces(true);
    const claims: WorkspaceRegistryClaim[] = [];
    let workspaceCountForSpace = 0;

    for (const space of spaces) {
      const rows = this.workspaceRepo.listBySpace(space.id);
      let hasPrimaryRow = false;

      for (const row of rows) {
        claims.push({
          spaceId: row.spaceId,
          path: row.path,
          source: row.isPrimary ? 'space_primary_path' : 'registered_workspace',
        });
        if (row.isPrimary) hasPrimaryRow = true;
      }

      if (!hasPrimaryRow) {
        claims.push({
          spaceId: space.id,
          path: space.workspacePath,
          source: 'space_primary_path',
        });
      }

      if (space.id === targetSpaceId) {
        const distinct = new Set<string>();
        for (const row of rows) {
          distinct.add(row.path);
        }
        if (!hasPrimaryRow) {
          distinct.add(space.workspacePath);
        }
        workspaceCountForSpace = distinct.size;
      }
    }

    return { claims, workspaceCountForSpace };
  }
}
