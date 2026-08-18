import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration54 } from '../../../../../src/storage/schema/migrations.ts';

function makeDb(): { db: BunDatabase; dir: string } {
  const dir = join(
    process.cwd(),
    'tmp',
    'test-migration-54',
    `t-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  const db = new BunDatabase(join(dir, 'test.db'));
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return { db, dir };
}

function getIndexNames(db: BunDatabase, table: string): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`)
    .all(table) as { name: string }[];
  return rows.map((r) => r.name);
}

describe('Migration 54: uq_space_tasks_run_node_agent unique index', () => {
  let db: BunDatabase;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeDb());
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('index does NOT exist on a fully-migrated DB (workflow_node_id removed in M71)', () => {
    const indexes = getIndexNames(db, 'space_tasks');
    expect(indexes).not.toContain('uq_space_tasks_run_node_agent');
  });

  test('idempotent: calling runMigration54 on a fully-migrated DB does not error', () => {
    expect(() => runMigration54(db)).not.toThrow();
  });

  test('skips gracefully when workflow_node_id column is absent', () => {
    const db2Dir = join(process.cwd(), 'tmp', 'test-migration-54', `no-col-${Date.now()}`);
    mkdirSync(db2Dir, { recursive: true });
    const db2 = new BunDatabase(join(db2Dir, 'test2.db'));
    try {
      db2.exec(`
				CREATE TABLE space_tasks (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					title TEXT NOT NULL DEFAULT '',
					description TEXT NOT NULL DEFAULT '',
					status TEXT NOT NULL DEFAULT 'open',
					priority TEXT NOT NULL DEFAULT 'normal',
					workflow_run_id TEXT,
					labels TEXT NOT NULL DEFAULT '[]',
					depends_on TEXT NOT NULL DEFAULT '[]',
					created_at INTEGER NOT NULL DEFAULT 0,
					updated_at INTEGER NOT NULL DEFAULT 0
				)
			`);
      expect(() => runMigration54(db2)).not.toThrow();
      const indexes = getIndexNames(db2, 'space_tasks');
      expect(indexes).not.toContain('uq_space_tasks_run_node_agent');
    } finally {
      db2.close();
      rmSync(db2Dir, { recursive: true, force: true });
    }
  });
});
