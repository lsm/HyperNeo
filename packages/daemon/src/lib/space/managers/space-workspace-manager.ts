import superpipe, { type PipelineAPI } from 'superpipe';
import type { Space } from '@hyperneo/shared';
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
  type WorkspaceValidationVerdict,
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

function buildRegistrySnapshot(
  spaceRepo: SpaceRepository,
  workspaceRepo: SpaceWorkspaceRepository,
  targetSpaceId: string
): WorkspaceRegistrySnapshot {
  const spaces = spaceRepo.listSpaces(true);
  const claims: WorkspaceRegistryClaim[] = [];
  let workspaceCountForSpace = 0;

  for (const space of spaces) {
    const rows = workspaceRepo.listBySpace(space.id);
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

function containsNestedPath(parent: string, child: string): boolean {
  if (parent === '/') return child !== '/';
  return child.startsWith(`${parent}/`);
}

function insertWorkspaceIfUnclaimed(
  workspaceRepo: SpaceWorkspaceRepository,
  spaceRepo: SpaceRepository,
  space: Space,
  canonicalPath: string,
  label?: string
): SpaceWorkspaceRecord {
  const existingWorkspace = workspaceRepo.findOwnerByPath(canonicalPath);
  if (existingWorkspace) {
    if (existingWorkspace.spaceId === space.id) {
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

  const existingSpace = spaceRepo.getSpaceByPath(canonicalPath);
  if (existingSpace) {
    if (existingSpace.id === space.id) {
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

  const rows = workspaceRepo.listBySpace(space.id);
  for (const row of rows) {
    if (row.path === canonicalPath) continue;
    if (containsNestedPath(canonicalPath, row.path)) {
      throw new WorkspaceRegistrationError(
        `Workspace path contains registered workspace ${row.path} of the same space`,
        'ambiguous_nesting',
        {
          accepted: false,
          reason: 'ambiguous_nesting',
          message: `Workspace path contains registered workspace ${row.path} of the same space`,
          canonicalPath,
          conflictPath: row.path,
          conflictSpaceId: row.spaceId,
          nestingDirection: 'existing_inside_candidate',
        }
      );
    }
    if (containsNestedPath(row.path, canonicalPath)) {
      throw new WorkspaceRegistrationError(
        `Workspace path is inside registered workspace ${row.path} of the same space`,
        'ambiguous_nesting',
        {
          accepted: false,
          reason: 'ambiguous_nesting',
          message: `Workspace path is inside registered workspace ${row.path} of the same space`,
          canonicalPath,
          conflictPath: row.path,
          conflictSpaceId: row.spaceId,
          nestingDirection: 'candidate_inside_existing',
        }
      );
    }
  }

  const hasPrimaryRow = rows.some((row) => row.isPrimary);
  const workspaceCount = rows.length + (hasPrimaryRow ? 0 : 1);
  if (workspaceCount >= MAX_WORKSPACES_PER_SPACE) {
    throw new WorkspaceRegistrationError(
      `Space ${space.id} already has ${workspaceCount} workspaces (limit ${MAX_WORKSPACES_PER_SPACE})`,
      'workspace_cap_reached',
      {
        accepted: false,
        reason: 'workspace_cap_reached',
        message: `Space ${space.id} already has ${workspaceCount} workspaces (limit ${MAX_WORKSPACES_PER_SPACE})`,
        canonicalPath,
        limit: MAX_WORKSPACES_PER_SPACE,
      }
    );
  }

  return workspaceRepo.create({
    spaceId: space.id,
    path: canonicalPath,
    label,
    isPrimary: false,
  });
}

interface RegisterWorkspaceCtx {
  db: BunDatabase;
  spaceRepo: SpaceRepository;
  workspaceRepo: SpaceWorkspaceRepository;
  io: WorkspaceValidationIo;
  spaceId: string;
  rawPath: string;
  label?: string;
  space?: Space;
  snapshot?: WorkspaceRegistrySnapshot;
  verdict?: WorkspaceValidationVerdict;
  record?: SpaceWorkspaceRecord;
  error?: Error;
}

function hasError(ctx: RegisterWorkspaceCtx): boolean {
  return ctx.error !== undefined;
}

function hasSpace(ctx: RegisterWorkspaceCtx): boolean {
  return ctx.space !== undefined;
}

function hasVerdict(ctx: RegisterWorkspaceCtx): boolean {
  return ctx.verdict !== undefined;
}

function hasRecord(ctx: RegisterWorkspaceCtx): boolean {
  return ctx.record !== undefined;
}

function loadSpace(ctx: RegisterWorkspaceCtx): RegisterWorkspaceCtx {
  const space = ctx.spaceRepo.getSpace(ctx.spaceId);
  if (!space) {
    return { ...ctx, error: new Error(`Space not found: ${ctx.spaceId}`) };
  }
  return { ...ctx, space };
}

function buildSnapshot(ctx: RegisterWorkspaceCtx): RegisterWorkspaceCtx {
  const snapshot = buildRegistrySnapshot(ctx.spaceRepo, ctx.workspaceRepo, ctx.spaceId);
  return { ...ctx, snapshot };
}

async function validatePath(ctx: RegisterWorkspaceCtx): Promise<RegisterWorkspaceCtx> {
  try {
    const verdict = await validateWorkspaceRegistration(ctx.io, ctx.snapshot!, {
      spaceId: ctx.spaceId,
      rawPath: ctx.rawPath,
    });
    return { ...ctx, verdict };
  } catch (err) {
    return { ...ctx, error: err as Error };
  }
}

function guardVerdict(ctx: RegisterWorkspaceCtx): RegisterWorkspaceCtx {
  if (!ctx.verdict) {
    return { ...ctx, error: new Error('workspace validation produced no verdict') };
  }
  if (!ctx.verdict.accepted) {
    return {
      ...ctx,
      error: new WorkspaceRegistrationError(ctx.verdict.message, ctx.verdict.reason, ctx.verdict),
    };
  }
  return ctx;
}

async function recheckAndInsert(ctx: RegisterWorkspaceCtx): Promise<RegisterWorkspaceCtx> {
  try {
    const record = ctx.db.transaction(() =>
      insertWorkspaceIfUnclaimed(
        ctx.workspaceRepo,
        ctx.spaceRepo,
        ctx.space!,
        ctx.verdict!.canonicalPath!,
        ctx.label
      )
    )() as SpaceWorkspaceRecord;
    return { ...ctx, record };
  } catch (err) {
    return { ...ctx, error: err as Error };
  }
}

const runRegisterWorkspace = (
  superpipe<{
    hasError: typeof hasError;
    hasSpace: typeof hasSpace;
    hasVerdict: typeof hasVerdict;
    hasRecord: typeof hasRecord;
  }>({
    hasError,
    hasSpace,
    hasVerdict,
    hasRecord,
  })('workspace-registration') as PipelineAPI
)
  .input(['ctx'])
  .pipe(loadSpace, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe('hasSpace', 'ctx')
  .pipe(buildSnapshot, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(validatePath, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe('hasVerdict', 'ctx')
  .pipe(guardVerdict, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(recheckAndInsert, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe('hasRecord', 'ctx')
  .endAsync('ctx') as (ctx: RegisterWorkspaceCtx) => Promise<RegisterWorkspaceCtx>;

interface RemoveWorkspaceCtx {
  workspaceRepo: SpaceWorkspaceRepository;
  sessionRepo: SessionRepository;
  spaceId: string;
  workspaceId: string;
  workspace?: SpaceWorkspaceRecord;
  activeSessionCount?: number;
  removed: boolean;
  blocked?: Error;
}

function removeHasWorkspace(ctx: RemoveWorkspaceCtx): boolean {
  return ctx.workspace !== undefined;
}

function removeHasBlocked(ctx: RemoveWorkspaceCtx): boolean {
  return ctx.blocked !== undefined;
}

function removeIsPrimary(ctx: RemoveWorkspaceCtx): boolean {
  return ctx.workspace?.isPrimary ?? false;
}

function removeHasActiveSessions(ctx: RemoveWorkspaceCtx): boolean {
  return (ctx.activeSessionCount ?? 0) > 0;
}

function removeLoadWorkspace(ctx: RemoveWorkspaceCtx): RemoveWorkspaceCtx {
  const workspace = ctx.workspaceRepo.getById(ctx.workspaceId);
  if (!workspace || workspace.spaceId !== ctx.spaceId) {
    return { ...ctx, removed: false };
  }
  return { ...ctx, workspace };
}

function removeGuardPrimary(ctx: RemoveWorkspaceCtx): RemoveWorkspaceCtx {
  if (ctx.workspace?.isPrimary) {
    return {
      ...ctx,
      blocked: new WorkspaceRemovalBlockedError('Cannot remove the primary workspace', 'primary'),
    };
  }
  return ctx;
}

function removeCountActiveSessions(ctx: RemoveWorkspaceCtx): RemoveWorkspaceCtx {
  if (!ctx.workspace) return ctx;
  const activeSessionCount = ctx.sessionRepo.countActiveSessionsBySpaceAndWorkspacePath(
    ctx.spaceId,
    ctx.workspace.path
  );
  return { ...ctx, activeSessionCount };
}

function removeGuardActiveSessions(ctx: RemoveWorkspaceCtx): RemoveWorkspaceCtx {
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

function removeDeleteWorkspace(ctx: RemoveWorkspaceCtx): RemoveWorkspaceCtx {
  const removed = ctx.workspaceRepo.delete(ctx.spaceId, ctx.workspaceId);
  return { ...ctx, removed };
}

const runRemoveWorkspace = (
  superpipe<{
    hasWorkspace: typeof removeHasWorkspace;
    hasBlocked: typeof removeHasBlocked;
    isPrimary: typeof removeIsPrimary;
    hasActiveSessions: typeof removeHasActiveSessions;
  }>({
    hasWorkspace: removeHasWorkspace,
    hasBlocked: removeHasBlocked,
    isPrimary: removeIsPrimary,
    hasActiveSessions: removeHasActiveSessions,
  })('workspace-removal') as PipelineAPI
)
  .input(['ctx'])
  .pipe(removeLoadWorkspace, 'ctx', 'ctx')
  .pipe('hasWorkspace', 'ctx')
  .pipe(removeGuardPrimary, 'ctx', 'ctx')
  .pipe('!hasBlocked', 'ctx')
  .pipe('!isPrimary', 'ctx')
  .pipe(removeCountActiveSessions, 'ctx', 'ctx')
  .pipe(removeGuardActiveSessions, 'ctx', 'ctx')
  .pipe('!hasBlocked', 'ctx')
  .pipe('!hasActiveSessions', 'ctx')
  .pipe(removeDeleteWorkspace, 'ctx', 'ctx')
  .end('ctx') as (ctx: RemoveWorkspaceCtx) => RemoveWorkspaceCtx;

export class SpaceWorkspaceManager {
  private spaceRepo: SpaceRepository;
  private workspaceRepo: SpaceWorkspaceRepository;
  private sessionRepo: SessionRepository;

  constructor(
    private db: BunDatabase,
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
    const result = await runRegisterWorkspace({
      db: this.db,
      spaceRepo: this.spaceRepo,
      workspaceRepo: this.workspaceRepo,
      io: this.io,
      spaceId,
      rawPath,
      label,
    });

    if (result.error) {
      throw result.error;
    }
    return result.record!;
  }

  async removeWorkspace(spaceId: string, workspaceId: string): Promise<boolean> {
    const result = this.db.transaction(() =>
      runRemoveWorkspace({
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
}
