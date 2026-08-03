/**
 * Migration 171 Tests — Retention covering indexes.
 *
 * Covers:
 *   - Creates the three covering indexes the retention sweep needs
 *   - Idempotent (running twice / with pre-existing indexes is a no-op)
 *   - Skips absent tables without error
 */

import { describe, test, expect } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration171 } from '../../../../../src/storage/schema/migrations';

function indexExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name);
}

function createTables(db: BunDatabase): void {
  db.exec(`CREATE TABLE mcp_audit_log (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL)`);
  db.exec(
    `CREATE TABLE space_github_events (id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL)`
  );
  db.exec(`CREATE TABLE space_goal_events (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`);
}

describe('Migration 171: retention covering indexes', () => {
  test('creates the three covering indexes', () => {
    const db = new BunDatabase(':memory:');
    createTables(db);

    runMigration171(db);

    expect(indexExists(db, 'idx_mcp_audit_log_timestamp')).toBe(true);
    expect(indexExists(db, 'idx_space_github_events_state_updated')).toBe(true);
    expect(indexExists(db, 'idx_space_goal_events_created')).toBe(true);
    db.close();
  });

  test('is idempotent — running twice does not error', () => {
    const db = new BunDatabase(':memory:');
    createTables(db);

    runMigration171(db);
    expect(() => runMigration171(db)).not.toThrow();

    expect(indexExists(db, 'idx_mcp_audit_log_timestamp')).toBe(true);
    db.close();
  });

  test('skips absent tables without error', () => {
    const db = new BunDatabase(':memory:');
    // Only one of the three tables exists.
    db.exec(`CREATE TABLE mcp_audit_log (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL)`);

    expect(() => runMigration171(db)).not.toThrow();
    expect(indexExists(db, 'idx_mcp_audit_log_timestamp')).toBe(true);
    expect(indexExists(db, 'idx_space_github_events_state_updated')).toBe(false);
    db.close();
  });
});
