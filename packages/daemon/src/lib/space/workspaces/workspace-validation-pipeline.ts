import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import superpipe, { type PipelineAPI } from 'superpipe';

const execAsync = promisify(exec);

export const MAX_WORKSPACES_PER_SPACE = 8;

export type WorkspaceClaimSource = 'space_primary_path' | 'registered_workspace';

export interface WorkspaceRegistryClaim {
  spaceId: string;
  path: string;
  source: WorkspaceClaimSource;
}

export interface WorkspaceRegistrySnapshot {
  claims: readonly WorkspaceRegistryClaim[];
  workspaceCountForSpace: number;
}

export interface WorkspaceRegistrationInput {
  spaceId: string;
  rawPath: string;
}

export interface WorkspaceValidationIo {
  realpath(path: string): Promise<string>;
  isDirectory(path: string): Promise<boolean>;
  isGitRepositoryRoot(path: string): Promise<boolean>;
}

export type WorkspaceRejectionReason =
  | 'path_not_found'
  | 'path_not_a_directory'
  | 'not_a_git_repository_root'
  | 'path_claimed_by_another_space'
  | 'duplicate_of_registered_workspace'
  | 'ambiguous_nesting'
  | 'workspace_cap_reached';

export interface WorkspaceValidationRejection {
  accepted: false;
  reason: WorkspaceRejectionReason;
  message: string;
  canonicalPath: string | null;
  conflictPath?: string;
  conflictSpaceId?: string;
  nestingDirection?: 'candidate_inside_existing' | 'existing_inside_candidate';
  limit?: number;
}

export type WorkspaceValidationVerdict =
  | { accepted: true; canonicalPath: string }
  | WorkspaceValidationRejection;

interface WorkspaceValidationCtx extends WorkspaceRegistrationInput {
  io: WorkspaceValidationIo;
  snapshot: WorkspaceRegistrySnapshot;
  canonicalPath?: string;
  verdict?: WorkspaceValidationVerdict;
}

