import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables, runMigrations } from '../../../../../src/storage/schema';
import { runMigration200 } from '../../../../../src/storage/schema/migrations.ts';
import { SessionRepository } from '../../../../../src/storage/repositories/session-repository';

function tableExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

function generatedColumnNames(db: BunDatabase): string[] {
  const rows = db
    .prepare(`SELECT name FROM pragma_table_xinfo('sessions') WHERE hidden > 0`)
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function indexSql(db: BunDatabase, name: string): string | null {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name) as { sql?: string } | undefined;
  return row?.sql ?? null;
}

function queryPlan(db: BunDatabase, sql: string, ...params: Array<string | number>): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join(' | ');
}

function createPreM200SessionsTable(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_path TEXT,
      created_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      status TEXT NOT NULL,
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
  context: string | null,
  metadata = '{}'
): void {
  db.prepare(
    `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, type, session_context)
     VALUES (?, '', '/w', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'active', '{}', ?, ?, ?)`
  ).run(id, metadata, type, context);
}

describe('Migration 200: sessions session_context generated columns', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-200',
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

  describe('pre-M200 schema — add generated columns', () => {
    test('adds room_id, space_id and task_id as VIRTUAL generated columns', () => {
      createPreM200SessionsTable(db);
      expect(generatedColumnNames(db)).toEqual([]);
      runMigration200(db);
      expect(generatedColumnNames(db)).toEqual(['room_id', 'space_id', 'task_id']);
    });

    test('derives values from existing session_context rows', () => {
      createPreM200SessionsTable(db);
      insertSession(db, 'full', 'worker', '{"roomId":"r-1","spaceId":"sp-1","taskId":"t-1"}');
      insertSession(db, 'partial', 'worker', '{"spaceId":"sp-1"}');
      insertSession(db, 'empty', 'worker', '{}');
      insertSession(db, 'nullctx', 'worker', null);

      runMigration200(db);

      const rows = db
        .prepare(`SELECT id, room_id, space_id, task_id FROM sessions ORDER BY id`)
        .all() as Array<{
        id: string;
        room_id: string | null;
        space_id: string | null;
        task_id: string | null;
      }>;
      expect(rows).toEqual([
        { id: 'empty', room_id: null, space_id: null, task_id: null },
        { id: 'full', room_id: 'r-1', space_id: 'sp-1', task_id: 't-1' },
        { id: 'nullctx', room_id: null, space_id: null, task_id: null },
        { id: 'partial', room_id: null, space_id: 'sp-1', task_id: null },
      ]);
    });

    test('tracks session_context updates written after the migration', () => {
      createPreM200SessionsTable(db);
      insertSession(db, 's1', 'worker', null);
      runMigration200(db);

      db.prepare(
        `UPDATE sessions SET session_context = '{"roomId":"r-9","taskId":"t-9"}' WHERE id = 's1'`
      ).run();
      const row = db
        .prepare(`SELECT room_id, space_id, task_id FROM sessions WHERE id = 's1'`)
        .get() as { room_id: string | null; space_id: string | null; task_id: string | null };
      expect(row).toEqual({ room_id: 'r-9', space_id: null, task_id: 't-9' });
    });

    test('tolerates malformed session_context rows without throwing', () => {
      createPreM200SessionsTable(db);
      insertSession(db, 'corrupt', 'worker', 'not-json');
      insertSession(db, 'fine', 'worker', '{"spaceId":"sp-1"}');

      expect(() => runMigration200(db)).not.toThrow();
      const row = db
        .prepare(`SELECT room_id, space_id, task_id FROM sessions WHERE id = 'corrupt'`)
        .get() as { room_id: string | null; space_id: string | null; task_id: string | null };
      expect(row).toEqual({ room_id: null, space_id: null, task_id: null });
      const filtered = db
        .prepare(`SELECT COUNT(*) AS c FROM sessions WHERE room_id IS NULL AND space_id IS NULL`)
        .get() as { c: number };
      expect(filtered.c).toBe(1);
    });

    test('replaces the provenance expression index with the space_id column form', () => {
      createPreM200SessionsTable(db);
      db.exec(
        `CREATE INDEX idx_sessions_space_agent_provenance
           ON sessions(json_extract(session_context, '$.spaceId'), json_extract(metadata, '$.promptProvenance.agentId'))`
      );

      runMigration200(db);

      const sql = indexSql(db, 'idx_sessions_space_agent_provenance');
      expect(sql).toContain('(space_id,');
      expect(sql).not.toContain('$.spaceId');
      expect(indexSql(db, 'idx_sessions_room_id')).toContain('room_id');
    });

    test('is idempotent — a second run does not throw or duplicate columns', () => {
      createPreM200SessionsTable(db);
      insertSession(db, 's1', 'worker', '{"roomId":"r-1"}');
      runMigration200(db);
      expect(() => runMigration200(db)).not.toThrow();
      expect(generatedColumnNames(db)).toEqual(['room_id', 'space_id', 'task_id']);
    });

    test('no-ops on an empty DB', () => {
      expect(() => runMigration200(db)).not.toThrow();
      expect(tableExists(db, 'sessions')).toBe(false);
    });

    test('no-ops when sessions lacks session_context', () => {
      db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT)`);
      expect(() => runMigration200(db)).not.toThrow();
      expect(generatedColumnNames(db)).toEqual([]);
    });
  });

  describe('query plans use the generated columns', () => {
    test('findByRoomId resolves through idx_sessions_room_id', () => {
      createPreM200SessionsTable(db);
      insertSession(db, 'room-1', 'room', '{"roomId":"r-1"}');
      runMigration200(db);

      const plan = queryPlan(
        db,
        `SELECT * FROM sessions WHERE type = 'room' AND room_id = ?`,
        'r-1'
      );
      expect(plan).toContain('idx_sessions_room_id');
    });

    test('space + provenance lookups resolve through the provenance index', () => {
      createPreM200SessionsTable(db);
      insertSession(db, 'sp-worker', 'worker', '{"spaceId":"sp-1"}');
      runMigration200(db);

      const plan = queryPlan(
        db,
        `SELECT * FROM sessions
          WHERE space_id = ? AND json_extract(metadata, '$.promptProvenance.agentId') = ?`,
        'sp-1',
        'agent-1'
      );
      expect(plan).toContain('idx_sessions_space_agent_provenance');
    });
  });

  describe('repository filters behave identically on the persisted columns', () => {
    test('listSessions excludes room/space sessions and includes human ones', () => {
      createPreM200SessionsTable(db);
      insertSession(db, 'human-1', 'worker', null);
      insertSession(db, 'human-2', 'general', '{"other":"value"}');
      insertSession(db, 'room-1', 'room', '{"roomId":"r-1"}');
      insertSession(db, 'room-member', 'worker', '{"roomId":"r-1"}');
      insertSession(db, 'space-worker', 'worker', '{"spaceId":"sp-1"}');
      insertSession(db, 'room-chat', 'room_chat', '{"roomId":"r-1"}');
      runMigration200(db);

      const repository = new SessionRepository(db as any);
      const listed = repository.listSessions();
      expect(listed.map((s) => s.id).sort()).toEqual(['human-1', 'human-2']);

      const withSpace = repository.listSessions({ includeSpaceSessions: true });
      expect(withSpace.map((s) => s.id).sort()).toEqual(['human-1', 'human-2', 'space-worker']);

      expect(repository.findByRoomId('r-1')?.id).toBe('room-1');
      expect(repository.findByRoomId('missing')).toBeNull();
    });

    test('listSessionsBySpaceAgent matches on spaceId and provenance agentId', () => {
      createPreM200SessionsTable(db);
      insertSession(
        db,
        'a1',
        'worker',
        '{"spaceId":"sp-1"}',
        '{"promptProvenance":{"agentId":"agent-1"}}'
      );
      insertSession(
        db,
        'a2',
        'worker',
        '{"spaceId":"sp-1"}',
        '{"promptProvenance":{"agentId":"agent-2"}}'
      );
      insertSession(db, 'other-space', 'worker', '{"spaceId":"sp-2"}');
      runMigration200(db);

      const repository = new SessionRepository(db as any);
      expect(repository.listSessionsBySpaceAgent('sp-1', 'agent-1').map((s) => s.id)).toEqual([
        'a1',
      ]);
    });
  });

  describe('fresh DB (all migrations applied)', () => {
    beforeEach(() => {
      createTables(db);
      runMigrations(db, () => {});
    });

    test('sessions carries the generated columns', () => {
      expect(generatedColumnNames(db)).toEqual(['room_id', 'space_id', 'task_id']);
    });

    test('migrations then createTables converge on the same indexes', () => {
      expect(indexSql(db, 'idx_sessions_room_id')).toContain('room_id');
      expect(indexSql(db, 'idx_sessions_space_agent_provenance')).toContain('(space_id,');
    });
  });
});
