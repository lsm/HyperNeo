import { Database as BunDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runMigration202 } from '../../../../../src/storage/schema/migrations.ts';

function indexNames(db: BunDatabase): string[] {
  const rows = db.prepare(`PRAGMA index_list('space_tasks')`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function seedPreM202Schema(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE space_tasks (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      goal_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

describe('Migration 202: goal task keyset indexes', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-202',
      `test-${Date.now()}-${Math.random()}`
    );
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe('pre-M202 schema with goal_id', () => {
    beforeEach(() => {
      seedPreM202Schema(db);
    });

    test('creates both goal-task keyset indexes', () => {
      runMigration202(db);
      const indexes = indexNames(db);
      expect(indexes).toContain('idx_space_tasks_goal_created');
      expect(indexes).toContain('idx_space_tasks_goal_status_created');
    });

    test('is idempotent — a second run does not throw or duplicate', () => {
      runMigration202(db);
      expect(() => runMigration202(db)).not.toThrow();
      expect(indexNames(db).filter((n) => n === 'idx_space_tasks_goal_created')).toHaveLength(1);
    });
  });

  describe('pre-M202 schema without goal_id', () => {
    test('skips index creation when goal_id is absent', () => {
      db.exec(`
        CREATE TABLE space_tasks (
          id TEXT PRIMARY KEY,
          space_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open'
        );
      `);
      expect(() => runMigration202(db)).not.toThrow();
      expect(indexNames(db)).not.toContain('idx_space_tasks_goal_created');
    });

    test('is a no-op when space_tasks does not exist', () => {
      expect(() => runMigration202(db)).not.toThrow();
    });
  });
});
