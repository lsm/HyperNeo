/**
 * Migration 180 — persist the dispatched post-approval route target (task #868).
 *
 * Originally authored as 175; renumbered to 180 because dev shipped intervening
 * migrations 174–178 while this branch was in review.
 *
 * Context: the completion reconciler gates recovery on the post-approval route
 * being the merger route. Resolving that from the (mutable) current workflow is
 * a TOCTOU — a workflow edited mid-flight (custom route ↔ merger) would let
 * recovery drive the wrong action. This adds an IMMUTABLE column set at
 * PostApprovalRouter dispatch time (`post_approval_route_target_agent`), which
 * the service reads instead of re-resolving from the workflow. Nullable + no
 * backfill: pre-existing tasks fall back to workflow resolution (back-compat).
 * Idempotent.
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

export function runMigration180(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;
  if (!tableHasColumn(db, 'space_tasks', 'post_approval_route_target_agent')) {
    db.exec(
      `ALTER TABLE space_tasks ADD COLUMN post_approval_route_target_agent TEXT DEFAULT NULL`
    );
  }
}
