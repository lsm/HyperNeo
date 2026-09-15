import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import { SpaceWorktreeRepository } from '../../storage/repositories/space-worktree-repository.ts';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import { Logger } from '../logger.ts';
import { runCreateTaskWorktree } from './create-task-worktree-pipeline.ts';
import { resolveRepoRoot } from './worktree-git-probes.ts';

export { WorkspaceNotGitRepositoryError } from './create-task-worktree-pipeline.ts';

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
