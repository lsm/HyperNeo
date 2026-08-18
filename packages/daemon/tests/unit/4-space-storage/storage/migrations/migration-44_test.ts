import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations, createTables } from '../../../../../src/storage/schema/index.ts';

function getSdkMessagesTableSql(db: BunDatabase): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sdk_messages'`)
    .get() as { sql: string } | null;
  return row?.sql ?? '';
}

describe('Migration 44: rename sdk_messages send_status values', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-44', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const dbPath = join(testDir, 'test.db');
    db = new BunDatabase(dbPath);
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

  test('fresh DB uses deferred/enqueued/consumed constraint', () => {
    runMigrations(db, () => {});
    createTables(db);

    const sql = getSdkMessagesTableSql(db);
    expect(sql).toContain("'deferred'");
    expect(sql).toContain("'enqueued'");
    expect(sql).toContain("'consumed'");
    expect(sql).toContain("'failed'");
    expect(sql).not.toContain("'saved'");
    expect(sql).not.toContain("'sent'");
  });

  test('existing DB rows are renamed from saved/queued/sent', () => {
    db.exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				workspace_path TEXT NOT NULL,
				created_at TEXT NOT NULL,
				last_active_at TEXT NOT NULL,
				status TEXT NOT NULL,
				config TEXT NOT NULL,
				metadata TEXT NOT NULL
			);
			CREATE TABLE sdk_messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				message_subtype TEXT,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				send_status TEXT DEFAULT 'sent' CHECK(send_status IN ('saved', 'queued', 'sent', 'failed')),
				FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
			);
			CREATE INDEX idx_sdk_messages_session_id ON sdk_messages(session_id);
			CREATE INDEX idx_sdk_messages_send_status ON sdk_messages(session_id, send_status);
		`);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('session-1', 'S', '/tmp', now, now, 'active', '{}', '{}');

    const insert = db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status)
			 VALUES (?, ?, 'user', NULL, ?, ?, ?)`
    );
    insert.run('m-saved', 'session-1', '{"type":"user"}', now, 'saved');
    insert.run('m-queued', 'session-1', '{"type":"user"}', now, 'queued');
    insert.run('m-sent', 'session-1', '{"type":"user"}', now, 'sent');
    insert.run('m-failed', 'session-1', '{"type":"user"}', now, 'failed');
    insert.run('m-null', 'session-1', '{"type":"user"}', now, null);

    runMigrations(db, () => {});

    const rows = db
      .prepare(`SELECT id, send_status FROM sdk_messages ORDER BY id ASC`)
      .all() as Array<{ id: string; send_status: string }>;
    const byId = new Map(rows.map((r) => [r.id, r.send_status]));
    expect(byId.get('m-saved')).toBe('deferred');
    expect(byId.get('m-queued')).toBe('enqueued');
    expect(byId.get('m-sent')).toBe('consumed');
    expect(byId.get('m-failed')).toBe('failed');
    expect(byId.get('m-null')).toBe('consumed');

    const sql = getSdkMessagesTableSql(db);
    expect(sql).toContain("'deferred'");
    expect(sql).toContain("'enqueued'");
    expect(sql).toContain("'consumed'");
    expect(sql).toContain("'failed'");
  });
});
