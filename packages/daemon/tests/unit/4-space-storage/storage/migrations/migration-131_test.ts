import { Database } from '../../../../../src/storage/sqlite-compat';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runMigration66, runMigration131 } from '../../../../../src/storage/schema/index.ts';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
});

function tableSql(tableName: string): string {
  return (
    db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(tableName) as {
      sql: string;
    }
  ).sql;
}

describe('Migration 131: remove global Neo schema surface', () => {
  test('drops neo_activity_log', () => {
    db.exec(`CREATE TABLE neo_activity_log (id TEXT PRIMARY KEY)`);

    runMigration131(db);

    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'neo_activity_log'`)
      .get();
    expect(row).toBeNull();
  });

  test('archives legacy neo sessions as workers and removes neo type constraint', () => {
    db.exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				workspace_path TEXT,
				created_at TEXT NOT NULL,
				last_active_at TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived', 'pending_worktree_choice')),
				config TEXT NOT NULL,
				metadata TEXT NOT NULL,
				is_worktree INTEGER DEFAULT 0,
				worktree_path TEXT,
				main_repo_path TEXT,
				worktree_branch TEXT,
				git_branch TEXT,
				sdk_session_id TEXT,
				sdk_origin_path TEXT,
				available_commands TEXT,
				processing_state TEXT,
				archived_at TEXT,
				parent_id TEXT,
				type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'neo', 'space_chat')),
				session_context TEXT
			)
		`);
    db.prepare(
      `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata, type)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('neo-session', 'Neo', '2024-01-01', '2024-01-01', 'active', '{}', '{}', 'neo');

    runMigration131(db);

    const row = db
      .prepare(`SELECT status, type, archived_at FROM sessions WHERE id = ?`)
      .get('neo-session') as {
      status: string;
      type: string;
      archived_at: string | null;
    };
    expect(row.status).toBe('archived');
    expect(row.type).toBe('worker');
    expect(row.archived_at).toBeTruthy();
    expect(tableSql('sessions')).not.toContain("'neo'");
  });

  test('converts neo message origins to null and removes neo origin constraint', () => {
    db.exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				workspace_path TEXT,
				created_at TEXT NOT NULL,
				last_active_at TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived', 'pending_worktree_choice')),
				config TEXT NOT NULL,
				metadata TEXT NOT NULL,
				is_worktree INTEGER DEFAULT 0,
				worktree_path TEXT,
				main_repo_path TEXT,
				worktree_branch TEXT,
				git_branch TEXT,
				sdk_session_id TEXT,
				sdk_origin_path TEXT,
				available_commands TEXT,
				processing_state TEXT,
				archived_at TEXT,
				parent_id TEXT,
				type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'space_chat')),
				session_context TEXT
			);
			CREATE TABLE sdk_messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				message_subtype TEXT,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				send_status TEXT DEFAULT 'consumed' CHECK(send_status IN ('deferred', 'enqueued', 'consumed', 'failed')),
				origin TEXT DEFAULT NULL CHECK(origin IS NULL OR origin IN ('human', 'neo', 'system')),
				is_renderable INTEGER NOT NULL DEFAULT 1,
				is_terminal INTEGER NOT NULL DEFAULT 0,
				conversation_turn_index INTEGER,
				parent_tool_use_id TEXT,
				task_id TEXT,
				FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
			)
		`);
    db.prepare(
      `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata, type)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('session-1', 'Session', '2024-01-01', '2024-01-01', 'active', '{}', '{}', 'worker');
    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, origin, task_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('msg-neo', 'session-1', 'user', '{}', '2024-01-01', 'neo', 'task-1');

    runMigration131(db);

    const row = db
      .prepare(`SELECT origin, task_id FROM sdk_messages WHERE id = ?`)
      .get('msg-neo') as {
      origin: string | null;
      task_id: string | null;
    };
    expect(row.origin).toBeNull();
    expect(row.task_id).toBe('task-1');
    expect(tableSql('sdk_messages')).not.toContain("'neo'");
    expect(() => {
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, origin)
				 VALUES (?, ?, ?, ?, ?, ?)`
      ).run('msg-new-neo', 'session-1', 'user', '{}', '2024-01-02', 'neo');
    }).toThrow();
  });

  test('runMigration66 is a no-op when sessions CHECK already lacks neo (post-M131 / fresh tip)', () => {
    db.exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				workspace_path TEXT,
				created_at TEXT NOT NULL,
				last_active_at TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived', 'pending_worktree_choice')),
				config TEXT NOT NULL,
				metadata TEXT NOT NULL,
				is_worktree INTEGER DEFAULT 0,
				worktree_path TEXT,
				main_repo_path TEXT,
				worktree_branch TEXT,
				git_branch TEXT,
				sdk_session_id TEXT,
				sdk_origin_path TEXT,
				available_commands TEXT,
				processing_state TEXT,
				archived_at TEXT,
				parent_id TEXT,
				type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'space_chat', 'space_task_agent')),
				session_context TEXT
			)
		`);
    db.prepare(
      `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata, type)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('space-chat-1', 'Chat', '2024-01-01', '2024-01-01', 'active', '{}', '{}', 'space_chat');

    expect(() => runMigration66(db)).not.toThrow();

    const sql = tableSql('sessions');
    expect(sql).not.toContain("'neo'");
    expect(sql).toContain("'space_chat'");

    const neoLogExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'neo_activity_log'`)
      .get();
    expect(neoLogExists).toBeNull();

    const row = db.prepare(`SELECT type FROM sessions WHERE id = ?`).get('space-chat-1') as {
      type: string;
    };
    expect(row.type).toBe('space_chat');
  });
});
