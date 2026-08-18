import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import {
  createTables,
  runMigration122,
  runMigrations,
} from '../../../../../src/storage/schema/index.ts';

function columnNames(db: BunDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function tableExists(db: BunDatabase, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name?: string } | undefined;
  return !!row?.name;
}

function indexExists(db: BunDatabase, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(name) as { name?: string } | undefined;
  return !!row?.name;
}

function seedPreM122Schema(db: BunDatabase): void {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL DEFAULT 'worker',
			created_at TEXT NOT NULL,
			last_active_at TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			config TEXT NOT NULL DEFAULT '{}',
			metadata TEXT NOT NULL DEFAULT '{}',
			title TEXT NOT NULL DEFAULT '',
			session_context TEXT
		)
	`);
  db.exec(`
		CREATE TABLE sdk_messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			message_type TEXT NOT NULL,
			message_subtype TEXT,
			sdk_message TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			send_status TEXT DEFAULT 'consumed',
			origin TEXT
		)
	`);
  db.exec('PRAGMA foreign_keys = ON');
}

describe('Migration 122: derived columns + task_id on sdk_messages', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-122',
      `test-${Date.now()}-${Math.random()}`
    );
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
    db.exec('PRAGMA foreign_keys = ON');
  }, 10_000);

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
  }, 10_000);

  describe('fresh DB (all migrations applied)', () => {
    beforeEach(async () => {
      runMigrations(db, () => {});
      createTables(db);
    }, 30_000);

    test('sdk_messages has the new derived columns plus task_id', () => {
      const columns = columnNames(db, 'sdk_messages');
      expect(columns).toContain('is_renderable');
      expect(columns).toContain('is_terminal');
      expect(columns).toContain('parent_tool_use_id');
      expect(columns).toContain('task_id');
    });

    test('sdk_messages task_id index exists', () => {
      expect(indexExists(db, 'idx_sdk_messages_task_id')).toBe(true);
    });

    test('sdk_messages (task_id, session_id) composite index exists', () => {
      expect(indexExists(db, 'idx_sdk_messages_task_session')).toBe(true);
    });

    test('sdk_messages new derived-column indexes exist', () => {
      expect(indexExists(db, 'idx_sdk_messages_parent_tool_use_id')).toBe(true);
      expect(indexExists(db, 'idx_sdk_messages_renderable_terminal')).toBe(true);
    });

    test('legacy task_session_map table has been dropped', () => {
      expect(tableExists(db, 'task_session_map')).toBe(false);
    });
  });

  describe('backfill from pre-122 schema', () => {
    beforeEach(() => {
      seedPreM122Schema(db);
      const now = Date.now();
      const ts = new Date(now).toISOString();

      db.prepare(
        `INSERT INTO sessions (id, type, created_at, last_active_at, session_context) VALUES (?, ?, ?, ?, ?)`
      ).run('sess-task-agent', 'space_task_agent', ts, ts, JSON.stringify({ taskId: 'task-1' }));
      db.prepare(
        `INSERT INTO sessions (id, type, created_at, last_active_at, session_context) VALUES (?, ?, ?, ?, ?)`
      ).run('sess-coder', 'worker', ts, ts, JSON.stringify({ taskId: 'task-1' }));
      db.prepare(
        `INSERT INTO sessions (id, type, created_at, last_active_at, session_context) VALUES (?, ?, ?, ?, ?)`
      ).run('sess-orphan', 'worker', ts, ts, null);
      db.prepare(
        `INSERT INTO sessions (id, type, created_at, last_active_at, session_context) VALUES (?, ?, ?, ?, ?)`
      ).run('sess-malformed', 'worker', ts, ts, '{not-json');

      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?)`
      ).run(
        'msg-result',
        'sess-coder',
        'result',
        JSON.stringify({ type: 'result', subtype: 'success' }),
        ts
      );
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?)`
      ).run(
        'msg-user-tool-result',
        'sess-coder',
        'user',
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'abc', content: 'ok' }] },
        }),
        ts
      );
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?)`
      ).run(
        'msg-user-text',
        'sess-task-agent',
        'user',
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }),
        ts
      );
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?)`
      ).run(
        'msg-assistant-text',
        'sess-coder',
        'assistant',
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'response' }] },
        }),
        ts
      );
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?)`
      ).run(
        'msg-assistant-empty',
        'sess-coder',
        'assistant',
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: '   ' }] },
        }),
        ts
      );
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?)`
      ).run(
        'msg-subagent',
        'sess-coder',
        'assistant',
        JSON.stringify({
          type: 'assistant',
          parent_tool_use_id: 'parent-tu-1',
          message: { content: [{ type: 'text', text: 'sub' }] },
        }),
        ts
      );
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?)`
      ).run(
        'msg-orphan',
        'sess-orphan',
        'assistant',
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }),
        ts
      );
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
				 VALUES (?, ?, ?, ?, ?)`
      ).run(
        'msg-malformed-context',
        'sess-malformed',
        'assistant',
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }),
        ts
      );
    }, 30_000);

    test('is_terminal is set to 1 for result messages and 0 elsewhere', () => {
      runMigration122(db);
      const rows = db
        .prepare(`SELECT id, is_terminal FROM sdk_messages ORDER BY id`)
        .all() as Array<{ id: string; is_terminal: number }>;
      const map = new Map(rows.map((r) => [r.id, r.is_terminal]));
      expect(map.get('msg-result')).toBe(1);
      expect(map.get('msg-user-text')).toBe(0);
      expect(map.get('msg-assistant-text')).toBe(0);
    });

    test('parent_tool_use_id is extracted from JSON', () => {
      runMigration122(db);
      const subagent = db
        .prepare(`SELECT parent_tool_use_id FROM sdk_messages WHERE id = ?`)
        .get('msg-subagent') as { parent_tool_use_id: string | null };
      expect(subagent.parent_tool_use_id).toBe('parent-tu-1');
      const plain = db
        .prepare(`SELECT parent_tool_use_id FROM sdk_messages WHERE id = ?`)
        .get('msg-user-text') as { parent_tool_use_id: string | null };
      expect(plain.parent_tool_use_id).toBeNull();
    });

    test('is_renderable=0 for user rows with tool_result content', () => {
      runMigration122(db);
      const row = db
        .prepare(`SELECT is_renderable FROM sdk_messages WHERE id = ?`)
        .get('msg-user-tool-result') as { is_renderable: number };
      expect(row.is_renderable).toBe(0);
    });

    test('is_renderable=0 for assistant rows with no renderable content', () => {
      runMigration122(db);
      const row = db
        .prepare(`SELECT is_renderable FROM sdk_messages WHERE id = ?`)
        .get('msg-assistant-empty') as { is_renderable: number };
      expect(row.is_renderable).toBe(0);
    });

    test('is_renderable=1 for normal user/assistant rows and result rows', () => {
      runMigration122(db);
      const ids = ['msg-user-text', 'msg-assistant-text', 'msg-result'];
      const placeholders = ids.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT id, is_renderable FROM sdk_messages WHERE id IN (${placeholders})`)
        .all(...ids) as Array<{ id: string; is_renderable: number }>;
      for (const row of rows) {
        expect(row.is_renderable).toBe(1);
      }
    });

    test('task_id is backfilled from sessions.session_context.taskId', () => {
      runMigration122(db);
      const rows = db.prepare(`SELECT id, task_id FROM sdk_messages ORDER BY id`).all() as Array<{
        id: string;
        task_id: string | null;
      }>;
      const map = new Map(rows.map((r) => [r.id, r.task_id]));
      expect(map.get('msg-result')).toBe('task-1');
      expect(map.get('msg-user-tool-result')).toBe('task-1');
      expect(map.get('msg-user-text')).toBe('task-1');
      expect(map.get('msg-assistant-text')).toBe('task-1');
      expect(map.get('msg-subagent')).toBe('task-1');
    });

    test('task_id is null for sessions without a task context', () => {
      runMigration122(db);
      const orphan = db
        .prepare(`SELECT task_id FROM sdk_messages WHERE id = ?`)
        .get('msg-orphan') as { task_id: string | null };
      expect(orphan.task_id).toBeNull();
    });

    test('task_id is null for sessions with malformed session_context JSON', () => {
      runMigration122(db);
      const malformed = db
        .prepare(`SELECT task_id FROM sdk_messages WHERE id = ?`)
        .get('msg-malformed-context') as { task_id: string | null };
      expect(malformed.task_id).toBeNull();
    });

    test('drops the legacy task_session_map table', () => {
      db.exec(`
				CREATE TABLE task_session_map (
					task_id TEXT NOT NULL,
					session_id TEXT NOT NULL,
					kind TEXT NOT NULL,
					role TEXT NOT NULL,
					label TEXT NOT NULL,
					node_execution_id TEXT,
					created_at INTEGER NOT NULL,
					PRIMARY KEY (task_id, session_id)
				)
			`);
      runMigration122(db);
      expect(tableExists(db, 'task_session_map')).toBe(false);
    });

    test('is idempotent — running a second time produces the same state', () => {
      runMigration122(db);
      const sdkBefore = db
        .prepare(
          `SELECT COUNT(*) AS n FROM sdk_messages WHERE is_renderable IS NOT NULL AND is_terminal IS NOT NULL`
        )
        .get() as { n: number };
      const taskIdBefore = (
        db.prepare(`SELECT COUNT(*) AS n FROM sdk_messages WHERE task_id = 'task-1'`).get() as {
          n: number;
        }
      ).n;

      expect(() => runMigration122(db)).not.toThrow();

      const sdkAfter = db
        .prepare(
          `SELECT COUNT(*) AS n FROM sdk_messages WHERE is_renderable IS NOT NULL AND is_terminal IS NOT NULL`
        )
        .get() as { n: number };
      const taskIdAfter = (
        db.prepare(`SELECT COUNT(*) AS n FROM sdk_messages WHERE task_id = 'task-1'`).get() as {
          n: number;
        }
      ).n;

      expect(sdkAfter.n).toBe(sdkBefore.n);
      expect(taskIdAfter).toBe(taskIdBefore);
      expect(tableExists(db, 'task_session_map')).toBe(false);
    });

    test('second run does not rewrite already-correct derived rows', () => {
      runMigration122(db);
      const before = db
        .prepare(
          `SELECT id, is_renderable, is_terminal, parent_tool_use_id FROM sdk_messages ORDER BY id`
        )
        .all() as Array<{
        id: string;
        is_renderable: number;
        is_terminal: number;
        parent_tool_use_id: string | null;
      }>;

      runMigration122(db);

      const after = db
        .prepare(
          `SELECT id, is_renderable, is_terminal, parent_tool_use_id FROM sdk_messages ORDER BY id`
        )
        .all() as Array<{
        id: string;
        is_renderable: number;
        is_terminal: number;
        parent_tool_use_id: string | null;
      }>;
      expect(after).toEqual(before);
    });

    test('task_id backfill skips worker sessions with no taskId in context', () => {
      runMigration122(db);
      const orphan = db
        .prepare(`SELECT task_id FROM sdk_messages WHERE id = ?`)
        .get('msg-orphan') as { task_id: string | null };
      expect(orphan.task_id).toBeNull();

      expect(() => runMigration122(db)).not.toThrow();
      const orphan2 = db
        .prepare(`SELECT task_id FROM sdk_messages WHERE id = ?`)
        .get('msg-orphan') as { task_id: string | null };
      expect(orphan2.task_id).toBeNull();
    });
  });

  describe('missing tables — no-op guards', () => {
    test('runMigration122 on an empty DB does not throw', () => {
      expect(() => runMigration122(db)).not.toThrow();
      expect(tableExists(db, 'sdk_messages')).toBe(false);
      expect(tableExists(db, 'task_session_map')).toBe(false);
    });

    test('runMigration122 with only sdk_messages adds derived columns including task_id', () => {
      db.exec(`
				CREATE TABLE sdk_messages (
					id TEXT PRIMARY KEY,
					session_id TEXT NOT NULL,
					message_type TEXT NOT NULL,
					message_subtype TEXT,
					sdk_message TEXT NOT NULL,
					timestamp TEXT NOT NULL
				)
			`);
      expect(() => runMigration122(db)).not.toThrow();
      const cols = columnNames(db, 'sdk_messages');
      expect(cols).toContain('is_renderable');
      expect(cols).toContain('is_terminal');
      expect(cols).toContain('parent_tool_use_id');
      expect(cols).toContain('task_id');
      expect(indexExists(db, 'idx_sdk_messages_task_id')).toBe(true);
      expect(indexExists(db, 'idx_sdk_messages_task_session')).toBe(true);
    });
  });
});
