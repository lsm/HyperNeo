/**
 * Migration 126 Tests — drop legacy `idx_sdk_messages_parent_tool` function index.
 *
 * Background: migration 122 materialised `parent_tool_use_id` as a column and
 * added `idx_sdk_messages_parent_tool_use_id (session_id, parent_tool_use_id)`.
 * The earlier json_extract function index was kept around for compatibility
 * but no longer has callers, so it just amplifies INSERT/UPDATE cost.
 *
 * Covers:
 *   - Pre-126 schema with the function index present — migration drops it.
 *   - Re-running the migration is a no-op (idempotent via `IF EXISTS`).
 *   - Fresh, fully-migrated DB — column index is present and the function
 *     index is absent (verifies the createIndexes change too).
 */

import { describe, test, expect } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { createTables, runMigration126, runMigrations } from '../../../../../src/storage/schema';

function indexExists(db: BunDatabase, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(name) as { name?: string } | undefined;
  return !!row?.name;
}

describe('Migration 126 — drop idx_sdk_messages_parent_tool', () => {
  test('drops the legacy function index when present', () => {
    const db = new BunDatabase(':memory:');
    db.exec(`
			CREATE TABLE sdk_messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				parent_tool_use_id TEXT
			)
		`);
    db.exec(`CREATE INDEX idx_sdk_messages_parent_tool
			ON sdk_messages(session_id, json_extract(sdk_message, '$.parent_tool_use_id'))`);
    expect(indexExists(db, 'idx_sdk_messages_parent_tool')).toBe(true);

    runMigration126(db);
    expect(indexExists(db, 'idx_sdk_messages_parent_tool')).toBe(false);
    db.close();
  });

  test('is idempotent — running twice on a DB without the index is a no-op', () => {
    const db = new BunDatabase(':memory:');
    db.exec(`
			CREATE TABLE sdk_messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				parent_tool_use_id TEXT
			)
		`);
    runMigration126(db);
    runMigration126(db);
    expect(indexExists(db, 'idx_sdk_messages_parent_tool')).toBe(false);
    db.close();
  });

  test('fully-migrated DB has the column index but not the legacy function index', () => {
    const db = new BunDatabase(':memory:');
    createTables(db);
    runMigrations(db, () => {});
    expect(indexExists(db, 'idx_sdk_messages_parent_tool')).toBe(false);
    expect(indexExists(db, 'idx_sdk_messages_parent_tool_use_id')).toBe(true);
    db.close();
  });
});
