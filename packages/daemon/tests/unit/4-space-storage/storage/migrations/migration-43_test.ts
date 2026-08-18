import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations, createTables } from '../../../../../src/storage/schema/index.ts';

function tableExists(db: BunDatabase, tableName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  return !!result;
}

function indexExists(db: BunDatabase, indexName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(indexName);
  return !!result;
}

describe('Migration 43: drop session_group_messages', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-43', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const dbPath = join(testDir, 'test.db');
    db = new BunDatabase(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('fresh DB: table is absent after migrations + createTables', () => {
    runMigrations(db, () => {});
    createTables(db);

    expect(tableExists(db, 'session_group_messages')).toBe(false);
    expect(indexExists(db, 'idx_sgm_group')).toBe(false);
  });

  test('existing DB: migration drops legacy table and index', () => {
    db.exec(`
			CREATE TABLE session_groups (
				id TEXT PRIMARY KEY,
				group_type TEXT NOT NULL DEFAULT 'task',
				ref_id TEXT NOT NULL,
				version INTEGER NOT NULL DEFAULT 0,
				metadata TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				completed_at INTEGER
			);
			CREATE TABLE session_group_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT,
				role TEXT NOT NULL DEFAULT 'system',
				message_type TEXT NOT NULL DEFAULT 'status',
				content TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL
			);
			CREATE INDEX idx_sgm_group ON session_group_messages(group_id, created_at, id);
		`);

    expect(tableExists(db, 'session_group_messages')).toBe(true);
    expect(indexExists(db, 'idx_sgm_group')).toBe(true);

    runMigrations(db, () => {});

    expect(tableExists(db, 'session_group_messages')).toBe(false);
    expect(indexExists(db, 'idx_sgm_group')).toBe(false);
  });

  test('idempotency: running migrations twice is safe after drop', () => {
    runMigrations(db, () => {});
    createTables(db);
    expect(() => {
      runMigrations(db, () => {});
      createTables(db);
    }).not.toThrow();

    expect(tableExists(db, 'session_group_messages')).toBe(false);
    expect(indexExists(db, 'idx_sgm_group')).toBe(false);
  });
});
