import superpipe, { type PipelineAPI } from 'superpipe';
import type { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import type {
  SpaceWorkspaceRecord,
  SpaceWorkspaceRepository,
} from '../../../storage/repositories/space-workspace-repository.ts';
import {
  checkWorkspaceRegistryGates,
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

interface RegisterWorkspaceCtx {
  spaces: WorkspaceRegistryReader;
  workspaces: WorkspaceStore;
  io: WorkspaceValidationIo;
  transaction?: <T>(fn: () => T) => T;
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
  const insert = (): RegisterWorkspaceCtx => {
    const recheck = checkWorkspaceRegistryGates(
      buildRegistrySnapshot(ctx.spaces, ctx.workspaces, ctx.spaceId),
      { spaceId: ctx.spaceId, canonicalPath: verdict.canonicalPath }
    );
    if (!recheck.accepted) {
      return {
        ...ctx,
        error: new WorkspaceRegistrationError(recheck.message, recheck.reason, recheck),
      };
    }
    const record = ctx.workspaces.createUnclaimed({
      spaceId: ctx.spaceId,
      path: verdict.canonicalPath,
      label: ctx.label,
      isPrimary: false,
    });
    if (record) return { ...ctx, record };
    const owner = ctx.workspaces.findOwnerByPath(verdict.canonicalPath);
    const ownClaim = owner?.spaceId === ctx.spaceId;
    const reason = ownClaim ? 'duplicate_of_registered_workspace' : 'path_claimed_by_another_space';
    const message = ownClaim
      ? `Workspace path is already registered to this space: ${verdict.canonicalPath}`
      : `Workspace path is already claimed by space ${owner?.spaceId}: ${verdict.canonicalPath}`;
    return {
      ...ctx,
      error: new WorkspaceRegistrationError(message, reason, {
        accepted: false,
        reason,
        message,
        canonicalPath: verdict.canonicalPath,
        conflictPath: owner?.path,
        conflictSpaceId: owner?.spaceId,
      }),
    };
  };
  return ctx.transaction ? ctx.transaction(insert) : insert();
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
  taskReferences: WorkspaceTaskReferences;
  goalReferences: WorkspaceGoalReferences;
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

function removeGuardActiveTasks(ctx: RemoveWorkspaceCtx): RemoveWorkspaceCtx {
  const workspace = ctx.workspace!;
  const activeTaskCount = ctx.taskReferences.countActiveTasksByWorkspacePath(
    ctx.spaceId,
    workspace.path
  );
  if (activeTaskCount === 0) return ctx;
  return {
    ...ctx,
    blocked: new WorkspaceRemovalBlockedError(
      `Cannot remove workspace ${ctx.workspaceId} while ${activeTaskCount} active task(s) reference it`,
      'active_tasks'
    ),
  };
}

function removeGuardActiveGoals(ctx: RemoveWorkspaceCtx): RemoveWorkspaceCtx {
  const workspace = ctx.workspace!;
  const activeGoalCount = ctx.goalReferences.countActiveGoalsByWorkspacePath(
    ctx.spaceId,
    workspace.path
  );
  if (activeGoalCount === 0) return ctx;
  return {
    ...ctx,
    blocked: new WorkspaceRemovalBlockedError(
      `Cannot remove workspace ${ctx.workspaceId} while ${activeGoalCount} active goal(s) reference it`,
      'active_goals'
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
  .pipe(removeGuardActiveTasks, 'ctx', 'ctx')
  .pipe('!hasBlocked', 'ctx')
  .pipe(removeGuardActiveGoals, 'ctx', 'ctx')
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

interface ResolveWorkspaceCtx {
  spaces: WorkspaceRegistryReader;
  workspaces: WorkspaceStore;
  io: WorkspaceValidationIo;
  spaceId: string;
  rawPath: string;
  snapshot?: WorkspaceRegistrySnapshot;
  canonicalPath?: string;
  registeredPath?: string;
  error?: Error;
}

function resolveLoadSpace(ctx: ResolveWorkspaceCtx): ResolveWorkspaceCtx {
  if (ctx.spaces.getSpace(ctx.spaceId)) return ctx;
  return { ...ctx, error: new Error(`Space not found: ${ctx.spaceId}`) };
}

async function resolveCanonicalizePath(ctx: ResolveWorkspaceCtx): Promise<ResolveWorkspaceCtx> {
  try {
    return { ...ctx, canonicalPath: await ctx.io.realpath(ctx.rawPath) };
  } catch {
    return { ...ctx, error: new Error(`Workspace path does not exist: ${ctx.rawPath}`) };
  }
}

function resolveBuildSnapshot(ctx: ResolveWorkspaceCtx): ResolveWorkspaceCtx {
  return { ...ctx, snapshot: buildRegistrySnapshot(ctx.spaces, ctx.workspaces, ctx.spaceId) };
}

function resolveMatchRegisteredPath(ctx: ResolveWorkspaceCtx): ResolveWorkspaceCtx {
  const claim = ctx.snapshot!.claims.find(
    (c) => c.spaceId === ctx.spaceId && c.path === ctx.canonicalPath
  );
  if (claim) return { ...ctx, registeredPath: claim.path };
  return { ...ctx, error: new Error(`Workspace path is not registered to space: ${ctx.rawPath}`) };
}

const runResolveRegisteredWorkspace = (
  superpipe({
    hasError: (ctx: ResolveWorkspaceCtx) => ctx.error !== undefined,
  })('workspace-resolve-registered') as PipelineAPI
)
  .input(['ctx'])
  .pipe(resolveLoadSpace, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(resolveCanonicalizePath, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(resolveBuildSnapshot, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(resolveMatchRegisteredPath, 'ctx', 'ctx')
  .endAsync('ctx') as (input: ResolveWorkspaceCtx) => Promise<ResolveWorkspaceCtx>;

interface UpdateLabelCtx {
  workspaces: WorkspaceStore;
  spaceId: string;
  workspaceId: string;
  label: string;
  workspace?: SpaceWorkspaceRecord;
  updated: boolean;
}

function updateLabelLoadWorkspace(ctx: UpdateLabelCtx): UpdateLabelCtx {
  const workspace = ctx.workspaces.getById(ctx.workspaceId);
  if (!workspace || workspace.spaceId !== ctx.spaceId) return ctx;
  return { ...ctx, workspace };
}

function updateLabelWrite(ctx: UpdateLabelCtx): UpdateLabelCtx {
  return {
    ...ctx,
    updated: ctx.workspaces.updateLabel(ctx.spaceId, ctx.workspaceId, ctx.label),
  };
}

const runUpdateWorkspaceLabel = (
  superpipe({
    workspaceMissing: (ctx: UpdateLabelCtx) => ctx.workspace === undefined,
  })('workspace-update-label') as PipelineAPI
)
  .input(['ctx'])
  .pipe(updateLabelLoadWorkspace, 'ctx', 'ctx')
  .pipe('!workspaceMissing', 'ctx')
  .pipe(updateLabelWrite, 'ctx', 'ctx')
  .end('ctx') as (input: UpdateLabelCtx) => UpdateLabelCtx;

interface ResolveSelectionCtx {
  spaces: WorkspaceRegistryReader;
  workspaces: WorkspaceStore;
  io: WorkspaceValidationIo;
  spaceId: string;
  selection: string;
  rows?: SpaceWorkspaceRecord[];
  resolvedPath?: string;
  error?: Error;
}

function selectionRequireNonEmpty(ctx: ResolveSelectionCtx): ResolveSelectionCtx {
  if (ctx.selection.trim() !== '') return ctx;
  return { ...ctx, error: new Error('Workspace selection must not be empty') };
}

function selectionLoadRows(ctx: ResolveSelectionCtx): ResolveSelectionCtx {
  if (!ctx.spaces.getSpace(ctx.spaceId)) {
    return { ...ctx, error: new Error(`Space not found: ${ctx.spaceId}`) };
  }
  return { ...ctx, rows: ctx.workspaces.listBySpace(ctx.spaceId) };
}

function selectionMatchLabel(ctx: ResolveSelectionCtx): ResolveSelectionCtx {
  if (ctx.selection.startsWith('/')) return ctx;
  const exact = ctx.rows!.filter((row) => row.label === ctx.selection);
  const matches =
    exact.length > 0 ? exact : ctx.rows!.filter((row) => row.label === ctx.selection.trim());
  if (matches.length === 1) return { ...ctx, resolvedPath: matches[0].path };
  if (matches.length > 1) {
    const label = matches[0].label;
    const paths = matches.map((row) => row.path).join(', ');
    return {
      ...ctx,
      error: new Error(
        `Ambiguous workspace label "${label}" for space ${ctx.spaceId}: it matches ${matches.length} registered workspaces (${paths}). Use the workspace path instead.`
      ),
    };
  }
  return ctx;
}

function selectionWorkspaceChoices(ctx: ResolveSelectionCtx): string {
  const entries = ctx.rows!.map((row) => (row.label ? `"${row.label}" (${row.path})` : row.path));
  const primary = ctx.spaces.getSpace(ctx.spaceId)?.workspacePath;
  if (primary && !ctx.rows!.some((row) => row.path === primary)) {
    entries.push(`${primary} (primary)`);
  }
  return entries.length > 0 ? entries.join(', ') : '(none)';
}

function selectionUnknownError(ctx: ResolveSelectionCtx, cause: string): Error {
  return new Error(
    `Unknown workspace "${ctx.selection}" for space ${ctx.spaceId}: ${cause}. Registered workspaces: ${selectionWorkspaceChoices(ctx)}`
  );
}

async function selectionResolveAsPath(ctx: ResolveSelectionCtx): Promise<ResolveSelectionCtx> {
  if (!ctx.selection.startsWith('/')) {
    return {
      ...ctx,
      error: selectionUnknownError(
        ctx,
        'not a registered workspace label and not an absolute path'
      ),
    };
  }
  const result = await runResolveRegisteredWorkspace({
    spaces: ctx.spaces,
    workspaces: ctx.workspaces,
    io: ctx.io,
    spaceId: ctx.spaceId,
    rawPath: ctx.selection,
  });
  if (!result.error) return { ...ctx, resolvedPath: result.registeredPath };
  return { ...ctx, error: selectionUnknownError(ctx, result.error.message) };
}

const runResolveWorkspaceSelection = (
  superpipe({
    hasError: (ctx: ResolveSelectionCtx) => ctx.error !== undefined,
    hasResolvedPath: (ctx: ResolveSelectionCtx) => ctx.resolvedPath !== undefined,
  })('workspace-selection-resolution') as PipelineAPI
)
  .input(['ctx'])
  .pipe(selectionRequireNonEmpty, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(selectionLoadRows, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(selectionMatchLabel, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe('!hasResolvedPath', 'ctx')
  .pipe(selectionResolveAsPath, 'ctx', 'ctx')
  .endAsync('ctx') as (input: ResolveSelectionCtx) => Promise<ResolveSelectionCtx>;

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
      transaction: this.deps.transaction,
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
      taskReferences: this.deps.taskReferences,
      goalReferences: this.deps.goalReferences,
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

  async resolveRegisteredWorkspacePath(spaceId: string, rawPath: string): Promise<string> {
    const result = await runResolveRegisteredWorkspace({
      spaces: this.deps.spaces,
      workspaces: this.deps.workspaces,
      io: this.deps.io ?? nodeWorkspaceValidationIo,
      spaceId,
      rawPath,
    });
    if (result.error) throw result.error;
    if (!result.registeredPath) {
      throw new Error(`Workspace path is not registered to space: ${rawPath}`);
    }
    return result.registeredPath;
  }

  updateWorkspaceLabel(spaceId: string, workspaceId: string, label: string): boolean {
    const result = runUpdateWorkspaceLabel({
      workspaces: this.deps.workspaces,
      spaceId,
      workspaceId,
      label,
      updated: false,
    });
    return result.updated;
  }

  async resolveWorkspaceSelection(spaceId: string, selection: string): Promise<string> {
    const result = await runResolveWorkspaceSelection({
      spaces: this.deps.spaces,
      workspaces: this.deps.workspaces,
      io: this.deps.io ?? nodeWorkspaceValidationIo,
      spaceId,
      selection,
    });
    if (result.error) throw result.error;
    if (!result.resolvedPath) {
      throw new Error(`Unknown workspace: ${selection}`);
    }
    return result.resolvedPath;
  }
}
