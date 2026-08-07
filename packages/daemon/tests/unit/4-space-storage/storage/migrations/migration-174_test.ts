/**
 * Migration 174 Tests — post-approval completion resumability columns (task #868).
 *
 * Adds four nullable `space_tasks` columns backing the daemon-side deterministic
 * completion tail: `post_approval_progress` (JSON), `post_approval_lease_owner`,
 * `post_approval_lease_expires_at`, `post_approval_completion_status`.
 *
 * Covers:
 *   - Fresh, fully-migrated DB has all four columns.
 *   - Pre-M174 schema (columns absent) gains them after the migration.
 *   - The migration is idempotent (re-running is a no-op).
 *   - `tableExists` guard: skipped cleanly when `space_tasks` is absent.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/migrations.ts';
import { runMigration174 } from '../../../../../src/storage/schema/m174-post-approval-completion-columns';

function columnNames(db: BunDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

const EXPECTED = [
  'post_approval_progress',
  'post_approval_lease_owner',
  'post_approval_lease_expires_at',
  'post_approval_completion_status',
];

describe('Migration 174 — post-approval completion columns', () => {
  let db: BunDatabase;
  beforeEach(() => {
    db = new BunDatabase(':memory:');
  });
  afterEach(() => db.close());

  test('fresh fully-migrated DB has all four columns', () => {
    runMigrations(db, () => {});
    const cols = columnNames(db, 'space_tasks');
    for (const c of EXPECTED) expect(cols).toContain(c);
  });

  test('adds the columns when absent (pre-M174 schema)', () => {
    // Minimal pre-M174 space_tasks with the M103 post-approval columns present
    // (so we are simulating a DB that ran M103 but not M174).
    db.exec(`
      CREATE TABLE spaces (id TEXT PRIMARY KEY, workspace_path TEXT, slug TEXT, name TEXT);
      CREATE TABLE space_tasks (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        post_approval_session_id TEXT DEFAULT NULL,
        post_approval_started_at INTEGER DEFAULT NULL,
        post_approval_blocked_reason TEXT DEFAULT NULL
      );
    `);
    // Sanity: columns absent before.
    const before = columnNames(db, 'space_tasks');
    for (const c of EXPECTED) expect(before).not.toContain(c);

    runMigration174(db);

    const after = columnNames(db, 'space_tasks');
    for (const c of EXPECTED) expect(after).toContain(c);
  });

  test('idempotent — running twice is a no-op', () => {
    db.exec(`
      CREATE TABLE spaces (id TEXT PRIMARY KEY, workspace_path TEXT, slug TEXT, name TEXT);
      CREATE TABLE space_tasks (
        id TEXT PRIMARY KEY, space_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open'
      );
    `);
    runMigration174(db);
    const afterFirst = columnNames(db, 'space_tasks');
    runMigration174(db); // second run must not throw / not duplicate
    const afterSecond = columnNames(db, 'space_tasks');
    expect(afterSecond).toEqual(afterFirst);
  });

  test('no-op when space_tasks does not exist', () => {
    // Should not throw.
    runMigration174(db);
    expect(columnNames(db, 'space_tasks')).toEqual([]);
  });
});
