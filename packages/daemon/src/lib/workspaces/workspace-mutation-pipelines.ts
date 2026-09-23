import superpipe, { type PipelineAPI } from 'superpipe';
import type { SpaceWorkspaceRecord } from '../../storage/repositories/space-workspace-repository.ts';
import {
  checkWorkspaceRegistryGates,
  validateWorkspaceRegistration,
  type WorkspaceRegistrySnapshot,
  type WorkspaceValidationIo,
  type WorkspaceValidationVerdict,
} from './validation-pipeline.ts';
import { admitWorkspaceLabel } from './workspace-label.ts';
import {
  buildRegistrySnapshot,
  WorkspaceRegistrationError,
  type WorkspaceGoalReferences,
  type WorkspaceRegistryReader,
  WorkspaceRemovalBlockedError,
  type WorkspaceSessionReferences,
  type WorkspaceStore,
  type WorkspaceTaskReferences,
} from './workspace-registry.ts';

export interface RegisterWorkspaceCtx {
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

function registerAdmitLabel(ctx: RegisterWorkspaceCtx): RegisterWorkspaceCtx {
  const admitted = admitWorkspaceLabel(ctx.label, ctx.workspaces.listBySpace(ctx.spaceId));
  if ('reason' in admitted) return { ...ctx, error: new Error(admitted.reason) };
  return { ...ctx, label: admitted.value };
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

export const runRegisterWorkspace = (
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
  .pipe(registerAdmitLabel, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(registerInsertWorkspace, 'ctx', 'ctx')
  .endAsync('ctx') as (input: RegisterWorkspaceCtx) => Promise<RegisterWorkspaceCtx>;

export interface RemoveWorkspaceCtx {
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

export const runRemoveWorkspace = (
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

export interface UpdateLabelCtx {
  workspaces: WorkspaceStore;
  spaceId: string;
  workspaceId: string;
  label: string;
  workspace?: SpaceWorkspaceRecord;
  updated: boolean;
  error?: Error;
}

function updateLabelLoadWorkspace(ctx: UpdateLabelCtx): UpdateLabelCtx {
  const workspace = ctx.workspaces.getById(ctx.workspaceId);
  if (!workspace || workspace.spaceId !== ctx.spaceId) return ctx;
  return { ...ctx, workspace };
}

function updateLabelAdmit(ctx: UpdateLabelCtx): UpdateLabelCtx {
  const admitted = admitWorkspaceLabel(
    ctx.label,
    ctx.workspaces.listBySpace(ctx.spaceId),
    ctx.workspaceId
  );
  if ('reason' in admitted) return { ...ctx, error: new Error(admitted.reason) };
  return { ...ctx, label: admitted.value };
}

function updateLabelWrite(ctx: UpdateLabelCtx): UpdateLabelCtx {
  return {
    ...ctx,
    updated: ctx.workspaces.updateLabel(ctx.spaceId, ctx.workspaceId, ctx.label),
  };
}

export const runUpdateWorkspaceLabel = (
  superpipe({
    workspaceMissing: (ctx: UpdateLabelCtx) => ctx.workspace === undefined,
    labelRejected: (ctx: UpdateLabelCtx) => ctx.error !== undefined,
  })('workspace-update-label') as PipelineAPI
)
  .input(['ctx'])
  .pipe(updateLabelLoadWorkspace, 'ctx', 'ctx')
  .pipe('!workspaceMissing', 'ctx')
  .pipe(updateLabelAdmit, 'ctx', 'ctx')
  .pipe('!labelRejected', 'ctx')
  .pipe(updateLabelWrite, 'ctx', 'ctx')
  .end('ctx') as (input: UpdateLabelCtx) => UpdateLabelCtx;
