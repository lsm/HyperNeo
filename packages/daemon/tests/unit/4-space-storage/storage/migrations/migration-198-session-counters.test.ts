import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables, runMigrations } from '../../../../../src/storage/schema';
import { runMigration198 } from '../../../../../src/storage/schema/m198-session-counters';
import {
  SESSION_COUNTERS_TABLE_SQL,
  createSessionCounters,
  humanSessionPredicate,
} from '../../../../../src/storage/schema/session-counters';

function tableExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

function counters(db: BunDatabase): { total: number; archived: number } {
  const row = db
    .prepare(`SELECT total_count, archived_count FROM session_counters WHERE id = 1`)
    .get() as { total_count: number; archived_count: number } | undefined;
  return { total: row?.total_count ?? 0, archived: row?.archived_count ?? 0 };
}

function liveCount(db: BunDatabase): { total: number; archived: number } {
  const predicate = humanSessionPredicate('');
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE ${predicate}`).get() as { c: number }
  ).c;
  const archived = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM sessions WHERE ${predicate} AND status = 'archived'`)
      .get() as { c: number }
  ).c;
  return { total, archived };
}

function expectCounters(db: BunDatabase): void {
  expect(counters(db)).toEqual(liveCount(db));
}

function createSessionsTable(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_path TEXT,
      created_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived')),
      config TEXT NOT NULL,
      metadata TEXT NOT NULL,
      is_worktree INTEGER DEFAULT 0,
      worktree_path TEXT,
      main_repo_path TEXT,
      worktree_branch TEXT,
      git_branch TEXT,
      sdk_session_id TEXT,
      acp_session_id TEXT,
      sdk_origin_path TEXT,
      available_commands TEXT,
      processing_state TEXT,
      archived_at TEXT,
      parent_id TEXT,
      type TEXT DEFAULT 'worker',
      session_context TEXT
    )
  `);
}

function insertSession(
  db: BunDatabase,
  id: string,
  type: string,
  status: string,
  context: string | null
): void {
  db.prepare(
    `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, type, session_context)
     VALUES (?, '', '/w', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?, '{}', '{}', ?, ?)`
  ).run(id, status, type, context);
}

describe('session_counters: maintained total/archived counts', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-197',
      `test-${Date.now()}-${Math.random()}`
    );
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

  describe('migration 197 backfill', () => {
    test('backfills totals from an existing sessions table, excluding space/room sessions', () => {
      createSessionsTable(db);
      insertSession(db, 'h1', 'worker', 'active', null);
      insertSession(db, 'h2', 'general', 'active', '{}');
      insertSession(db, 'h3', 'worker', 'archived', null);
      insertSession(db, 'sp1', 'space_chat', 'active', null);
      insertSession(db, 'sp2', 'worker', 'active', '{"spaceId":"sp-1"}');
      insertSession(db, 'rm1', 'room_chat', 'active', '{"roomId":"r-1"}');
      insertSession(db, 'ws1', 'general', 'active', '{"roomId":"r-1","spaceId":"sp-1"}');

      runMigration198(db);

      expect(counters(db)).toEqual({ total: 3, archived: 1 });
      expectCounters(db);
    });

    test('is idempotent — a second run recomputes the same totals', () => {
      createSessionsTable(db);
      insertSession(db, 'h1', 'worker', 'active', null);
      insertSession(db, 'h2', 'worker', 'archived', null);
      runMigration198(db);
      const first = counters(db);
      expect(() => runMigration198(db)).not.toThrow();
      expect(counters(db)).toEqual(first);
      expectCounters(db);
    });

    test('no-ops on an empty DB', () => {
      expect(() => runMigration198(db)).not.toThrow();
      expect(tableExists(db, 'session_counters')).toBe(false);
    });

    test('backfill tolerates a corrupt (non-JSON) session_context row', () => {
      createSessionsTable(db);
      insertSession(db, 'h1', 'worker', 'active', null);
      insertSession(db, 'corrupt', 'worker', 'active', 'not-json');
      insertSession(db, 'sp1', 'room_chat', 'active', '{"roomId":"r-1"}');

      expect(() => runMigration198(db)).not.toThrow();
      expect(counters(db)).toEqual({ total: 2, archived: 0 });
      expectCounters(db);
    });
  });

  describe('trigger maintenance on a fresh DB', () => {
    beforeEach(() => {
      createTables(db);
      runMigrations(db, () => {});
    });

    test('seeds a zeroed counter row', () => {
      expect(counters(db)).toEqual({ total: 0, archived: 0 });
    });

    test('keeps totals correct across create/archive/unarchive/delete and exclusions', () => {
      insertSession(db, 'h1', 'worker', 'active', null);
      expectCounters(db);
      insertSession(db, 'sp1', 'worker', 'active', '{"spaceId":"sp-1"}');
      insertSession(db, 'rm1', 'room_chat', 'active', '{"roomId":"r-1"}');
      insertSession(db, 'pl1', 'planner', 'active', null);
      expectCounters(db);

      db.prepare(`UPDATE sessions SET status = 'archived' WHERE id = 'h1'`).run();
      expectCounters(db);

      db.prepare(`UPDATE sessions SET status = 'active' WHERE id = 'h1'`).run();
      expectCounters(db);

      db.prepare(`DELETE FROM sessions WHERE id = 'h1'`).run();
      expectCounters(db);

      insertSession(db, 'h2', 'worker', 'archived', null);
      expectCounters(db);
      db.prepare(`DELETE FROM sessions WHERE id = 'h2'`).run();
      expectCounters(db);
    });

    test('deleting excluded sessions leaves totals unchanged', () => {
      insertSession(db, 'h1', 'worker', 'active', null);
      insertSession(db, 'sp1', 'worker', 'active', '{"spaceId":"sp-1"}');
      insertSession(db, 'rm1', 'room_chat', 'active', '{"roomId":"r-1"}');
      expectCounters(db);

      db.prepare(`DELETE FROM sessions WHERE id = 'sp1'`).run();
      expectCounters(db);
      db.prepare(`DELETE FROM sessions WHERE id = 'rm1'`).run();
      expectCounters(db);
    });

    test('tracks type flips in and out of the human predicate', () => {
      insertSession(db, 'h1', 'worker', 'active', null);
      expectCounters(db);

      db.prepare(`UPDATE sessions SET type = 'planner' WHERE id = 'h1'`).run();
      expectCounters(db);

      db.prepare(`UPDATE sessions SET type = 'worker' WHERE id = 'h1'`).run();
      expectCounters(db);
    });

    test('tracks context flips that add/remove spaceId or roomId', () => {
      insertSession(db, 'h1', 'worker', 'active', null);
      expectCounters(db);

      db.prepare(
        `UPDATE sessions SET session_context = '{"spaceId":"sp-1"}' WHERE id = 'h1'`
      ).run();
      expectCounters(db);

      db.prepare(`UPDATE sessions SET session_context = NULL WHERE id = 'h1'`).run();
      expectCounters(db);

      db.prepare(`UPDATE sessions SET session_context = '{"roomId":"r-1"}' WHERE id = 'h1'`).run();
      expectCounters(db);
    });

    test('does not fire on non-membership column updates', () => {
      insertSession(db, 'h1', 'worker', 'active', null);
      const before = counters(db);

      db.prepare(`UPDATE sessions SET title = 'renamed' WHERE id = 'h1'`).run();
      expect(counters(db)).toEqual(before);

      db.prepare(
        `UPDATE sessions SET visible_message_count = visible_message_count + 1 WHERE id = 'h1'`
      ).run();
      expect(counters(db)).toEqual(before);
    });

    test('re-archiving an already-archived session does not double count', () => {
      insertSession(db, 'h1', 'worker', 'archived', null);
      expectCounters(db);

      db.prepare(`UPDATE sessions SET status = 'archived' WHERE id = 'h1'`).run();
      expectCounters(db);
    });
  });

  describe('schema parity for createSessionCounters', () => {
    test('SESSION_COUNTERS_TABLE_SQL creates a single-row table', () => {
      createSessionsTable(db);
      db.exec(SESSION_COUNTERS_TABLE_SQL);
      expect(tableExists(db, 'session_counters')).toBe(true);
      expect(counters(db)).toEqual({ total: 0, archived: 0 });
    });

    test('triggers tolerate a corrupt (non-JSON) session_context row', () => {
      createSessionsTable(db);
      createSessionCounters(db);
      insertSession(db, 'corrupt', 'worker', 'active', 'not-json');
      expectCounters(db);

      db.prepare(`UPDATE sessions SET status = 'archived' WHERE id = 'corrupt'`).run();
      expectCounters(db);

      db.prepare(`DELETE FROM sessions WHERE id = 'corrupt'`).run();
      expectCounters(db);
    });

    test('createSessionCounters is idempotent', () => {
      createSessionsTable(db);
      db.exec(SESSION_COUNTERS_TABLE_SQL);
      expect(() => createSessionCounters(db)).not.toThrow();
      expect(() => createSessionCounters(db)).not.toThrow();
      expectCounters(db);
    });
  });
});
