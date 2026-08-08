/**
 * Migration 176 — covering index for the post-approval reconciler sweep (task #868).
 *
 * Context: `SpaceTaskRepository.listApprovedTasks` runs
 *   `SELECT * FROM space_tasks WHERE status = 'approved' ORDER BY updated_at DESC, id DESC`
 * on every reconciler sweep (default every 60s). Without a covering index each
 * sweep scans + sorts the whole table. This adds `idx_space_tasks_status_updated`
 * on `(status, updated_at DESC, id DESC)` so the approved-task scan is served
 * from the index. Idempotent (`CREATE INDEX IF NOT EXISTS`).
 *
 * Guarded on `space_tasks` + its `updated_at` column existing: minimal baseline
 * schemas used in migration-runner tests create `space_tasks` without
 * `updated_at`, in which case the index is neither creatable nor useful, so the
 * migration is a no-op (the marker is still recorded).
 */

import type { Database as BunDatabase } from '../sqlite-compat';

function tableExists(db: BunDatabase, tableName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  return !!result;
}

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM pragma_table_info('${tableName}') WHERE name = ?`)
    .get(columnName);
  return !!result;
}

export function runMigration176(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;
  if (!tableHasColumn(db, 'space_tasks', 'updated_at')) return;
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_tasks_status_updated ON space_tasks(status, updated_at DESC, id DESC)`
  );
}
