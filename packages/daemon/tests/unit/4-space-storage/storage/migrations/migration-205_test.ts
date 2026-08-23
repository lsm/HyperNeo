import { Database as BunDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runMigration205 } from '../../../../../src/storage/schema/migrations.ts';

function tableNames(db: BunDatabase): string[] {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
    name: string;
  }>;
  return rows.map((r) => r.name);
}

describe('Migration 205: space_goal_outcome_notifications', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-205',
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

  test('creates the outcome notifications table when space_goals exists', () => {
    db.exec(`CREATE TABLE space_goals (id TEXT PRIMARY KEY, title TEXT NOT NULL)`);
    runMigration205(db);

    expect(tableNames(db)).toContain('space_goal_outcome_notifications');
    const columns = db
      .prepare(`PRAGMA table_info('space_goal_outcome_notifications')`)
      .all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    for (const col of [
      'id',
      'space_id',
      'goal_id',
      'task_id',
      'terminal_generation',
      'goal_revision',
      'status',
      'payload_json',
      'created_at',
      'updated_at',
    ]) {
      expect(names).toContain(col);
    }
  });

  test('is idempotent', () => {
    db.exec(`CREATE TABLE space_goals (id TEXT PRIMARY KEY, title TEXT NOT NULL)`);
    runMigration205(db);
    expect(() => runMigration205(db)).not.toThrow();
  });

  test('is a no-op when space_goals does not exist', () => {
    expect(() => runMigration205(db)).not.toThrow();
    expect(tableNames(db)).not.toContain('space_goal_outcome_notifications');
  });
});
