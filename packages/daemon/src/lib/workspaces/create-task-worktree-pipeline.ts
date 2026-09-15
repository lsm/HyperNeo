import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import type { SpaceWorktreeRepository } from '../../storage/repositories/space-worktree-repository.ts';
import type { Logger } from '../logger.ts';
import { MAX_NETWORK_RETRIES, NETWORK_RETRY_DELAYS_MS } from '../space/runtime/constants.ts';
import { retryWithBackoff } from '../utils/retry-utils.ts';
import { worktreeSlug } from '../space/worktree-slug.ts';
import { getWorktreeBaseDir } from '../worktree-path-utils.ts';
import { nodeWorkspaceValidationIo } from './validation-pipeline.ts';
import {
  isLiveRegisteredWorktree,
  legacyWorktreeDirs,
  listWorktreeDirSlugs,
  readWorktreeClaim,
  registeredWorktreePaths,
  resolveRepoRoot,
  worktreeCurrentBranch,
  writeWorktreeClaim,
} from './worktree-git-probes.ts';

export interface CreateTaskWorktreeCtx {
  worktreeRepo: SpaceWorktreeRepository;
  spaceRepo: SpaceRepository;
  logger: Logger;
  spaceId: string;
  taskId: string;
  taskTitle: string;
  taskNumber: number;
  baseBranch?: string;
  repoRoot?: string;
  workspacePath?: string;
  repo?: { commandCwd: string; dirKey: string };
  worktreesDir?: string;
  slug?: string;
  worktreePath?: string;
  branchName?: string;
  result?: { path: string; slug: string };
}

function createLoadSpace(ctx: CreateTaskWorktreeCtx): CreateTaskWorktreeCtx {
  const space = ctx.spaceRepo.getSpace(ctx.spaceId);
  if (!space) {
    throw new Error(`Space not found: ${ctx.spaceId}`);
  }
  return { ...ctx, workspacePath: space.workspacePath };
}

function createResolveRepo(ctx: CreateTaskWorktreeCtx): CreateTaskWorktreeCtx {
  return { ...ctx, repo: resolveRepoRoot(ctx.repoRoot ?? ctx.workspacePath!) };
}

export class WorkspaceNotGitRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceNotGitRepositoryError';
  }
}

async function createAssertGitRepoRoot(ctx: CreateTaskWorktreeCtx): Promise<CreateTaskWorktreeCtx> {
  const repoRoot = ctx.repoRoot ?? ctx.workspacePath!;
  const commandCwd = ctx.repo!.commandCwd;
  if (await nodeWorkspaceValidationIo.canHostTaskWorktree(commandCwd)) return ctx;
  throw new WorkspaceNotGitRepositoryError(
    `Workspace is not a git repository: ${repoRoot} (resolved as ${commandCwd}); ` +
      `task worktrees can only be created inside a registered git repository`
  );
}

function createFindExistingRecord(ctx: CreateTaskWorktreeCtx): CreateTaskWorktreeCtx {
  const existing = ctx.worktreeRepo.getByTaskId(ctx.spaceId, ctx.taskId);
  if (existing) {
    return { ...ctx, result: { path: existing.path, slug: existing.slug } };
  }
  return ctx;
}

function createEnsureWorktreesDir(ctx: CreateTaskWorktreeCtx): CreateTaskWorktreeCtx {
  const worktreesDir = getWorktreeBaseDir(ctx.repo!.dirKey, (msg) => ctx.logger.warn(msg));
  if (!existsSync(worktreesDir)) {
    mkdirSync(worktreesDir, { recursive: true });
  }
  return { ...ctx, worktreesDir };
}

function createWriteRepoCwdSentinel(ctx: CreateTaskWorktreeCtx): CreateTaskWorktreeCtx {
  try {
    writeFileSync(join(ctx.worktreesDir!, '..', '.hyperneo-repo-cwd'), ctx.repo!.commandCwd);
  } catch {}
  return ctx;
}

