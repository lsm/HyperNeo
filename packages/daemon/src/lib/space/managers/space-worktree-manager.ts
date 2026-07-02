/**
 * SpaceWorktreeManager
 *
 * Manages git worktrees for Space tasks. One worktree per task, created from
 * the space's repository workspace path.
 *
 * Worktree location : ~/.hyperneo/projects/{shortKey}/worktrees/{slug}/
 * Branch naming     : space/{slug}
 *
 * Does NOT extend Room's WorktreeManager — uses execSync directly.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import type { Database as BunDatabase } from 'bun:sqlite';
import { SpaceWorktreeRepository } from '../../../storage/repositories/space-worktree-repository';
import { SpaceRepository } from '../../../storage/repositories/space-repository';
import { worktreeSlug } from '../worktree-slug';
import { Logger } from '../../logger';
import { retryWithBackoff } from '../runtime/retry-utils';
import { MAX_NETWORK_RETRIES, NETWORK_RETRY_DELAYS_MS } from '../runtime/constants';
import { getWorktreeBaseDir } from '../../worktree-path-utils';

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

  /**
   * Create a git worktree for a task.
   *
   * If a worktree already exists for this (spaceId, taskId) pair the existing
   * record is returned without touching the filesystem — idempotent.
   *
   * @param spaceId     - Space UUID
   * @param taskId      - Task UUID
   * @param taskTitle   - Human-readable title used to derive the slug
   * @param taskNumber  - Numeric task ID (fallback for slug when title has no alphanumeric chars)
   * @param baseBranch  - Git ref to base the new branch on (default: 'HEAD')
   * @returns           - { path, slug } of the created (or existing) worktree
   */
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

    // Idempotent: return existing record if the worktree was already created
    const existing = this.worktreeRepo.getByTaskId(spaceId, taskId);
    if (existing) {
      return { path: existing.path, slug: existing.slug };
    }

    // Generate a slug that is unique within this space
    const existingSlugs = this.worktreeRepo.listSlugs(spaceId);
    const slug = worktreeSlug(taskTitle, taskNumber, existingSlugs);

    // Resolve worktree base directory under ~/.hyperneo/projects/{shortKey}/worktrees/
    const worktreesDir = getWorktreeBaseDir(space.workspacePath, (msg) => this.logger.warn(msg));
    if (!existsSync(worktreesDir)) {
      mkdirSync(worktreesDir, { recursive: true });
    }

    const worktreePath = join(worktreesDir, slug);
    const branchName = `space/${slug}`;

    // --- Stale cleanup: remove directory first, then free the branch ---
    // Order matters: git worktree prune only removes entries whose directories
    // are gone, so we must remove the directory BEFORE pruning + branch deletion.

    // Step 1: remove the stale worktree directory (if present).
    if (existsSync(worktreePath)) {
      this.logger.warn(
        `Stale worktree directory detected at ${worktreePath} — removing before recreating`
      );
      try {
        // Prefer `git worktree remove --force` so git deregisters the worktree
        // atomically; fall back to plain rmSync if that fails.
        execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
          cwd: space.workspacePath,
          timeout: 30_000,
        });
      } catch {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    }

    // Step 2: prune git's internal worktree state (now that the directory is gone
    // the stale entry will be removed, freeing the branch reference).
    try {
      execFileSync('git', ['worktree', 'prune'], {
        cwd: space.workspacePath,
        timeout: 30_000,
      });
    } catch {
      // Non-fatal
    }

    // Step 3: delete the stale branch so `git worktree add -b` can create it fresh.
    try {
      const branches = execFileSync('git', ['branch', '--list', branchName], {
        cwd: space.workspacePath,
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (branches.trim().length > 0) {
        this.logger.warn(`Stale branch detected: ${branchName} — deleting before recreating`);
        execFileSync('git', ['branch', '-D', branchName], {
          cwd: space.workspacePath,
          timeout: 30_000,
        });
      }
    } catch (err) {
      // Non-fatal: if branch deletion fails the worktree add will fail with a clear error.
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
                stdio: 'pipe', // suppress git hints
              }
            )
          ),
        {
          maxRetries: MAX_NETWORK_RETRIES,
          delaysMs: NETWORK_RETRY_DELAYS_MS,
          // Do not retry permanent git errors ("already exists", "fatal:", etc.)
          // — only transient failures like timeouts or network blips benefit from retry.
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
      // Clean up the directory if it was partially created
      if (existsSync(worktreePath)) {
        try {
          rmSync(worktreePath, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
      throw new Error(
        `Failed to create worktree for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Persist the mapping to SQLite after the filesystem operation succeeds
    this.worktreeRepo.create({ spaceId, taskId, slug, path: worktreePath });

    this.logger.info(
      `Created worktree for task ${taskId} at ${worktreePath} (branch: ${branchName})`
    );
    return { path: worktreePath, slug };
  }

  /**
   * Remove a task's worktree from the filesystem and delete its branch.
   * Removes the SQLite record regardless of whether the filesystem operation succeeds.
   */
  async removeTaskWorktree(spaceId: string, taskId: string): Promise<void> {
    const record = this.worktreeRepo.getByTaskId(spaceId, taskId);
    if (!record) {
      return; // Nothing to do
    }

    const space = this.spaceRepo.getSpace(spaceId);
    if (!space) {
      // Space is gone; just clean up the DB record
      this.worktreeRepo.delete(spaceId, taskId);
      return;
    }

    // Remove the worktree directory via git
    try {
      execFileSync('git', ['worktree', 'remove', record.path, '--force'], {
        cwd: space.workspacePath,
        timeout: 30_000,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to remove git worktree at ${record.path} (continuing with cleanup): ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Delete the branch
    const branchName = `space/${record.slug}`;
    try {
      execFileSync('git', ['branch', '-D', branchName], {
        cwd: space.workspacePath,
        timeout: 30_000,
      });
    } catch (err) {
      // Branch may already be gone; non-fatal
      this.logger.warn(
        `Failed to delete branch ${branchName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Remove the SQLite record
    this.worktreeRepo.delete(spaceId, taskId);
    this.logger.info(`Removed worktree for task ${taskId} (branch: ${branchName})`);
  }

  /**
   * Mark a task's worktree as completed so the TTL reaper can clean it up later.
   *
   * Called when a task finishes normally (not cancelled).  The worktree is NOT
   * removed immediately — the TTL reaper will delete it after `ttlMs` has elapsed.
   *
   * Idempotent: calling more than once for the same task is a no-op after the
   * first call sets `completed_at`.
   */
  markTaskWorktreeCompleted(spaceId: string, taskId: string): void {
    this.worktreeRepo.markCompleted(spaceId, taskId);
  }

  /**
   * Remove all worktrees that were completed more than `ttlMs` milliseconds ago.
   *
   * Iterates over every expired record, removes the git worktree + branch, and
   * deletes the SQLite row.  Errors for individual worktrees are logged and
   * skipped so one bad worktree cannot block the rest of the cleanup pass.
   *
   * @param ttlMs - TTL in milliseconds (default: 7 days)
   */
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

  /**
   * Return the filesystem path for a task's worktree, or null if none exists.
   */
  async getTaskWorktreePath(spaceId: string, taskId: string): Promise<string | null> {
    return this.getTaskWorktreePathSync(spaceId, taskId);
  }

  /**
   * Synchronous variant of `getTaskWorktreePath`. Exposed so that sync call sites
   * (e.g. the public `TaskAgentManager.getTaskWorktreePath(taskId)` getter used by
   * tool handlers and RPCs) can read the persisted path without bouncing through
   * a Promise. The underlying repository access is already synchronous.
   */
  getTaskWorktreePathSync(spaceId: string, taskId: string): string | null {
    const record = this.worktreeRepo.getByTaskId(spaceId, taskId);
    return record?.path ?? null;
  }

  /**
   * List all worktrees tracked for a space.
   */
  async listWorktrees(spaceId: string): Promise<SpaceWorktreeInfo[]> {
    const records = this.worktreeRepo.listBySpace(spaceId);
    return records.map((r) => ({ slug: r.slug, taskId: r.taskId, path: r.path }));
  }

  /**
   * Remove SQLite records whose worktree directories no longer exist on disk,
   * then prune git's internal worktree metadata.
   *
   * This is safe to call at any time — it only removes records for missing
   * directories and does not touch live worktrees.
   */
  async cleanupOrphaned(spaceId: string): Promise<void> {
    const records = this.worktreeRepo.listBySpace(spaceId);
    const space = this.spaceRepo.getSpace(spaceId);

    for (const record of records) {
      if (!existsSync(record.path)) {
        // Also delete the orphaned branch to match removeTaskWorktree behavior
        if (space) {
          const branchName = `space/${record.slug}`;
          try {
            execFileSync('git', ['branch', '-D', branchName], {
              cwd: space.workspacePath,
              timeout: 30_000,
            });
          } catch {
            // Branch may already be gone; non-fatal
          }
        }
        this.worktreeRepo.delete(spaceId, record.taskId);
        this.logger.info(
          `Cleaned up orphaned worktree record for task ${record.taskId} (path was: ${record.path})`
        );
      }
    }

    // Prune git's internal worktree state as well
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