export const nodeWorkspaceValidationIo: WorkspaceValidationIo = {
  async realpath(path) {
    return fs.realpath(path);
  },
  async isDirectory(path) {
    try {
      return (await fs.stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
  async isGitRepositoryRoot(path) {
    try {
      const env = { ...process.env };
      const local = await execAsync('git rev-parse --local-env-vars');
      for (const key of local.stdout.split(/\s+/)) {
        if (key) delete env[key];
      }
      const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd: path, env });
      const topLevel = stdout.replace(/\n$/, '');
      if (topLevel === path) return true;
      const [topStat, pathStat] = await Promise.all([fs.stat(topLevel), fs.stat(path)]);
      return topStat.dev === pathStat.dev && topStat.ino === pathStat.ino;
    } catch {
      return false;
    }
  },
};

function containsNestedPath(parent: string, child: string): boolean {
  if (parent === '/') return child !== '/';
  return child.startsWith(`${parent}/`);
}

async function canonicalizeCandidate(ctx: WorkspaceValidationCtx): Promise<WorkspaceValidationCtx> {
  if (!ctx.rawPath.trim()) {
    return {
      ...ctx,
      verdict: {
        accepted: false,
        reason: 'path_not_found',
        message: `Workspace path does not exist: ${ctx.rawPath}`,
        canonicalPath: null,
      },
    };
  }
  try {
    return { ...ctx, canonicalPath: await ctx.io.realpath(ctx.rawPath) };
  } catch {
    return {
      ...ctx,
      verdict: {
        accepted: false,
        reason: 'path_not_found',
        message: `Workspace path does not exist: ${ctx.rawPath}`,
        canonicalPath: null,
      },
    };
  }
}

async function ensureDirectory(ctx: WorkspaceValidationCtx): Promise<WorkspaceValidationCtx> {
  const canonicalPath = ctx.canonicalPath!;
  if (await ctx.io.isDirectory(canonicalPath)) return ctx;
  return {
    ...ctx,
    verdict: {
      accepted: false,
      reason: 'path_not_a_directory',
      message: `Workspace path is not an accessible directory: ${canonicalPath}`,
      canonicalPath,
    },
  };
}

async function ensureGitRepositoryRoot(
  ctx: WorkspaceValidationCtx
): Promise<WorkspaceValidationCtx> {
  const canonicalPath = ctx.canonicalPath!;
  if (await ctx.io.isGitRepositoryRoot(canonicalPath)) return ctx;
  return {
    ...ctx,
    verdict: {
      accepted: false,
      reason: 'not_a_git_repository_root',
      message: `Workspace path is not a git repository root: ${canonicalPath}`,
      canonicalPath,
    },
  };
}

function ensureCrossSpaceExclusivity(ctx: WorkspaceValidationCtx): WorkspaceValidationCtx {
  const canonicalPath = ctx.canonicalPath!;
  const foreign = ctx.snapshot.claims.find(
    (claim) => claim.path === canonicalPath && claim.spaceId !== ctx.spaceId
  );
  if (foreign) {
    return {
      ...ctx,
      verdict: {
        accepted: false,
        reason: 'path_claimed_by_another_space',
        message: `Workspace path is already claimed by space ${foreign.spaceId}: ${canonicalPath}`,
        canonicalPath,
        conflictPath: foreign.path,
        conflictSpaceId: foreign.spaceId,
      },
    };
  }
  const own = ctx.snapshot.claims.find((claim) => claim.path === canonicalPath);
  if (own) {
    return {
      ...ctx,
      verdict: {
        accepted: false,
        reason: 'duplicate_of_registered_workspace',
        message: `Workspace path is already registered to this space: ${canonicalPath}`,
        canonicalPath,
        conflictPath: own.path,
        conflictSpaceId: own.spaceId,
      },
    };
  }
  return ctx;
}

function ensureNoAmbiguousNesting(ctx: WorkspaceValidationCtx): WorkspaceValidationCtx {
  const canonicalPath = ctx.canonicalPath!;
  for (const claim of ctx.snapshot.claims) {
    if (claim.spaceId !== ctx.spaceId || claim.path === canonicalPath) continue;
    if (containsNestedPath(canonicalPath, claim.path)) {
      return {
        ...ctx,
        verdict: {
          accepted: false,
          reason: 'ambiguous_nesting',
          message: `Workspace path contains registered workspace ${claim.path} of the same space`,
          canonicalPath,
          conflictPath: claim.path,
          conflictSpaceId: claim.spaceId,
          nestingDirection: 'existing_inside_candidate',
        },
      };
    }
    if (containsNestedPath(claim.path, canonicalPath)) {
      return {
        ...ctx,
        verdict: {
          accepted: false,
          reason: 'ambiguous_nesting',
          message: `Workspace path is inside registered workspace ${claim.path} of the same space`,
          canonicalPath,
          conflictPath: claim.path,
          conflictSpaceId: claim.spaceId,
          nestingDirection: 'candidate_inside_existing',
        },
      };
    }
  }
  return ctx;
}

function ensureUnderPerSpaceCap(ctx: WorkspaceValidationCtx): WorkspaceValidationCtx {
  if (ctx.snapshot.workspaceCountForSpace < MAX_WORKSPACES_PER_SPACE) return ctx;
  return {
    ...ctx,
    verdict: {
      accepted: false,
      reason: 'workspace_cap_reached',
      message: `Space ${ctx.spaceId} already has ${ctx.snapshot.workspaceCountForSpace} workspaces (limit ${MAX_WORKSPACES_PER_SPACE})`,
      canonicalPath: ctx.canonicalPath!,
      limit: MAX_WORKSPACES_PER_SPACE,
    },
  };
}

function accept(ctx: WorkspaceValidationCtx): WorkspaceValidationCtx {
  return { ...ctx, verdict: { accepted: true, canonicalPath: ctx.canonicalPath! } };
}

function hasVerdict(ctx: WorkspaceValidationCtx): boolean {
  return ctx.verdict !== undefined;
}

const runRegistryGates = (
  superpipe<{ hasVerdict: (ctx: WorkspaceValidationCtx) => boolean }>({
    hasVerdict,
  })('workspace-registry-gates') as PipelineAPI
)
  .input(['ctx'])
  .pipe(ensureCrossSpaceExclusivity, 'ctx', 'ctx')
  .pipe('!hasVerdict', 'ctx')
  .pipe(ensureNoAmbiguousNesting, 'ctx', 'ctx')
  .pipe('!hasVerdict', 'ctx')
  .pipe(ensureUnderPerSpaceCap, 'ctx', 'ctx')
  .pipe('!hasVerdict', 'ctx')
  .end('ctx') as (input: WorkspaceValidationCtx) => WorkspaceValidationCtx;

const run = (
  superpipe<{ hasVerdict: (ctx: WorkspaceValidationCtx) => boolean }>({
    hasVerdict,
  })('workspace-registration-validation') as PipelineAPI
)
  .input(['ctx'])
  .pipe(canonicalizeCandidate, 'ctx', 'ctx')
  .pipe('!hasVerdict', 'ctx')
  .pipe(ensureDirectory, 'ctx', 'ctx')
  .pipe('!hasVerdict', 'ctx')
  .pipe(ensureGitRepositoryRoot, 'ctx', 'ctx')
  .pipe('!hasVerdict', 'ctx')
  .pipe(runRegistryGates, 'ctx', 'ctx')
  .pipe('!hasVerdict', 'ctx')
  .pipe(accept, 'ctx', 'ctx')
  .endAsync('ctx') as (input: WorkspaceValidationCtx) => Promise<WorkspaceValidationCtx>;

export function validateWorkspaceRegistration(
  io: WorkspaceValidationIo,
  snapshot: WorkspaceRegistrySnapshot,
  input: WorkspaceRegistrationInput
): Promise<WorkspaceValidationVerdict> {
  return run({ ...input, io, snapshot }).then(
    (ctx) =>
      ctx.verdict ?? {
        accepted: false,
        reason: 'path_not_found' as const,
        message: 'workspace validation produced no verdict',
        canonicalPath: null,
      }
  );
}

export function checkWorkspaceRegistryGates(
  snapshot: WorkspaceRegistrySnapshot,
  input: { spaceId: string; canonicalPath: string }
): WorkspaceValidationVerdict {
  const ctx = runRegistryGates({
    spaceId: input.spaceId,
    rawPath: input.canonicalPath,
    canonicalPath: input.canonicalPath,
    io: nodeWorkspaceValidationIo,
    snapshot,
  });
  return ctx.verdict ?? { accepted: true, canonicalPath: input.canonicalPath };
}
