import superpipe, { type PipelineAPI } from 'superpipe';
import type { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import type {
  SpaceWorkspaceRecord,
  SpaceWorkspaceRepository,
} from '../../../storage/repositories/space-workspace-repository.ts';
import {
  nodeWorkspaceValidationIo,
  validateWorkspaceRegistration,
  type WorkspaceRegistryClaim,
  type WorkspaceRegistrySnapshot,
  type WorkspaceValidationIo,
  type WorkspaceValidationRejection,
  type WorkspaceValidationVerdict,
} from '../workspaces/workspace-validation-pipeline.ts';

export type WorkspaceRegistryReader = Pick<SpaceRepository, 'getSpace' | 'listSpaces'>;

export type WorkspaceStore = Pick<
  SpaceWorkspaceRepository,
  'create' | 'getById' | 'listBySpace' | 'delete'
>;

export interface WorkspaceSessionReferences {
  countActiveSessionsByWorkspacePath(spaceId: string, workspacePath: string): number;
}

export interface SpaceWorkspaceManagerDeps {
  spaces: WorkspaceRegistryReader;
  workspaces: WorkspaceStore;
  sessionReferences: WorkspaceSessionReferences;
  io?: WorkspaceValidationIo;
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
    readonly reason: 'primary' | 'active_sessions'
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

interface RegisterWorkspaceCtx {
  spaces: WorkspaceRegistryReader;
  workspaces: WorkspaceStore;
  io: WorkspaceValidationIo;
  spaceId: string;
  rawPath: string;
  label?: string;
  snapshot?: WorkspaceRegistrySnapshot;
  verdict?: WorkspaceValidationVerdict;
  record?: SpaceWorkspaceRecord;
  error?: Error;
}

function registerLoadSpace(ctx: RegisterWorkspaceCtx): RegisterWorkspaceCtx {
  if (ctx.spaces.getSpace(ctx.spaceId)) return ctx;
  return { ...ctx, error: new Error(`Space not found: ${ctx.spaceId}`) };
}

function registerBuildSnapshot(ctx: RegisterWorkspaceCtx): RegisterWorkspaceCtx {
  return { ...ctx, snapshot: buildRegistrySnapshot(ctx.spaces, ctx.workspaces, ctx.spaceId) };
}

async function registerRunValidationGates(
  ctx: RegisterWorkspaceCtx
): Promise<RegisterWorkspaceCtx> {
  const verdict = await validateWorkspaceRegistration(ctx.io, ctx.snapshot!, {
    spaceId: ctx.spaceId,
    rawPath: ctx.rawPath,
  });
  return { ...ctx, verdict };
}

function registerEnsureAccepted(ctx: RegisterWorkspaceCtx): RegisterWorkspaceCtx {
  const verdict = ctx.verdict!;
  if (verdict.accepted) return ctx;
  return {
    ...ctx,
    error: new WorkspaceRegistrationError(verdict.message, verdict.reason, verdict),
  };
}

function registerInsertWorkspace(ctx: RegisterWorkspaceCtx): RegisterWorkspaceCtx {
  const verdict = ctx.verdict!;
  if (!verdict.accepted) return ctx;
  const record = ctx.workspaces.create({
    spaceId: ctx.spaceId,
    path: verdict.canonicalPath,
    label: ctx.label,
    isPrimary: false,
  });
  return { ...ctx, record };
}

const runRegisterWorkspace = (
  superpipe({
    hasError: (ctx: RegisterWorkspaceCtx) => ctx.error !== undefined,
  })('workspace-registration') as PipelineAPI
)
  .input(['ctx'])
  .pipe(registerLoadSpace, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(registerBuildSnapshot, 'ctx', 'ctx')
  .pipe(registerRunValidationGates, 'ctx', 'ctx')
  .pipe(registerEnsureAccepted, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(registerInsertWorkspace, 'ctx', 'ctx')
  .endAsync('ctx') as (input: RegisterWorkspaceCtx) => Promise<RegisterWorkspaceCtx>;

interface RemoveWorkspaceCtx {
  workspaces: WorkspaceStore;
  sessionReferences: WorkspaceSessionReferences;
  spaceId: string;
  workspaceId: string;
  workspace?: SpaceWorkspaceRecord;
  removed: boolean;
  blocked?: Error;
}

function removeLoadWorkspace(ctx: RemoveWorkspaceCtx): RemoveWorkspaceCtx {
  const workspace = ctx.workspaces.getById(ctx.workspaceId);
  if (!workspace || workspace.spaceId !== ctx.spaceId) return ctx;
  return { ...ctx, workspace };
}

function removeGuardPrimary(ctx: RemoveWorkspaceCtx): RemoveWorkspaceCtx {
  if (!ctx.workspace?.isPrimary) return ctx;
  return {
    ...ctx,
    blocked: new WorkspaceRemovalBlockedError(
      `Cannot remove the primary workspace of space ${ctx.spaceId}`,
      'primary'
    ),
  };
}

function removeGuardActiveSessions(ctx: RemoveWorkspaceCtx): RemoveWorkspaceCtx {
  const workspace = ctx.workspace!;
  const activeSessionCount = ctx.sessionReferences.countActiveSessionsByWorkspacePath(
    ctx.spaceId,
    workspace.path
  );
  if (activeSessionCount === 0) return ctx;
  return {
    ...ctx,
    blocked: new WorkspaceRemovalBlockedError(
      `Cannot remove workspace ${ctx.workspaceId} while ${activeSessionCount} active sessions reference it`,
      'active_sessions'
    ),
  };
}

function removeDeleteWorkspace(ctx: RemoveWorkspaceCtx): RemoveWorkspaceCtx {
  return { ...ctx, removed: ctx.workspaces.delete(ctx.spaceId, ctx.workspaceId) };
}

const runRemoveWorkspace = (
  superpipe({
    workspaceMissing: (ctx: RemoveWorkspaceCtx) => ctx.workspace === undefined,
    hasBlocked: (ctx: RemoveWorkspaceCtx) => ctx.blocked !== undefined,
  })('workspace-removal') as PipelineAPI
)
  .input(['ctx'])
  .pipe(removeLoadWorkspace, 'ctx', 'ctx')
  .pipe('!workspaceMissing', 'ctx')
  .pipe(removeGuardPrimary, 'ctx', 'ctx')
  .pipe('!hasBlocked', 'ctx')
  .pipe(removeGuardActiveSessions, 'ctx', 'ctx')
  .pipe('!hasBlocked', 'ctx')
  .pipe(removeDeleteWorkspace, 'ctx', 'ctx')
  .end('ctx') as (input: RemoveWorkspaceCtx) => RemoveWorkspaceCtx;

interface ListWorkspacesCtx {
  spaces: WorkspaceRegistryReader;
  workspaces: WorkspaceStore;
  spaceId: string;
  rows?: SpaceWorkspaceRecord[];
  error?: Error;
}

function listLoadSpace(ctx: ListWorkspacesCtx): ListWorkspacesCtx {
  if (ctx.spaces.getSpace(ctx.spaceId)) return ctx;
  return { ...ctx, error: new Error(`Space not found: ${ctx.spaceId}`) };
}

function listWorkspaceRows(ctx: ListWorkspacesCtx): ListWorkspacesCtx {
  return { ...ctx, rows: ctx.workspaces.listBySpace(ctx.spaceId) };
}

const runListWorkspaces = (
  superpipe({
    hasError: (ctx: ListWorkspacesCtx) => ctx.error !== undefined,
  })('workspace-listing') as PipelineAPI
)
  .input(['ctx'])
  .pipe(listLoadSpace, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(listWorkspaceRows, 'ctx', 'ctx')
  .end('ctx') as (input: ListWorkspacesCtx) => ListWorkspacesCtx;

export class SpaceWorkspaceManager {
  constructor(private readonly deps: SpaceWorkspaceManagerDeps) {}

  async registerWorkspace(
    spaceId: string,
    rawPath: string,
    label?: string
  ): Promise<SpaceWorkspaceRecord> {
    const result = await runRegisterWorkspace({
      spaces: this.deps.spaces,
      workspaces: this.deps.workspaces,
      io: this.deps.io ?? nodeWorkspaceValidationIo,
      spaceId,
      rawPath,
      label,
    });
    if (result.error) throw result.error;
    if (!result.record) throw new Error('workspace registration produced no record');
    return result.record;
  }

  removeWorkspace(spaceId: string, workspaceId: string): boolean {
    const result = runRemoveWorkspace({
      workspaces: this.deps.workspaces,
      sessionReferences: this.deps.sessionReferences,
      spaceId,
      workspaceId,
      removed: false,
    });
    if (result.blocked) throw result.blocked;
    return result.removed;
  }

  listWorkspaces(spaceId: string): SpaceWorkspaceRecord[] {
    const result = runListWorkspaces({
      spaces: this.deps.spaces,
      workspaces: this.deps.workspaces,
      spaceId,
    });
    if (result.error) throw result.error;
    return result.rows ?? [];
  }
}
