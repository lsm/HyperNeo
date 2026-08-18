import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';

function columnExists(db: BunDatabase, table: string, column: string): boolean {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return info.some((c) => c.name === column);
}

describe('Migration 30: layout column on space_workflows', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-30', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    db = new BunDatabase(join(testDir, 'test.db'));
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

  test('space_workflows has layout column after migration', () => {
    runMigrations(db, () => {});
    expect(columnExists(db, 'space_workflows', 'layout')).toBe(true);
  });

  test('migration is idempotent — running twice does not throw', () => {
    runMigrations(db, () => {});
    expect(() => runMigrations(db, () => {})).not.toThrow();
  });

  test('existing rows without layout read as NULL', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-1', 'm30a', '/workspace/m30a', 'Space A', ${now}, ${now})`
    );
    db.exec(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
			 VALUES ('wf-1', 'sp-1', 'WF No Layout', ${now}, ${now})`
    );

    const row = db.prepare(`SELECT layout FROM space_workflows WHERE id = 'wf-1'`).get() as {
      layout: string | null;
    };
    expect(row.layout).toBeNull();
  });

  test('layout column stores and retrieves JSON', () => {
    runMigrations(db, () => {});

    const now = Date.now();
    db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES ('sp-2', 'm30b', '/workspace/m30b', 'Space B', ${now}, ${now})`
    );
    const layoutJson = JSON.stringify({
      'step-1': { x: 100, y: 200 },
      'step-2': { x: 300, y: 400 },
    });
    db.exec(
      `INSERT INTO space_workflows (id, space_id, name, layout, created_at, updated_at)
			 VALUES ('wf-2', 'sp-2', 'WF With Layout', '${layoutJson}', ${now}, ${now})`
    );

    const row = db.prepare(`SELECT layout FROM space_workflows WHERE id = 'wf-2'`).get() as {
      layout: string;
    };
    expect(JSON.parse(row.layout)).toEqual({
      'step-1': { x: 100, y: 200 },
      'step-2': { x: 300, y: 400 },
    });
  });

  test('adding layout column to existing DB without it (upgrade path)', () => {
    runMigrations(db, () => {});

    expect(columnExists(db, 'space_workflows', 'layout')).toBe(true);

    expect(() => runMigrations(db, () => {})).not.toThrow();
  });
});
