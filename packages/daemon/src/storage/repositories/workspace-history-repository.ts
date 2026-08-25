import type { Database as BunDatabase } from '../sqlite-compat.ts';

export interface WorkspaceHistoryRow {
  path: string;
  last_used_at: number;
  use_count: number;
}

export class WorkspaceHistoryRepository {
  constructor(private db: BunDatabase) {}

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

  get(path: string): WorkspaceHistoryRow | null {
    const row = this.db
      .prepare('SELECT path, last_used_at, use_count FROM workspace_history WHERE path = ?')
      .get(path) as WorkspaceHistoryRow | null;
    return row;
  }

  list(limit = 20): WorkspaceHistoryRow[] {
    return this.db
      .prepare(
        'SELECT path, last_used_at, use_count FROM workspace_history ORDER BY last_used_at DESC, id DESC LIMIT ?'
      )
      .all(limit) as WorkspaceHistoryRow[];
  }

  remove(path: string): boolean {
    const result = this.db.prepare('DELETE FROM workspace_history WHERE path = ?').run(path);
    return result.changes > 0;
  }
}
