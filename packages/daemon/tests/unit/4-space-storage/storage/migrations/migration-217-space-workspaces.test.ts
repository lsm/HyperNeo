import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration217 } from '../../../../../src/storage/schema/m217-space-workspaces.ts';

interface WorkspaceRow {
  id: string;
  space_id: string;
  path: string;
  label: string;
  is_primary: number;
  created_at: number;
  updated_at: number;
}

function insertSpace(db: Database, id: string, workspacePath: string, name: string = id): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, id, workspacePath, name, now, now, 'active');
}

function workspacesBySpace(db: Database, spaceId: string): WorkspaceRow[] {
  return db
    .prepare(
      `SELECT id, space_id, path, label, is_primary, created_at, updated_at
       FROM space_workspaces
       WHERE space_id = ?
       ORDER BY path`
    )
    .all(spaceId) as WorkspaceRow[];
}

function hasMigrationMarker(db: Database, key: string): boolean {
  const row = db.prepare(`SELECT key FROM migration_markers WHERE key = ?`).get(key);
  return !!row;
}

let db: Database;

describe('migration 217: space_workspaces table and primary backfill', () => {
  beforeAll(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    createTables(db);
    runMigrations(db, () => {});
  });

  afterAll(() => {
    try {
      db.close();
    } catch {}
  });

  beforeEach(() => {
    db.exec('DROP TABLE IF EXISTS space_workspaces');
    db.prepare(`DELETE FROM migration_markers WHERE key = ?`).run('migration_217');
    db.prepare(`DELETE FROM spaces`).run();
  });

  test('creates the table and backfills exactly one primary row per existing space', () => {
    insertSpace(db, 'sp-1', '/home/user/project');
    insertSpace(db, 'sp-2', '/tmp/worktree/');

    runMigration217(db);

    const rows1 = workspacesBySpace(db, 'sp-1');
    expect(rows1).toHaveLength(1);
    expect(rows1[0].path).toBe('/home/user/project');
    expect(rows1[0].label).toBe('project');
    expect(rows1[0].is_primary).toBe(1);

    const rows2 = workspacesBySpace(db, 'sp-2');
    expect(rows2).toHaveLength(1);
    expect(rows2[0].path).toBe('/tmp/worktree/');
    expect(rows2[0].label).toBe('worktree');
    expect(rows2[0].is_primary).toBe(1);
  });

  test('leaves spaces.workspace_path untouched', () => {
    insertSpace(db, 'sp-1', '/home/user/project');

    runMigration217(db);

    const row = db.prepare(`SELECT workspace_path FROM spaces WHERE id = ?`).get('sp-1') as {
      workspace_path: string;
    };
    expect(row.workspace_path).toBe('/home/user/project');
  });

  test('rerunning is a no-op and does not duplicate primary rows', () => {
    insertSpace(db, 'sp-1', '/home/user/project');

    runMigration217(db);
    const firstId = workspacesBySpace(db, 'sp-1')[0].id;

    runMigration217(db);
    const rows = workspacesBySpace(db, 'sp-1');

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(firstId);
  });

  test('handles Windows-style paths and trailing separators', () => {
    insertSpace(db, 'sp-win', 'C:\\work\\repo\\');
    insertSpace(db, 'sp-mixed', '/a/b\\c');

    runMigration217(db);

    expect(workspacesBySpace(db, 'sp-win')[0].label).toBe('repo');
    expect(workspacesBySpace(db, 'sp-mixed')[0].label).toBe('c');
  });

  test('is safe when spaces has no workspace_path values', () => {
    db.prepare(`UPDATE spaces SET workspace_path = ''`).run();

    expect(() => runMigration217(db)).not.toThrow();
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM space_workspaces`).get() as { c: number })
      .c;
    expect(count).toBe(0);
  });

  test('fresh DB runs through migrations and has the table', () => {
    const fresh = new Database(':memory:');
    fresh.exec('PRAGMA foreign_keys = ON');
    createTables(fresh);
    runMigrations(fresh, () => {});

    const table = fresh
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get('space_workspaces');
    expect(table).toBeTruthy();

    const count = (
      fresh.prepare(`SELECT COUNT(*) AS c FROM space_workspaces`).get() as { c: number }
    ).c;
    expect(count).toBe(0);

    fresh.close();
  });

  test('runMigrations applies the backfill on a pre-existing populated DB', () => {
    insertSpace(db, 'sp-existing', '/srv/my-repo');

    runMigrations(db, () => {});

    expect(hasMigrationMarker(db, 'migration_217')).toBe(true);
    const rows = workspacesBySpace(db, 'sp-existing');
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe('/srv/my-repo');
    expect(rows[0].label).toBe('my-repo');
    expect(rows[0].is_primary).toBe(1);
  });
});
