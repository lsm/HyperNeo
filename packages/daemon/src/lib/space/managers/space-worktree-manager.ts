import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import { SpaceWorktreeRepository } from '../../../storage/repositories/space-worktree-repository.ts';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import { Logger } from '../../logger.ts';
import {
  encodeRepoPath,
  getProjectShortKey,
  getWorktreeBaseDir,
} from '../../worktree-path-utils.ts';
import { MAX_NETWORK_RETRIES, NETWORK_RETRY_DELAYS_MS } from '../runtime/constants.ts';
import { retryWithBackoff } from '../runtime/retry-utils.ts';
import { worktreeSlug } from '../worktree-slug.ts';

export interface SpaceWorktreeInfo {
  slug: string;
  taskId: string;
  path: string;
}

function resolveRepoRoot(repoRoot: string): { commandCwd: string; dirKey: string } {
  let cwdRoot = repoRoot;
  try {
    cwdRoot = realpathSync(repoRoot);
  } catch {
    return { commandCwd: repoRoot, dirKey: repoRoot };
  }
  let commonDir = '';
  try {
    const commonDirRaw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: cwdRoot,
      encoding: 'utf8',
      timeout: 30_000,
    }).replace(/\n$/, '');
    if (commonDirRaw) {
      commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(cwdRoot, commonDirRaw);
    }
  } catch {}
  if (!commonDir) {
    return { commandCwd: cwdRoot, dirKey: cwdRoot };
  }
  try {
    const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: cwdRoot,
      encoding: 'utf8',
      timeout: 30_000,
    }).replace(/\n$/, '');
    return { commandCwd: topLevel || cwdRoot, dirKey: projectDirKey(commonDir) };
  } catch {
    return { commandCwd: cwdRoot, dirKey: projectDirKey(commonDir) };
  }
}

function projectDirKey(commonDir: string): string {
  return basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
}

function legacyWorktreeDirs(
  worktreeRepo: SpaceWorktreeRepository,
  repo: { commandCwd: string; dirKey: string },
  currentProjectDir: string
): string[] {
  const candidates = new Set<string>();
  for (const path of worktreeRepo.listPaths()) {
    const projectDir = dirname(dirname(path));
    if (projectDir !== currentProjectDir) candidates.add(projectDir);
  }
  const legacyDirKey = join(repo.dirKey, '.git');
  for (const key of [getProjectShortKey(legacyDirKey), encodeRepoPath(legacyDirKey)]) {
    const derivedLegacyProjectDir = join(dirname(currentProjectDir), key);
    if (derivedLegacyProjectDir !== currentProjectDir) candidates.add(derivedLegacyProjectDir);
  }
  const dirs: string[] = [];
  for (const projectDir of candidates) {
    const sentinel = join(projectDir, '.hyperneo-repo-root');
    if (!existsSync(sentinel)) continue;
    try {
      const stored = readFileSync(sentinel, 'utf8');
      if (stored && legacySentinelMatches(stored, repo.dirKey)) dirs.push(projectDir);
    } catch {}
  }
  return dirs;
}

function legacySentinelMatches(stored: string, dirKey: string): boolean {
  if (stored === dirKey || stored === join(dirKey, '.git')) return true;
  return resolveRepoRoot(stored).dirKey === dirKey;
}

