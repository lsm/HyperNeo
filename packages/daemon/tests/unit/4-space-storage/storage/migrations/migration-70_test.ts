import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigration70 } from '../../../../../src/storage/schema/migrations.ts';

function createLegacyRoomsTable(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS rooms (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			allowed_paths TEXT DEFAULT '[]',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
}

function createFullRoomsTable(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS rooms (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			allowed_paths TEXT DEFAULT '[]',
			default_path TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
}

function insertRoom(
  db: BunDatabase,
  id: string,
  allowedPaths: string | null,
  defaultPath?: string | null
): void {
  const now = Date.now();
  if (defaultPath !== undefined) {
    db.prepare(
      `INSERT INTO rooms (id, name, allowed_paths, default_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, `Room ${id}`, allowedPaths, defaultPath ?? null, now, now);
  } else {
    db.prepare(
      `INSERT INTO rooms (id, name, allowed_paths, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run(id, `Room ${id}`, allowedPaths, now, now);
  }
}

describe('Migration 70: Backfill default_path for existing rooms', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-70', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, 'test.db');
    db = new BunDatabase(dbPath);
    db.exec('PRAGMA foreign_keys = OFF');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  test('backfills default_path from allowed_paths[0].path for rooms with null default_path', () => {
    createFullRoomsTable(db);
    insertRoom(
      db,
      'room-1',
      JSON.stringify([{ path: '/workspace/project', label: 'project' }]),
      null
    );

    runMigration70(db);

    const row = db.prepare(`SELECT default_path FROM rooms WHERE id = 'room-1'`).get() as {
      default_path: string;
    };
    expect(row.default_path).toBe('/workspace/project');
  });

  test('sets sentinel when allowed_paths is empty array and default_path is null', () => {
    createFullRoomsTable(db);
    insertRoom(db, 'room-empty', JSON.stringify([]), null);

    runMigration70(db);

    const row = db.prepare(`SELECT default_path FROM rooms WHERE id = 'room-empty'`).get() as {
      default_path: string;
    };
    expect(row.default_path).toBe('__NEEDS_WORKSPACE_PATH__');
  });

  test('sets sentinel when allowed_paths is null and default_path is null', () => {
    createFullRoomsTable(db);
    insertRoom(db, 'room-null-paths', null, null);

    runMigration70(db);

    const row = db.prepare(`SELECT default_path FROM rooms WHERE id = 'room-null-paths'`).get() as {
      default_path: string;
    };
    expect(row.default_path).toBe('__NEEDS_WORKSPACE_PATH__');
  });

  test('does not overwrite rooms that already have default_path set', () => {
    createFullRoomsTable(db);
    insertRoom(
      db,
      'room-has-path',
      JSON.stringify([{ path: '/workspace/other' }]),
      '/workspace/existing'
    );

    runMigration70(db);

    const row = db.prepare(`SELECT default_path FROM rooms WHERE id = 'room-has-path'`).get() as {
      default_path: string;
    };
    expect(row.default_path).toBe('/workspace/existing');
  });

  test('handles multiple rooms with mixed states correctly', () => {
    createFullRoomsTable(db);
    insertRoom(
      db,
      'room-a',
      JSON.stringify([{ path: '/workspace/a' }, { path: '/workspace/b' }]),
      null
    );
    insertRoom(db, 'room-b', JSON.stringify([]), null);
    insertRoom(db, 'room-c', JSON.stringify([{ path: '/workspace/c' }]), '/workspace/existing-c');

    runMigration70(db);

    const a = db.prepare(`SELECT default_path FROM rooms WHERE id = 'room-a'`).get() as {
      default_path: string;
    };
    const b = db.prepare(`SELECT default_path FROM rooms WHERE id = 'room-b'`).get() as {
      default_path: string;
    };
    const c = db.prepare(`SELECT default_path FROM rooms WHERE id = 'room-c'`).get() as {
      default_path: string;
    };

    expect(a.default_path).toBe('/workspace/a');
    expect(b.default_path).toBe('__NEEDS_WORKSPACE_PATH__');
    expect(c.default_path).toBe('/workspace/existing-c');
  });

  test('uses only the first entry from allowed_paths', () => {
    createFullRoomsTable(db);
    insertRoom(
      db,
      'room-multi',
      JSON.stringify([
        { path: '/workspace/first' },
        { path: '/workspace/second' },
        { path: '/workspace/third' },
      ]),
      null
    );

    runMigration70(db);

    const row = db.prepare(`SELECT default_path FROM rooms WHERE id = 'room-multi'`).get() as {
      default_path: string;
    };
    expect(row.default_path).toBe('/workspace/first');
  });

  test('is idempotent — running twice does not error or change values', () => {
    createFullRoomsTable(db);
    insertRoom(db, 'room-idem', JSON.stringify([{ path: '/workspace/idem' }]), null);

    runMigration70(db);
    expect(() => runMigration70(db)).not.toThrow();

    const row = db.prepare(`SELECT default_path FROM rooms WHERE id = 'room-idem'`).get() as {
      default_path: string;
    };
    expect(row.default_path).toBe('/workspace/idem');
  });

  test('is idempotent with sentinel — sentinel is not overwritten on second run', () => {
    createFullRoomsTable(db);
    insertRoom(db, 'room-sentinel', JSON.stringify([]), null);

    runMigration70(db);
    expect(() => runMigration70(db)).not.toThrow();

    const row = db.prepare(`SELECT default_path FROM rooms WHERE id = 'room-sentinel'`).get() as {
      default_path: string;
    };
    expect(row.default_path).toBe('__NEEDS_WORKSPACE_PATH__');
  });

  test('is no-op when rooms table does not exist', () => {
    expect(() => runMigration70(db)).not.toThrow();
  });

  test('handles malformed JSON in allowed_paths gracefully — falls back to sentinel', () => {
    createFullRoomsTable(db);
    insertRoom(db, 'room-bad-json', 'not-valid-json', null);

    runMigration70(db);

    const row = db.prepare(`SELECT default_path FROM rooms WHERE id = 'room-bad-json'`).get() as {
      default_path: string;
    };
    expect(row.default_path).toBe('__NEEDS_WORKSPACE_PATH__');
  });
});
