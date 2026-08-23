import { Database as BunDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runMigration204 } from '../../../../../src/storage/schema/migrations.ts';

function columnNames(db: BunDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('Migration 204: goal revision + task terminal generation', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-204',
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

  test('adds revision to space_goals and terminal_generation to space_tasks', () => {
    db.exec(`
      CREATE TABLE space_goals (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE space_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    `);
    expect(columnNames(db, 'space_goals')).not.toContain('revision');
    expect(columnNames(db, 'space_tasks')).not.toContain('terminal_generation');

    runMigration204(db);

    expect(columnNames(db, 'space_goals')).toContain('revision');
    expect(columnNames(db, 'space_tasks')).toContain('terminal_generation');
  });

  test('existing rows get the default revision 0 (pre-counter sentinel) and generation 0', () => {
    db.exec(`
      CREATE TABLE space_goals (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE space_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      INSERT INTO space_goals (id, title) VALUES ('g1', 'Goal');
      INSERT INTO space_tasks (id, title) VALUES ('t1', 'Task');
    `);

    runMigration204(db);

    expect(
      (db.prepare(`SELECT revision AS r FROM space_goals WHERE id = ?`).get('g1') as { r: number })
        .r
    ).toBe(0);
    expect(
      (
        db.prepare(`SELECT terminal_generation AS g FROM space_tasks WHERE id = ?`).get('t1') as {
          g: number;
        }
      ).g
    ).toBe(0);
  });

  test('is idempotent', () => {
    db.exec(`
      CREATE TABLE space_goals (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE space_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    `);
    runMigration204(db);
    expect(() => runMigration204(db)).not.toThrow();
    expect(columnNames(db, 'space_goals').filter((c) => c === 'revision')).toHaveLength(1);
  });

  test('is a no-op when the tables do not exist', () => {
    expect(() => runMigration204(db)).not.toThrow();
  });
});
