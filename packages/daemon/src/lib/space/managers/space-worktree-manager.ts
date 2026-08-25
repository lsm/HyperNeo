import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import { SpaceWorktreeRepository } from '../../../storage/repositories/space-worktree-repository.ts';
import { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import { worktreeSlug } from '../worktree-slug.ts';
import { Logger } from '../../logger.ts';
import { retryWithBackoff } from '../runtime/retry-utils.ts';
import { MAX_NETWORK_RETRIES, NETWORK_RETRY_DELAYS_MS } from '../runtime/constants.ts';
import { getWorktreeBaseDir } from '../../worktree-path-utils.ts';
import { buildGitCommandEnv, buildGitSshEnv } from '../../spawn-env.ts';
import { indexContainsLfsPointer, worktreeDeclaresLfsAttributes } from '../../worktree-lfs.ts';

const execFileAsync = promisify(execFile);

export interface SpaceWorktreeInfo {
  slug: string;
  taskId: string;
  path: string;
}

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
    baseBranch?: string
  ): Promise<{ path: string; slug: string }> {
    const space = this.spaceRepo.getSpace(spaceId);
    if (!space) {
      throw new Error(`Space not found: ${spaceId}`);
    }

    const existing = this.worktreeRepo.getByTaskId(spaceId, taskId);
    if (existing) {
      return { path: existing.path, slug: existing.slug };
    }

    const existingSlugs = this.worktreeRepo.listSlugs(spaceId);
    const slug = worktreeSlug(taskTitle, taskNumber, existingSlugs);

    const worktreesDir = getWorktreeBaseDir(space.workspacePath, (msg) => this.logger.warn(msg));
    if (!existsSync(worktreesDir)) {
      mkdirSync(worktreesDir, { recursive: true });
    }

    const worktreePath = join(worktreesDir, slug);
    const branchName = `space/${slug}`;

    if (existsSync(worktreePath)) {
      this.logger.warn(
        `Stale worktree directory detected at ${worktreePath} — removing before recreating`
      );
      try {
        execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
          cwd: space.workspacePath,
          timeout: 30_000,
          env: buildGitCommandEnv(),
        });
      } catch {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    }

    try {
      execFileSync('git', ['worktree', 'prune'], {
        cwd: space.workspacePath,
        timeout: 30_000,
        env: buildGitCommandEnv(),
      });
    } catch {}

    try {
      const branches = execFileSync('git', ['branch', '--list', branchName], {
        cwd: space.workspacePath,
        encoding: 'utf8',
        timeout: 30_000,
        env: buildGitCommandEnv(),
      });
      if (branches.trim().length > 0) {
        this.logger.warn(`Stale branch detected: ${branchName} — deleting before recreating`);
        execFileSync('git', ['branch', '-D', branchName], {
          cwd: space.workspacePath,
          timeout: 30_000,
          env: buildGitCommandEnv(),
        });
      }
    } catch (err) {
      this.logger.warn(
        `Failed to clean up stale branch ${branchName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    try {
      await retryWithBackoff(
        () =>
          Promise.resolve(
            execFileSync(
              'git',
              ['worktree', 'add', worktreePath, '-b', branchName, baseBranch ?? 'HEAD'],
              {
                cwd: space.workspacePath,
                timeout: 30_000,
                stdio: 'pipe',
                env: { ...buildGitCommandEnv(), GIT_LFS_SKIP_SMUDGE: '1' },
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
            this.logger.warn(
              `git worktree add failed (attempt ${attempt}), retrying: ` +
                `${err instanceof Error ? err.message : String(err)}`
            );
          },
        }
      );
    } catch (err) {
      if (existsSync(worktreePath)) {
        try {
          rmSync(worktreePath, { recursive: true, force: true });
        } catch {}
      }
      throw new Error(
        `Failed to create worktree for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    try {
      await this.hydrateWorktreeLfs(worktreePath);
    } catch (err) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
          cwd: space.workspacePath,
          timeout: 30_000,
          env: buildGitCommandEnv(),
        });
      } catch {
        rmSync(worktreePath, { recursive: true, force: true });
      }
      try {
        execFileSync('git', ['branch', '-D', branchName], {
          cwd: space.workspacePath,
          timeout: 30_000,
          env: buildGitCommandEnv(),
        });
      } catch {}
      throw new Error(
        `Failed to hydrate Git LFS objects for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    this.worktreeRepo.create({ spaceId, taskId, slug, path: worktreePath });

    this.logger.info(
      `Created worktree for task ${taskId} at ${worktreePath} (branch: ${branchName})`
    );
    return { path: worktreePath, slug };
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

    try {
      execFileSync('git', ['worktree', 'remove', record.path, '--force'], {
        cwd: space.workspacePath,
        timeout: 30_000,
        env: buildGitCommandEnv(),
      });
    } catch (err) {
      this.logger.warn(
        `Failed to remove git worktree at ${record.path} (continuing with cleanup): ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const branchName = `space/${record.slug}`;
    try {
      execFileSync('git', ['branch', '-D', branchName], {
        cwd: space.workspacePath,
        timeout: 30_000,
        env: buildGitCommandEnv(),
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

  private async hydrateWorktreeLfs(worktreePath: string): Promise<void> {
    let tracked: string;
    try {
      const { stdout } = await execFileAsync('git', ['lfs', 'ls-files'], {
        cwd: worktreePath,
        encoding: 'utf8',
        timeout: 60_000,
        env: buildGitSshEnv(),
      });
      tracked = stdout;
    } catch (err) {
      const declaresLfs = await worktreeDeclaresLfsAttributes(
        worktreePath,
        async () => {
          const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
            cwd: worktreePath,
            encoding: 'utf8',
            timeout: 60_000,
            env: buildGitCommandEnv(),
          });
          return stdout;
        },
        () => indexContainsLfsPointer(worktreePath, buildGitCommandEnv())
      );
      if (declaresLfs) {
        throw new Error(
          `Repository tracks Git LFS files but 'git lfs ls-files' failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      this.logger.warn(
        `Git LFS hydration skipped for ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    if (tracked.trim().length > 0) {
      await execFileAsync('git', ['lfs', 'pull'], {
        cwd: worktreePath,
        encoding: 'utf8',
        timeout: 300_000,
        env: buildGitSshEnv(),
      });
    }
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
          const branchName = `space/${record.slug}`;
          try {
            execFileSync('git', ['branch', '-D', branchName], {
              cwd: space.workspacePath,
              timeout: 30_000,
              env: buildGitCommandEnv(),
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
          env: buildGitCommandEnv(),
        });
      } catch (err) {
        this.logger.warn(
          `git worktree prune failed for space ${spaceId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
}
