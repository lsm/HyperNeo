/**
 * WorkspaceHistoryRepository
 *
 * CRUD operations for the workspace_history table.
 * Tracks recently-used workspace paths with usage counts and timestamps.
 */

import type { Database as BunDatabase } from '../sqlite-compat';

export interface WorkspaceHistoryRow {
  path: string;
  last_used_at: number;
  use_count: number;
}

export class WorkspaceHistoryRepository {
  constructor(private db: BunDatabase) {}

  /**
   * Add or update a workspace path in history.
   * If the path already exists, increment use_count and update last_used_at.
   */
  upsert(path: string): WorkspaceHistoryRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workspace_history (path, last_used_at, use_count)
				 VALUES (?, ?, 1)
				 ON CONFLICT(path) DO UPDATE SET
				   last_used_at = excluded.last_used_at,
				   use_count = use_count + 1`
      )
      .run(path, now);
    return this.get(path)!;
  }

  /**
   * Get a specific workspace entry by path.
   */
  get(path: string): WorkspaceHistoryRow | null {
    const row = this.db
      .prepare('SELECT path, last_used_at, use_count FROM workspace_history WHERE path = ?')
      .get(path) as WorkspaceHistoryRow | null;
    return row;
  }

  /**
   * List all workspace history entries sorted by last_used_at DESC.
   *
   * Secondary sort by `id DESC` ensures deterministic ordering when two rows
   * share the same `last_used_at` (e.g., two inserts in the same millisecond
   * on fast hardware). The autoincrement `id` guarantees that the most
   * recently inserted row wins the tiebreak, matching the user-visible
   * "most recently used first" contract.
   */
  list(limit = 20): WorkspaceHistoryRow[] {
    return this.db
      .prepare(
        'SELECT path, last_used_at, use_count FROM workspace_history ORDER BY last_used_at DESC, id DESC LIMIT ?'
      )
      .all(limit) as WorkspaceHistoryRow[];
  }

  /**
   * Remove a workspace from history.
   */
  remove(path: string): boolean {
    const result = this.db.prepare('DELETE FROM workspace_history WHERE path = ?').run(path);
    return result.changes > 0;
  }
}
