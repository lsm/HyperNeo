/**
 * SpaceWorktreeRepository
 *
 * Persists the mapping between space tasks and their git worktrees.
 * One record per task; keyed by (space_id, task_id).
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@hyperneo/shared';

export interface SpaceWorktreeRecord {
  id: string;
  spaceId: string;
  taskId: string;
  slug: string;
  path: string;
  createdAt: number;
  /** Unix epoch ms when the task completed. NULL while the task is still active. */
  completedAt?: number;
}

export class SpaceWorktreeRepository {
  constructor(private db: BunDatabase) {}

  /**
   * Persist a new worktree ↔ task mapping.
   */
  create(params: {
    spaceId: string;
    taskId: string;
    slug: string;
    path: string;
  }): SpaceWorktreeRecord {
    const id = generateUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO space_worktrees (id, space_id, task_id, slug, path, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, params.spaceId, params.taskId, params.slug, params.path, now);
    return this.getById(id)!;
  }

  /**
   * Look up the worktree record for a specific task.
   */
  getByTaskId(spaceId: string, taskId: string): SpaceWorktreeRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM space_worktrees WHERE space_id = ? AND task_id = ?`)
      .get(spaceId, taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToRecord(row);
  }

  /**
   * List all worktrees for a space, ordered by creation time.
   */
  listBySpace(spaceId: string): SpaceWorktreeRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM space_worktrees WHERE space_id = ? ORDER BY created_at ASC`)
      .all(spaceId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /**
   * Return all slugs currently in use for a space.
   * Used for collision avoidance when generating new slugs.
   */
  listSlugs(spaceId: string): string[] {
    const rows = this.db
      .prepare(`SELECT slug FROM space_worktrees WHERE space_id = ?`)
      .all(spaceId) as Array<{ slug: string }>;
    return rows.map((r) => r.slug);
  }

  /**
   * Set completed_at on the worktree record for a task.
   * Called when a task finishes normally — worktree is kept for TTL-based cleanup.
   * Returns true if a row was updated.
   */
  markCompleted(spaceId: string, taskId: string, completedAt: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE space_worktrees SET completed_at = ? WHERE space_id = ? AND task_id = ? AND completed_at IS NULL`
      )
      .run(completedAt, spaceId, taskId);
    return result.changes > 0;
  }

  /**
   * List all worktree records whose completed_at is older than the given cutoff.
   * Used by the TTL reaper to find expired worktrees across all spaces.
   */
  listCompletedBefore(cutoffMs: number): SpaceWorktreeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_worktrees WHERE completed_at IS NOT NULL AND completed_at < ? ORDER BY completed_at ASC`
      )
      .all(cutoffMs) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /**
   * Remove the worktree record for a specific task.
   * Returns true if a row was deleted.
   */
  delete(spaceId: string, taskId: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM space_worktrees WHERE space_id = ? AND task_id = ?`)
      .run(spaceId, taskId);
    return result.changes > 0;
  }

  private getById(id: string): SpaceWorktreeRecord | null {
    const row = this.db.prepare(`SELECT * FROM space_worktrees WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.rowToRecord(row);
  }

  private rowToRecord(row: Record<string, unknown>): SpaceWorktreeRecord {
    return {
      id: row.id as string,
      spaceId: row.space_id as string,
      taskId: row.task_id as string,
      slug: row.slug as string,
      path: row.path as string,
      createdAt: row.created_at as number,
      completedAt: (row.completed_at as number | null) ?? undefined,
    };
  }
}
