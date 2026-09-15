import superpipe, { type PipelineAPI } from 'superpipe';
import type { Space } from '@hyperneo/shared';
import type { SpaceWorkspaceRecord } from '../../storage/repositories/space-workspace-repository.ts';
import type { WorkspaceRegistrySnapshot, WorkspaceValidationIo } from './validation-pipeline.ts';
import {
  buildRegistrySnapshot,
  type WorkspaceRegistryReader,
  type WorkspaceStore,
} from './workspace-registry.ts';

export interface ListWorkspacesCtx {
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

export const runListWorkspaces = (
  superpipe({
    hasError: (ctx: ListWorkspacesCtx) => ctx.error !== undefined,
  })('workspace-listing') as PipelineAPI
)
  .input(['ctx'])
  .pipe(listLoadSpace, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(listWorkspaceRows, 'ctx', 'ctx')
  .end('ctx') as (input: ListWorkspacesCtx) => ListWorkspacesCtx;

export interface ResolveWorkspaceCtx {
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

export const runResolveRegisteredWorkspace = (
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

export interface ResolveSelectionCtx {
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

export const runResolveWorkspaceSelection = (
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

export interface ValidateDefaultTaskWorkspaceCtx {
  spaces: WorkspaceRegistryReader;
  workspaces: WorkspaceStore;
  io: WorkspaceValidationIo;
  spaceId: string;
  space?: Space | null;
  rows?: SpaceWorkspaceRecord[];
  distinctPaths?: Set<string>;
  blockedMessage?: string;
}

function defaultTaskWorkspaceLoadSpace(
  ctx: ValidateDefaultTaskWorkspaceCtx
): ValidateDefaultTaskWorkspaceCtx {
  return { ...ctx, space: ctx.spaces.getSpace(ctx.spaceId) };
}

function defaultTaskWorkspaceCountPaths(
  ctx: ValidateDefaultTaskWorkspaceCtx
): ValidateDefaultTaskWorkspaceCtx {
  const space = ctx.space;
  if (!space) return ctx;
  const rows = ctx.workspaces.listBySpace(ctx.spaceId);
  const distinctPaths = new Set(rows.map((row) => row.path));
  if (!rows.some((row) => row.isPrimary) && space.workspacePath) {
    distinctPaths.add(space.workspacePath);
  }
  return { ...ctx, rows, distinctPaths };
}

async function defaultTaskWorkspaceGuardPrimaryUsable(
  ctx: ValidateDefaultTaskWorkspaceCtx
): Promise<ValidateDefaultTaskWorkspaceCtx> {
  const space = ctx.space;
  if (!space || !ctx.distinctPaths || ctx.distinctPaths.size <= 1) return ctx;
  if (await ctx.io.canHostTaskWorktree(space.workspacePath)) return ctx;
  const usable: string[] = [];
  for (const row of ctx.rows ?? []) {
    if (row.path === space.workspacePath) continue;
    if (await ctx.io.canHostTaskWorktree(row.path)) {
      usable.push(row.label ? `"${row.label}" (${row.path})` : row.path);
    }
  }
  const guidance =
    usable.length > 0
      ? ` Create the task with an explicit "workspace" parameter (usable workspaces: ${usable.join(', ')}).`
      : ' No registered workspace of this space can currently host a task worktree; register or repair a git-repository workspace and pass it as the explicit "workspace" parameter.';
  return {
    ...ctx,
    blockedMessage:
      `Space ${ctx.spaceId} has ${ctx.distinctPaths.size} registered workspaces and its ` +
      `primary workspace ${space.workspacePath} is not a git repository, so tasks created ` +
      `without an explicit workspace cannot spawn (their task worktree would fail to be ` +
      `created there).${guidance}`,
  };
}

export const runValidateDefaultTaskWorkspace = (
  superpipe({
    hasBlockedMessage: (ctx: ValidateDefaultTaskWorkspaceCtx) => ctx.blockedMessage !== undefined,
  })('default-task-workspace-validation') as PipelineAPI
)
  .input(['ctx'])
  .pipe(defaultTaskWorkspaceLoadSpace, 'ctx', 'ctx')
  .pipe(defaultTaskWorkspaceCountPaths, 'ctx', 'ctx')
  .pipe(defaultTaskWorkspaceGuardPrimaryUsable, 'ctx', 'ctx')
  .endAsync('ctx') as (
  input: ValidateDefaultTaskWorkspaceCtx
) => Promise<ValidateDefaultTaskWorkspaceCtx>;
