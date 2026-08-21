import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';

const SENTINEL = '__NEEDS_WORKSPACE_PATH__';

function createRoomsTable(db: BunDatabase): void {
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

function insertRoom(db: BunDatabase, id: string, defaultPath: string | null): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO rooms (id, name, allowed_paths, default_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, `Room ${id}`, '[]', defaultPath, now, now);
}

function runSentinelReplacementHook(
  db: BunDatabase,
  workspaceRoot: string | undefined
): { replacedCount: number; affectedIds: string[] } {
  const sentinelRows = db
    .prepare(`SELECT id FROM rooms WHERE default_path = '${SENTINEL}'`)
    .all() as Array<{ id: string }>;

  if (sentinelRows.length === 0) {
    return { replacedCount: 0, affectedIds: [] };
  }

  const ids = sentinelRows.map((r) => r.id);

  if (workspaceRoot) {
    db.prepare(`UPDATE rooms SET default_path = ? WHERE default_path = ?`).run(
      workspaceRoot,
      SENTINEL
    );
    return { replacedCount: sentinelRows.length, affectedIds: ids };
  } else {
    return { replacedCount: 0, affectedIds: ids };
  }
}

describe('Sentinel replacement startup hook', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-sentinel-hook', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, 'test.db');
    db = new BunDatabase(dbPath);
    db.exec('PRAGMA foreign_keys = OFF');
    createRoomsTable(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  test('replaces sentinel with workspaceRoot when workspaceRoot is available', () => {
    insertRoom(db, 'room-sentinel', SENTINEL);

    const result = runSentinelReplacementHook(db, '/home/user/workspace');

    expect(result.replacedCount).toBe(1);
    const row = db.prepare(`SELECT default_path FROM rooms WHERE id = 'room-sentinel'`).get() as {
      default_path: string;
    };
    expect(row.default_path).toBe('/home/user/workspace');
  });

  test('replaces all sentinel rooms in a single pass', () => {
    insertRoom(db, 'room-a', SENTINEL);
    insertRoom(db, 'room-b', SENTINEL);
    insertRoom(db, 'room-c', SENTINEL);

    const result = runSentinelReplacementHook(db, '/home/user/workspace');

    expect(result.replacedCount).toBe(3);

    for (const id of ['room-a', 'room-b', 'room-c']) {
      const row = db.prepare(`SELECT default_path FROM rooms WHERE id = ?`).get(id) as {
        default_path: string;
      };
      expect(row.default_path).toBe('/home/user/workspace');
    }
  });

  test('does not affect rooms with real default_path already set', () => {
    insertRoom(db, 'room-real', '/workspace/existing');
    insertRoom(db, 'room-sentinel', SENTINEL);

    runSentinelReplacementHook(db, '/home/user/workspace');

    const row = db.prepare(`SELECT default_path FROM rooms WHERE id = 'room-real'`).get() as {
      default_path: string;
    };
    expect(row.default_path).toBe('/workspace/existing');
  });

  test('returns affected room IDs when workspaceRoot is undefined', () => {
    insertRoom(db, 'room-orphan-1', SENTINEL);
    insertRoom(db, 'room-orphan-2', SENTINEL);

    const result = runSentinelReplacementHook(db, undefined);

    expect(result.replacedCount).toBe(0);
    expect(result.affectedIds).toHaveLength(2);
    expect(result.affectedIds).toContain('room-orphan-1');
    expect(result.affectedIds).toContain('room-orphan-2');

    for (const id of ['room-orphan-1', 'room-orphan-2']) {
      const row = db.prepare(`SELECT default_path FROM rooms WHERE id = ?`).get(id) as {
        default_path: string;
      };
      expect(row.default_path).toBe(SENTINEL);
    }
  });

  test('is a no-op when no sentinel rooms exist', () => {
    insertRoom(db, 'room-good', '/workspace/existing');

    const result = runSentinelReplacementHook(db, '/home/user/workspace');

    expect(result.replacedCount).toBe(0);
    expect(result.affectedIds).toHaveLength(0);

    const row = db.prepare(`SELECT default_path FROM rooms WHERE id = 'room-good'`).get() as {
      default_path: string;
    };
    expect(row.default_path).toBe('/workspace/existing');
  });

  test('is idempotent — running hook twice with workspaceRoot does not double-process', () => {
    insertRoom(db, 'room-s', SENTINEL);

    runSentinelReplacementHook(db, '/workspace/root');
    const result2 = runSentinelReplacementHook(db, '/workspace/root');
    expect(result2.replacedCount).toBe(0);

    const row = db.prepare(`SELECT default_path FROM rooms WHERE id = 'room-s'`).get() as {
      default_path: string;
    };
    expect(row.default_path).toBe('/workspace/root');
  });

  test('handles empty rooms table gracefully', () => {
    const result = runSentinelReplacementHook(db, '/workspace/root');
    expect(result.replacedCount).toBe(0);
    expect(result.affectedIds).toHaveLength(0);
  });
});
