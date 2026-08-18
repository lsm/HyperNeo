import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../../../src/storage/schema';
import { runMigration177, runMigrations } from '../../../../../src/storage/schema/migrations.ts';

function columnNames(db: BunDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function seedPreM177Schema(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );
    CREATE TABLE sdk_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      message_subtype TEXT,
      send_status TEXT,
      parent_tool_use_id TEXT,
      timestamp TEXT NOT NULL
    );
  `);
}

function insertMessage(
  db: BunDatabase,
  id: string,
  sessionId: string,
  type: string,
  opts: { subtype?: string | null; sendStatus?: string | null; parent?: string | null } = {}
): void {
  db.prepare(
    `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, send_status, parent_tool_use_id, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    sessionId,
    type,
    opts.subtype ?? null,
    opts.sendStatus ?? null,
    opts.parent ?? null,
    '2026-01-01T00:00:00Z'
  );
}

function visibleCount(db: BunDatabase, sessionId: string): number {
  return (
    db.prepare(`SELECT visible_message_count AS n FROM sessions WHERE id = ?`).get(sessionId) as {
      n: number;
    }
  ).n;
}

describe('Migration 177: sessions.visible_message_count counter + backfill', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-177',
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

  describe('pre-M177 schema — add column + backfill', () => {
    beforeEach(() => {
      seedPreM177Schema(db);
      db.prepare(`INSERT INTO sessions (id, title) VALUES (?, '')`).run('s1');
      db.prepare(`INSERT INTO sessions (id, title) VALUES (?, '')`).run('s2');
      insertMessage(db, 'a1', 's1', 'assistant');
      insertMessage(db, 'a2', 's1', 'user', { sendStatus: 'consumed' });
      insertMessage(db, 'a3', 's1', 'user', { sendStatus: 'failed' });
      insertMessage(db, 'a4', 's1', 'user', { sendStatus: 'deferred' });
      insertMessage(db, 'a5', 's1', 'user', { sendStatus: 'enqueued' });
      insertMessage(db, 'a6', 's1', 'system', { subtype: 'session_state_changed' });
      insertMessage(db, 'a7', 's1', 'system', { subtype: 'thinking_tokens' });
      insertMessage(db, 'a8', 's1', 'assistant', { parent: 'toolu_1' });
    });

    test('adds the NOT NULL DEFAULT 0 column', () => {
      expect(columnNames(db, 'sessions')).not.toContain('visible_message_count');
      runMigration177(db);
      expect(columnNames(db, 'sessions')).toContain('visible_message_count');
    });

    test('backfills the badge predicate (3 visible for s1, 0 for s2)', () => {
      runMigration177(db);
      expect(visibleCount(db, 's1')).toBe(3);
      expect(visibleCount(db, 's2')).toBe(0);
    });

    test('is idempotent — a second run recomputes the same totals', () => {
      runMigration177(db);
      const after1 = { s1: visibleCount(db, 's1'), s2: visibleCount(db, 's2') };
      expect(() => runMigration177(db)).not.toThrow();
      const after2 = { s1: visibleCount(db, 's1'), s2: visibleCount(db, 's2') };
      expect(after2).toEqual(after1);
    });
  });

  describe('fresh DB (all migrations applied)', () => {
    beforeEach(() => {
      createTables(db);
      runMigrations(db, () => {});
    });

    test('sessions carries visible_message_count from createTables', () => {
      expect(columnNames(db, 'sessions')).toContain('visible_message_count');
    });

    test('re-running migration 177 recomputes without error', () => {
      db.prepare(
        `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata)
         VALUES ('s1', '', '2026-01-01', '2026-01-01', 'active', '{}', '{}')`
      ).run();
      runMigration177(db);
      expect(visibleCount(db, 's1')).toBe(0);
    });
  });

  describe('missing tables — no-op guards', () => {
    test('runMigration177 on an empty DB does not throw', () => {
      expect(() => runMigration177(db)).not.toThrow();
    });

    test('runMigration177 skips backfill when sessions exists but sdk_messages does not', () => {
      db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL)`);
      db.prepare(`INSERT INTO sessions (id, title) VALUES ('s1', '')`).run();
      expect(() => runMigration177(db)).not.toThrow();
      expect(columnNames(db, 'sessions')).toContain('visible_message_count');
    });
  });
});
