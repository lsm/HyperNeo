/**
 * Migration 174 — Post-approval completion resumability columns (task #868).
 *
 * Context: the deterministic post-approval COMPLETION tail (the steps that run
 * once a PR is merged: branch cleanup, worktree fetch, Space checkout sync,
 * audit artifact, task → done) used to live entirely inside the PR Merger LLM
 * agent's prompt. If the merger stalled or died after the merge (API retries,
 * session crash, daemon restart) but before `mark_complete`, the task sat in
 * `approved` indefinitely — `recoverStalledRuns` treats `approved` as "at rest".
 *
 * This migration adds the durable state a daemon-side completion service +
 * reconciler need to finish that tail deterministically and exactly once,
 * independent of the merger transcript:
 *
 *   - `post_approval_progress` (TEXT/JSON) — a {@link PostApprovalProgress} blob
 *     holding per-checkpoint state so recovery resumes from the first incomplete
 *     checkpoint (merge_confirmed → branch_cleanup → worktree_fetched →
 *     space_synced → audit_persisted → task_marked_done).
 *   - `post_approval_lease_owner` / `post_approval_lease_expires_at` — a
 *     compare-and-swap lease so concurrent recovery and a live merger cannot
 *     duplicate completion.
 *   - `post_approval_completion_status` — denormalised human-facing status
 *     (`finalizing merge` / `completion recovery`) so an `approved` task is never
 *     silently idling; surfaced on the task row without parsing the JSON blob.
 *
 * All four columns are nullable with no backfill: pre-existing tasks simply have
 * no progress/lease/status until the completion service first touches them.
 * Guarded by `tableHasColumn` so the migration is idempotent.
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

export function runMigration174(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;

  if (!tableHasColumn(db, 'space_tasks', 'post_approval_progress')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN post_approval_progress TEXT DEFAULT NULL`);
  }
  if (!tableHasColumn(db, 'space_tasks', 'post_approval_lease_owner')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN post_approval_lease_owner TEXT DEFAULT NULL`);
  }
  if (!tableHasColumn(db, 'space_tasks', 'post_approval_lease_expires_at')) {
    db.exec(
      `ALTER TABLE space_tasks ADD COLUMN post_approval_lease_expires_at INTEGER DEFAULT NULL`
    );
  }
  if (!tableHasColumn(db, 'space_tasks', 'post_approval_completion_status')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN post_approval_completion_status TEXT DEFAULT NULL`);
  }
}
