import { Database as BunDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createTables } from '../../../../../src/storage/schema';
import { runMigration201, runMigrations } from '../../../../../src/storage/schema/migrations.ts';

function columnNames(db: BunDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function seedPreM201Schema(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE space_tasks (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      updated_at INTEGER NOT NULL
    );
  `);
}

describe('Migration 201: space_tasks.spawn_reservation_token', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-201',
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

  describe('pre-M201 schema — add column', () => {
    beforeEach(() => {
      seedPreM201Schema(db);
    });

    test('adds the spawn_reservation_token column', () => {
      expect(columnNames(db, 'space_tasks')).not.toContain('spawn_reservation_token');
      runMigration201(db);
      expect(columnNames(db, 'space_tasks')).toContain('spawn_reservation_token');
    });

    test('existing rows keep a NULL spawn_reservation_token', () => {
      db.prepare(
        `INSERT INTO space_tasks (id, space_id, status, updated_at) VALUES ('t1', 'sp1', 'open', 0)`
      ).run();
      runMigration201(db);
      const row = db
        .prepare(`SELECT spawn_reservation_token AS t FROM space_tasks WHERE id = ?`)
        .get('t1') as { t: null };
      expect(row.t).toBeNull();
    });

    test('is idempotent — a second run does not throw or duplicate', () => {
      runMigration201(db);
      expect(() => runMigration201(db)).not.toThrow();
      expect(
        columnNames(db, 'space_tasks').filter((c) => c === 'spawn_reservation_token')
      ).toHaveLength(1);
    });
  });

  describe('fresh DB (all migrations applied)', () => {
    beforeEach(() => {
      createTables(db);
      runMigrations(db, () => {});
    });

    test('space_tasks carries spawn_reservation_token', () => {
      expect(columnNames(db, 'space_tasks')).toContain('spawn_reservation_token');
    });
  });

  describe('missing table — no-op guard', () => {
    test('runMigration201 on an empty DB does not throw', () => {
      expect(() => runMigration201(db)).not.toThrow();
    });
  });
});