function isForeignLiveWorktreeDir(
  registered: Set<string>,
  worktreePath: string,
  spaceId: string,
  taskId: string
): boolean {
  let real: string | null = null;
  try {
    real = realpathSync(worktreePath);
  } catch {
    return false;
  }
  if (!registered.has(real)) return false;
  const claim = readWorktreeClaim(worktreePath);
  return !(claim?.spaceId === spaceId && claim.taskId === taskId);
}

function createComputeSlug(ctx: CreateTaskWorktreeCtx): CreateTaskWorktreeCtx {
  const legacyDirs = legacyWorktreeDirs(ctx.worktreeRepo, ctx.repo!, dirname(ctx.worktreesDir!));
  const slugPrefixes = [
    `${ctx.worktreesDir!}${sep}`,
    ...legacyDirs.map((dir) => join(dir, 'worktrees') + sep),
  ];
  const currentDir = ctx.worktreesDir!;
  const registered = registeredWorktreePaths(ctx.repo!.commandCwd);
  const existingSlugs = [
    ...ctx.worktreeRepo.listSlugs(ctx.spaceId),
    ...slugPrefixes.flatMap((prefix) => ctx.worktreeRepo.listSlugsUnderPath(prefix)),
    ...legacyDirs.flatMap((dir) => listWorktreeDirSlugs(join(dir, 'worktrees'))),
    ...listWorktreeDirSlugs(currentDir).filter((name) =>
      isForeignLiveWorktreeDir(registered, join(currentDir, name), ctx.spaceId, ctx.taskId)
    ),
  ];
  return { ...ctx, slug: worktreeSlug(ctx.taskTitle, ctx.taskNumber, existingSlugs) };
}

function createDeriveTarget(ctx: CreateTaskWorktreeCtx): CreateTaskWorktreeCtx {
  return {
    ...ctx,
    worktreePath: join(ctx.worktreesDir!, ctx.slug!),
    branchName: `space/${ctx.slug}`,
  };
}

function createRecoverStaleTarget(ctx: CreateTaskWorktreeCtx): CreateTaskWorktreeCtx {
  const repo = ctx.repo!;
  const worktreePath = ctx.worktreePath!;
  const branchName = ctx.branchName!;
  if (existsSync(worktreePath)) {
    if (isLiveRegisteredWorktree(repo.commandCwd, worktreePath)) {
      const claim = readWorktreeClaim(worktreePath);
      const currentBranch = worktreeCurrentBranch(worktreePath);
      if (
        claim?.spaceId === ctx.spaceId &&
        claim.taskId === ctx.taskId &&
        currentBranch === branchName
      ) {
        ctx.logger.warn(
          `Adopting orphaned worktree at ${worktreePath} left by a crashed creation for task ${ctx.taskId}`
        );
        ctx.worktreeRepo.create({
          spaceId: ctx.spaceId,
          taskId: ctx.taskId,
          slug: ctx.slug!,
          path: worktreePath,
        });
        return { ...ctx, result: { path: worktreePath, slug: ctx.slug! } };
      }
      throw new Error(
        `Worktree path ${worktreePath} is already in use by a live registered worktree; refusing to recreate it for task ${ctx.taskId}`
      );
    }
    ctx.logger.warn(
      `Stale worktree directory detected at ${worktreePath} — removing before recreating`
    );
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: repo.commandCwd,
        timeout: 30_000,
      });
    } catch {
      if (!isLiveRegisteredWorktree(repo.commandCwd, worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    }
  }
  return ctx;
}

function createPruneWorktrees(ctx: CreateTaskWorktreeCtx): CreateTaskWorktreeCtx {
  try {
    execFileSync('git', ['worktree', 'prune'], {
      cwd: ctx.repo!.commandCwd,
      timeout: 30_000,
    });
  } catch {}
  return ctx;
}

