import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import {
  SpaceWorkspaceRepository,
  type SpaceWorkspaceRecord,
} from '../../../storage/repositories/space-workspace-repository.ts';
import {
  MAX_WORKSPACES_PER_SPACE,
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

interface RemoveWorkspaceCtx {
  db: BunDatabase;
  workspaceRepo: SpaceWorkspaceRepository;
  sessionRepo: SessionRepository;
  spaceId: string;
  workspaceId: string;
  workspace?: SpaceWorkspaceRecord;
  activeSessionCount?: number;
  removed: boolean;
  blocked?: Error;
}

function hasWorkspace(ctx: RemoveWorkspaceCtx): boolean {
  return ctx.workspace !== undefined;
}

function hasBlocked(ctx: RemoveWorkspaceCtx): boolean {
  return ctx.blocked !== undefined;
}

function isPrimary(ctx: RemoveWorkspaceCtx): boolean {
  return ctx.workspace?.isPrimary ?? false;
}

function hasActiveSessions(ctx: RemoveWorkspaceCtx): boolean {
  return (ctx.activeSessionCount ?? 0) > 0;
}

function loadWorkspace(ctx: RemoveWorkspaceCtx): RemoveWorkspaceCtx {
  const workspace = ctx.workspaceRepo.getById(ctx.workspaceId);
  if (!workspace || workspace.spaceId !== ctx.spaceId) {
    return { ...ctx, removed: false };
  }
  return { ...ctx, workspace };
}

function guardPrimary(ctx: RemoveWorkspaceCtx): RemoveWorkspaceCtx {
  if (ctx.workspace?.isPrimary) {
    return {
      ...ctx,
      blocked: new WorkspaceRemovalBlockedError('Cannot remove the primary workspace', 'primary'),
    };
  }
  return ctx;
}

function countActiveSessions(ctx: RemoveWorkspaceCtx): RemoveWorkspaceCtx {
  if (!ctx.workspace) return ctx;
  const activeSessionCount = ctx.sessionRepo.countActiveSessionsBySpaceAndWorkspacePath(
    ctx.spaceId,
    ctx.workspace.path
  );
  return { ...ctx, activeSessionCount };
}

function guardActiveSessions(ctx: RemoveWorkspaceCtx): RemoveWorkspaceCtx {
  if ((ctx.activeSessionCount ?? 0) > 0) {
    return {
      ...ctx,
      blocked: new WorkspaceRemovalBlockedError(
        'Cannot remove workspace while active sessions reference it',
        'active_sessions'
      ),
    };
  }
  return ctx;
}

function deleteWorkspace(ctx: RemoveWorkspaceCtx): RemoveWorkspaceCtx {
  const removed = ctx.workspaceRepo.delete(ctx.spaceId, ctx.workspaceId);
  return { ...ctx, removed };
}

const runRemoveWorkspace = (
  superpipe<{
    hasWorkspace: typeof hasWorkspace;
    hasBlocked: typeof hasBlocked;
    isPrimary: typeof isPrimary;
    hasActiveSessions: typeof hasActiveSessions;
  }>({
    hasWorkspace,
    hasBlocked,
    isPrimary,
    hasActiveSessions,
  })('workspace-removal') as PipelineAPI
)
  .input(['ctx'])
  .pipe(loadWorkspace, 'ctx', 'ctx')
  .pipe('hasWorkspace', 'ctx')
  .pipe(guardPrimary, 'ctx', 'ctx')
  .pipe('!hasBlocked', 'ctx')
  .pipe('!isPrimary', 'ctx')
  .pipe(countActiveSessions, 'ctx', 'ctx')
  .pipe(guardActiveSessions, 'ctx', 'ctx')
  .pipe('!hasBlocked', 'ctx')
  .pipe('!hasActiveSessions', 'ctx')
  .pipe(deleteWorkspace, 'ctx', 'ctx')
  .end('ctx') as (ctx: RemoveWorkspaceCtx) => RemoveWorkspaceCtx;

export class SpaceWorkspaceManager {
  private db: BunDatabase;
  private spaceRepo: SpaceRepository;
  private workspaceRepo: SpaceWorkspaceRepository;
  private sessionRepo: SessionRepository;

  constructor(
    db: BunDatabase,
    private io: WorkspaceValidationIo = nodeWorkspaceValidationIo
  ) {
    this.db = db;
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

    const insert = this.db.transaction(() =>
      this.insertWorkspaceIfUnclaimed(spaceId, verdict.canonicalPath, label)
    );
    return insert() as SpaceWorkspaceRecord;
  }

  async removeWorkspace(spaceId: string, workspaceId: string): Promise<boolean> {
    const result = this.db.transaction(() =>
      runRemoveWorkspace({
        db: this.db,
        workspaceRepo: this.workspaceRepo,
        sessionRepo: this.sessionRepo,
        spaceId,
        workspaceId,
        removed: false,
      })
    )() as RemoveWorkspaceCtx;

    if (result.blocked) {
      throw result.blocked;
    }
    return result.removed;
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

  private insertWorkspaceIfUnclaimed(
    spaceId: string,
    canonicalPath: string,
    label?: string
  ): SpaceWorkspaceRecord {
    const existingWorkspace = this.workspaceRepo.findOwnerByPath(canonicalPath);
    if (existingWorkspace) {
      if (existingWorkspace.spaceId === spaceId) {
        throw new WorkspaceRegistrationError(
          `Workspace path is already registered to this space: ${canonicalPath}`,
          'duplicate_of_registered_workspace',
          {
            accepted: false,
            reason: 'duplicate_of_registered_workspace',
            message: `Workspace path is already registered to this space: ${canonicalPath}`,
            canonicalPath,
            conflictPath: existingWorkspace.path,
            conflictSpaceId: existingWorkspace.spaceId,
          }
        );
      }
      throw new WorkspaceRegistrationError(
        `Workspace path is already claimed by space ${existingWorkspace.spaceId}: ${canonicalPath}`,
        'path_claimed_by_another_space',
        {
          accepted: false,
          reason: 'path_claimed_by_another_space',
          message: `Workspace path is already claimed by space ${existingWorkspace.spaceId}: ${canonicalPath}`,
          canonicalPath,
          conflictPath: existingWorkspace.path,
          conflictSpaceId: existingWorkspace.spaceId,
        }
      );
    }

    const existingSpace = this.spaceRepo.getSpaceByPath(canonicalPath);
    if (existingSpace) {
      if (existingSpace.id === spaceId) {
        throw new WorkspaceRegistrationError(
          `Workspace path is already registered to this space: ${canonicalPath}`,
          'duplicate_of_registered_workspace',
          {
            accepted: false,
            reason: 'duplicate_of_registered_workspace',
            message: `Workspace path is already registered to this space: ${canonicalPath}`,
            canonicalPath,
            conflictPath: existingSpace.workspacePath,
            conflictSpaceId: existingSpace.id,
          }
        );
      }
      throw new WorkspaceRegistrationError(
        `Workspace path is already claimed by space ${existingSpace.id}: ${canonicalPath}`,
        'path_claimed_by_another_space',
        {
          accepted: false,
          reason: 'path_claimed_by_another_space',
          message: `Workspace path is already claimed by space ${existingSpace.id}: ${canonicalPath}`,
          canonicalPath,
          conflictPath: existingSpace.workspacePath,
          conflictSpaceId: existingSpace.id,
        }
      );
    }

    const rows = this.workspaceRepo.listBySpace(spaceId);
    const hasPrimaryRow = rows.some((row) => row.isPrimary);
    const workspaceCount = rows.length + (hasPrimaryRow ? 0 : 1);
    if (workspaceCount >= MAX_WORKSPACES_PER_SPACE) {
      throw new WorkspaceRegistrationError(
        `Space ${spaceId} already has ${workspaceCount} workspaces (limit ${MAX_WORKSPACES_PER_SPACE})`,
        'workspace_cap_reached',
        {
          accepted: false,
          reason: 'workspace_cap_reached',
          message: `Space ${spaceId} already has ${workspaceCount} workspaces (limit ${MAX_WORKSPACES_PER_SPACE})`,
          canonicalPath,
          limit: MAX_WORKSPACES_PER_SPACE,
        }
      );
    }

    return this.workspaceRepo.create({
      spaceId,
      path: canonicalPath,
      label,
      isPrimary: false,
    });
  }
}
