import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { generateUUID } from '@hyperneo/shared';

export interface SpaceWorktreeRecord {
  id: string;
  spaceId: string;
  taskId: string;
  slug: string;
  path: string;
  createdAt: number;
  completedAt?: number;
}

export class SpaceWorktreeRepository {
  constructor(private db: BunDatabase) {}

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

  getByTaskId(spaceId: string, taskId: string): SpaceWorktreeRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM space_worktrees WHERE space_id = ? AND task_id = ?`)
      .get(spaceId, taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToRecord(row);
  }

  listBySpace(spaceId: string): SpaceWorktreeRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM space_worktrees WHERE space_id = ? ORDER BY created_at ASC`)
      .all(spaceId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRecord(r));
  }

  listSlugs(spaceId: string): string[] {
    const rows = this.db
      .prepare(`SELECT slug FROM space_worktrees WHERE space_id = ?`)
      .all(spaceId) as Array<{ slug: string }>;
    return rows.map((r) => r.slug);
  }

  listSlugsUnderPath(pathPrefix: string): string[] {
    const rows = this.db
      .prepare(`SELECT slug FROM space_worktrees WHERE substr(path, 1, ?) = ?`)
      .all(pathPrefix.length, pathPrefix) as Array<{ slug: string }>;
    return rows.map((r) => r.slug);
  }

  markCompleted(spaceId: string, taskId: string, completedAt: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE space_worktrees SET completed_at = ? WHERE space_id = ? AND task_id = ? AND completed_at IS NULL`
      )
      .run(completedAt, spaceId, taskId);
    return result.changes > 0;
  }

  listCompletedBefore(cutoffMs: number): SpaceWorktreeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_worktrees WHERE completed_at IS NOT NULL AND completed_at < ? ORDER BY completed_at ASC`
      )
      .all(cutoffMs) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRecord(r));
  }

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