function listWorktreeDirSlugs(worktreesDir: string): string[] {
  try {
    return readdirSync(worktreesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function worktreeGitDir(worktreePath: string): string | null {
  try {
    const raw = readFileSync(join(worktreePath, '.git'), 'utf8').trim();
    const gitdir = raw.startsWith('gitdir:') ? raw.slice('gitdir:'.length).trim() : '';
    if (!gitdir) return null;
    return isAbsolute(gitdir) ? gitdir : resolve(worktreePath, gitdir);
  } catch {
    return null;
  }
}

function writeWorktreeClaim(worktreePath: string, spaceId: string, taskId: string): void {
  const gitdir = worktreeGitDir(worktreePath);
  if (!gitdir) return;
  try {
    writeFileSync(join(gitdir, 'hyperneo-claim'), `${spaceId}\n${taskId}`);
  } catch {}
}

function readWorktreeClaim(worktreePath: string): { spaceId: string; taskId: string } | null {
  const gitdir = worktreeGitDir(worktreePath);
  if (!gitdir) return null;
  try {
    const raw = readFileSync(join(gitdir, 'hyperneo-claim'), 'utf8').trim();
    const [spaceId, taskId] = raw.split('\n');
    if (spaceId && taskId) return { spaceId, taskId };
  } catch {}
  return null;
}

function worktreeCurrentBranch(worktreePath: string): string | null {
  try {
    return execFileSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 30_000,
    }).trim();
  } catch {
    return null;
  }
}

function registeredWorktreePaths(commandCwd: string): Set<string> {
  try {
    const list = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], {
      cwd: commandCwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const paths = new Set<string>();
    for (const record of list.split('\0')) {
      if (!record.startsWith('worktree ')) continue;
      try {
        paths.add(realpathSync(record.slice('worktree '.length)));
      } catch {}
    }
    return paths;
  } catch {
    return new Set<string>();
  }
}

function isRegisteredWorktree(commandCwd: string, worktreePath: string): boolean {
  let target: string | null = null;
  try {
    target = realpathSync(worktreePath);
  } catch {
    return false;
  }
  return registeredWorktreePaths(commandCwd).has(target);
}

function isLiveRegisteredWorktree(commandCwd: string, worktreePath: string): boolean {
  return existsSync(join(worktreePath, '.git')) && isRegisteredWorktree(commandCwd, worktreePath);
}

interface CreateTaskWorktreeCtx {
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

const runCreateTaskWorktree = (
  superpipe({
    hasResult: (ctx: CreateTaskWorktreeCtx) => ctx.result !== undefined,
  })('create-task-worktree') as PipelineAPI
)
  .input(['ctx'])
  .pipe(createLoadSpace, 'ctx', 'ctx')
  .pipe(createResolveRepo, 'ctx', 'ctx')
  .pipe(createFindExistingRecord, 'ctx', 'ctx')
  .pipe('!hasResult', 'ctx')
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

export class SpaceWorktreeManager {
  private worktreeRepo: SpaceWorktreeRepository;
  private spaceRepo: SpaceRepository;
  private logger = new Logger('SpaceWorktreeManager');

  constructor(db: BunDatabase) {
    this.worktreeRepo = new SpaceWorktreeRepository(db);
    this.spaceRepo = new SpaceRepository(db);
  }

  async createTaskWorktree(
    spaceId: string,
    taskId: string,
    taskTitle: string,
    taskNumber: number,
    baseBranch?: string,
    repoRoot?: string
  ): Promise<{ path: string; slug: string }> {
    const ctx = await runCreateTaskWorktree({
      worktreeRepo: this.worktreeRepo,
      spaceRepo: this.spaceRepo,
      logger: this.logger,
      spaceId,
      taskId,
      taskTitle,
      taskNumber,
      baseBranch,
      repoRoot,
    });
    return ctx.result!;
  }

  private resolveWorktreeRepoRoot(worktreePath: string, fallback: string): string {
    const projectDir = dirname(dirname(worktreePath));
    let storedKey: string | undefined;
    const sentinel = join(projectDir, '.hyperneo-repo-root');
    if (existsSync(sentinel)) {
      try {
        const stored = readFileSync(sentinel, 'utf8');
        if (stored) storedKey = stored;
      } catch {}
    }
    const commandCwdSentinel = join(projectDir, '.hyperneo-repo-cwd');
    if (existsSync(commandCwdSentinel)) {
      try {
        const stored = readFileSync(commandCwdSentinel, 'utf8');
        if (stored && existsSync(stored)) {
          if (!storedKey || resolveRepoRoot(stored).dirKey === resolveRepoRoot(storedKey).dirKey) {
            return stored;
          }
        }
      } catch {}
    }
    if (storedKey && existsSync(storedKey)) return storedKey;
    const gitLink = join(worktreePath, '.git');
    if (existsSync(gitLink)) {
      try {
        const raw = readFileSync(gitLink, 'utf8').trim();
        const gitdir = raw.startsWith('gitdir:') ? raw.slice('gitdir:'.length).trim() : '';
        if (gitdir) {
          const absolute = isAbsolute(gitdir) ? gitdir : resolve(worktreePath, gitdir);
          const repoRoot = dirname(dirname(dirname(absolute)));
          if (repoRoot && repoRoot !== '.') return repoRoot;
        }
      } catch {}
    }
    return fallback;
  }

  async removeTaskWorktree(spaceId: string, taskId: string): Promise<void> {
    const record = this.worktreeRepo.getByTaskId(spaceId, taskId);
    if (!record) {
      return;
    }

    const space = this.spaceRepo.getSpace(spaceId);
    if (!space) {
      this.worktreeRepo.delete(spaceId, taskId);
      return;
    }

    const gitRoot = this.resolveWorktreeRepoRoot(record.path, space.workspacePath);

    try {
      execFileSync('git', ['worktree', 'remove', record.path, '--force'], {
        cwd: gitRoot,
        timeout: 30_000,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to remove git worktree at ${record.path} (continuing with cleanup): ${err instanceof Error ? err.message : String(err)}`
      );
      if (!existsSync(gitRoot) && existsSync(record.path)) {
        try {
          rmSync(record.path, { recursive: true, force: true });
        } catch {}
      }
    }

    try {
      execFileSync('git', ['worktree', 'prune'], {
        cwd: gitRoot,
        timeout: 30_000,
      });
    } catch {}

    const branchName = `space/${record.slug}`;
    try {
      execFileSync('git', ['branch', '-D', branchName], {
        cwd: gitRoot,
        timeout: 30_000,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to delete branch ${branchName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    this.worktreeRepo.delete(spaceId, taskId);
    this.logger.info(`Removed worktree for task ${taskId} (branch: ${branchName})`);
  }

  markTaskWorktreeCompleted(spaceId: string, taskId: string): void {
    this.worktreeRepo.markCompleted(spaceId, taskId);
  }

  async reapExpiredWorktrees(ttlMs: number = 7 * 24 * 60 * 60 * 1000): Promise<void> {
    const cutoff = Date.now() - ttlMs;
    const expired = this.worktreeRepo.listCompletedBefore(cutoff);

    for (const record of expired) {
      try {
        await this.removeTaskWorktree(record.spaceId, record.taskId);
        this.logger.info(
          `TTL reaper: removed expired worktree for task ${record.taskId} (completed_at: ${record.completedAt})`
        );
      } catch (err) {
        this.logger.warn(
          `TTL reaper: failed to remove worktree for task ${record.taskId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (expired.length > 0) {
      this.logger.info(`TTL reaper: removed ${expired.length} expired worktree(s)`);
    }
  }

  async getTaskWorktreePath(spaceId: string, taskId: string): Promise<string | null> {
    return this.getTaskWorktreePathSync(spaceId, taskId);
  }

  getTaskWorktreePathSync(spaceId: string, taskId: string): string | null {
    const record = this.worktreeRepo.getByTaskId(spaceId, taskId);
    return record?.path ?? null;
  }

  async listWorktrees(spaceId: string): Promise<SpaceWorktreeInfo[]> {
    const records = this.worktreeRepo.listBySpace(spaceId);
    return records.map((r) => ({ slug: r.slug, taskId: r.taskId, path: r.path }));
  }

  async cleanupOrphaned(spaceId: string): Promise<void> {
    const records = this.worktreeRepo.listBySpace(spaceId);
    const space = this.spaceRepo.getSpace(spaceId);

    for (const record of records) {
      if (!existsSync(record.path)) {
        if (space) {
          const gitRoot = this.resolveWorktreeRepoRoot(record.path, space.workspacePath);
          const branchName = `space/${record.slug}`;
          try {
            execFileSync('git', ['worktree', 'prune'], {
              cwd: gitRoot,
              timeout: 30_000,
            });
          } catch {}
          try {
            execFileSync('git', ['branch', '-D', branchName], {
              cwd: gitRoot,
              timeout: 30_000,
            });
          } catch {}
        }
        this.worktreeRepo.delete(spaceId, record.taskId);
        this.logger.info(
          `Cleaned up orphaned worktree record for task ${record.taskId} (path was: ${record.path})`
        );
      }
    }

    if (space) {
      try {
        execFileSync('git', ['worktree', 'prune'], {
          cwd: space.workspacePath,
          timeout: 30_000,
        });
      } catch (err) {
        this.logger.warn(
          `git worktree prune failed for space ${spaceId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
}