function createCleanupStaleBranch(ctx: CreateTaskWorktreeCtx): CreateTaskWorktreeCtx {
  const branchName = ctx.branchName!;
  try {
    const branches = execFileSync('git', ['branch', '--list', branchName], {
      cwd: ctx.repo!.commandCwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (branches.trim().length > 0) {
      ctx.logger.warn(`Stale branch detected: ${branchName} — deleting before recreating`);
      execFileSync('git', ['branch', '-D', branchName], {
        cwd: ctx.repo!.commandCwd,
        timeout: 30_000,
      });
    }
  } catch (err) {
    ctx.logger.warn(
      `Failed to clean up stale branch ${branchName}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return ctx;
}

async function createAddWorktree(ctx: CreateTaskWorktreeCtx): Promise<CreateTaskWorktreeCtx> {
  const repo = ctx.repo!;
  const worktreePath = ctx.worktreePath!;
  const branchName = ctx.branchName!;
  try {
    await retryWithBackoff(
      () =>
        Promise.resolve(
          execFileSync(
            'git',
            ['worktree', 'add', worktreePath, '-b', branchName, ctx.baseBranch ?? 'HEAD'],
            {
              cwd: repo.commandCwd,
              timeout: 30_000,
              stdio: 'pipe',
            }
          )
        ),
      {
        maxRetries: MAX_NETWORK_RETRIES,
        delaysMs: NETWORK_RETRY_DELAYS_MS,
        isRetryable: (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('already exists')) return false;
          if (msg.toLowerCase().includes('fatal:')) return false;
          return true;
        },
        onRetry: (attempt, err) => {
          ctx.logger.warn(
            `git worktree add failed (attempt ${attempt}), retrying: ` +
              `${err instanceof Error ? err.message : String(err)}`
          );
        },
      }
    );
  } catch (err) {
    if (existsSync(worktreePath) && !isLiveRegisteredWorktree(repo.commandCwd, worktreePath)) {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {}
    }
    throw new Error(
      `Failed to create worktree for task ${ctx.taskId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return ctx;
}

function createPersistWorktree(ctx: CreateTaskWorktreeCtx): CreateTaskWorktreeCtx {
  writeWorktreeClaim(ctx.worktreePath!, ctx.spaceId, ctx.taskId);
  ctx.worktreeRepo.create({
    spaceId: ctx.spaceId,
    taskId: ctx.taskId,
    slug: ctx.slug!,
    path: ctx.worktreePath!,
  });
  ctx.logger.info(
    `Created worktree for task ${ctx.taskId} at ${ctx.worktreePath} (branch: ${ctx.branchName})`
  );
  return { ...ctx, result: { path: ctx.worktreePath!, slug: ctx.slug! } };
}

export const runCreateTaskWorktree = (
  superpipe({
    hasResult: (ctx: CreateTaskWorktreeCtx) => ctx.result !== undefined,
  })('create-task-worktree') as PipelineAPI
)
  .input(['ctx'])
  .pipe(createLoadSpace, 'ctx', 'ctx')
  .pipe(createResolveRepo, 'ctx', 'ctx')
  .pipe(createFindExistingRecord, 'ctx', 'ctx')
  .pipe('!hasResult', 'ctx')
  .pipe(createAssertGitRepoRoot, 'ctx', 'ctx')
  .pipe(createEnsureWorktreesDir, 'ctx', 'ctx')
  .pipe(createWriteRepoCwdSentinel, 'ctx', 'ctx')
  .pipe(createComputeSlug, 'ctx', 'ctx')
  .pipe(createDeriveTarget, 'ctx', 'ctx')
  .pipe(createRecoverStaleTarget, 'ctx', 'ctx')
  .pipe('!hasResult', 'ctx')
  .pipe(createPruneWorktrees, 'ctx', 'ctx')
  .pipe(createCleanupStaleBranch, 'ctx', 'ctx')
  .pipe(createAddWorktree, 'ctx', 'ctx')
  .pipe(createPersistWorktree, 'ctx', 'ctx')
  .endAsync('ctx') as (input: CreateTaskWorktreeCtx) => Promise<CreateTaskWorktreeCtx>;
