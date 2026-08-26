import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import { SpaceWorktreeRepository } from '../../../storage/repositories/space-worktree-repository.ts';
import { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import { worktreeSlug } from '../worktree-slug.ts';
import { Logger } from '../../logger.ts';
import { retryWithBackoff } from '../runtime/retry-utils.ts';
import { MAX_NETWORK_RETRIES, NETWORK_RETRY_DELAYS_MS } from '../runtime/constants.ts';
import { getWorktreeBaseDir } from '../../worktree-path-utils.ts';

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

  private resolveRepoRoot(repoRoot: string): { commandCwd: string; dirKey: string } {
    try {
      const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
      }).trim();
      if (!topLevel) throw new Error('empty toplevel');
      const commonDirRaw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
      }).trim();
      const commonDir =
        commonDirRaw && !isAbsolute(commonDirRaw) ? resolve(topLevel, commonDirRaw) : commonDirRaw;
      const dirKey = commonDir ? dirname(commonDir) : topLevel;
      return { commandCwd: topLevel, dirKey };
    } catch {
      return { commandCwd: repoRoot, dirKey: repoRoot };
    }
  }

  async createTaskWorktree(
    spaceId: string,
    taskId: string,
    taskTitle: string,
    taskNumber: number,
    baseBranch?: string,
    repoRoot?: string
  ): Promise<{ path: string; slug: string }> {
    const space = this.spaceRepo.getSpace(spaceId);
    if (!space) {
      throw new Error(`Space not found: ${spaceId}`);
    }
    const repo = this.resolveRepoRoot(repoRoot ?? space.workspacePath);

    const existing = this.worktreeRepo.getByTaskId(spaceId, taskId);
    if (existing) {
      return { path: existing.path, slug: existing.slug };
    }

    const worktreesDir = getWorktreeBaseDir(repo.dirKey, (msg) => this.logger.warn(msg));
    if (!existsSync(worktreesDir)) {
      mkdirSync(worktreesDir, { recursive: true });
    }

    const existingSlugs = [
      ...this.worktreeRepo.listSlugs(spaceId),
      ...this.worktreeRepo.listSlugsUnderPath(`${worktreesDir}/`),
    ];
    const slug = worktreeSlug(taskTitle, taskNumber, existingSlugs);

    const worktreePath = join(worktreesDir, slug);
    const branchName = `space/${slug}`;

    if (existsSync(worktreePath)) {
      this.logger.warn(
        `Stale worktree directory detected at ${worktreePath} — removing before recreating`
      );
      try {
        execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
          cwd: repo.commandCwd,
          timeout: 30_000,
        });
      } catch {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    }

    try {
      execFileSync('git', ['worktree', 'prune'], {
        cwd: repo.commandCwd,
        timeout: 30_000,
      });
    } catch {}

    try {
      const branches = execFileSync('git', ['branch', '--list', branchName], {
        cwd: repo.commandCwd,
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (branches.trim().length > 0) {
        this.logger.warn(`Stale branch detected: ${branchName} — deleting before recreating`);
        execFileSync('git', ['branch', '-D', branchName], {
          cwd: repo.commandCwd,
          timeout: 30_000,
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

    this.worktreeRepo.create({ spaceId, taskId, slug, path: worktreePath });

    this.logger.info(
      `Created worktree for task ${taskId} at ${worktreePath} (branch: ${branchName})`
    );
    return { path: worktreePath, slug };
  }

  private resolveWorktreeRepoRoot(worktreePath: string, fallback: string): string {
    const sentinel = join(dirname(dirname(worktreePath)), '.hyperneo-repo-root');
    if (existsSync(sentinel)) {
      try {
        const stored = readFileSync(sentinel, 'utf8').trim();
        if (stored) return stored;
      } catch {}
    }
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
      if (existsSync(record.path)) {
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
