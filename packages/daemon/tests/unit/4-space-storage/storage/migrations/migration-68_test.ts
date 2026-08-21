import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { createTables } from '../../../../../src/storage/schema/index.ts';
import { runMigration68 } from '../../../../../src/storage/schema/migrations.ts';

function columnExists(db: BunDatabase, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function createLegacySdkMessagesTable(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS sdk_messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			message_type TEXT NOT NULL,
			message_subtype TEXT,
			sdk_message TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			send_status TEXT DEFAULT 'consumed' CHECK(send_status IN ('deferred', 'enqueued', 'consumed', 'failed'))
		)
	`);
}

describe('Migration 68: Add origin column to sdk_messages', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-68', `test-${Date.now()}`);
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

  test('origin column is added to existing sdk_messages table', () => {
    createLegacySdkMessagesTable(db);
    expect(columnExists(db, 'sdk_messages', 'origin')).toBe(false);

    runMigration68(db);

    expect(columnExists(db, 'sdk_messages', 'origin')).toBe(true);
  });

  test('origin column defaults to NULL for new rows after migration', () => {
    createLegacySdkMessagesTable(db);
    runMigration68(db);

    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
			 VALUES (?, ?, ?, ?, ?)`
    ).run('msg-1', 'session-1', 'user', '{}', new Date().toISOString());

    const row = db.prepare(`SELECT origin FROM sdk_messages WHERE id = 'msg-1'`).get() as {
      origin: string | null;
    };
    expect(row.origin).toBeNull();
  });

  test('origin=system can be stored after migration', () => {
    createLegacySdkMessagesTable(db);
    runMigration68(db);

    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, origin)
			 VALUES (?, ?, ?, ?, ?, ?)`
    ).run('msg-sys', 'session-1', 'user', '{}', new Date().toISOString(), 'system');

    const row = db.prepare(`SELECT origin FROM sdk_messages WHERE id = 'msg-sys'`).get() as {
      origin: string;
    };
    expect(row.origin).toBe('system');
  });

  test('origin=human can be stored after migration', () => {
    createLegacySdkMessagesTable(db);
    runMigration68(db);

    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, origin)
			 VALUES (?, ?, ?, ?, ?, ?)`
    ).run('msg-human', 'session-1', 'user', '{}', new Date().toISOString(), 'human');

    const row = db.prepare(`SELECT origin FROM sdk_messages WHERE id = 'msg-human'`).get() as {
      origin: string;
    };
    expect(row.origin).toBe('human');
  });

  test('invalid origin value is rejected by CHECK constraint', () => {
    createLegacySdkMessagesTable(db);
    runMigration68(db);

    expect(() => {
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, origin)
				 VALUES (?, ?, ?, ?, ?, ?)`
      ).run('msg-bad', 'session-1', 'user', '{}', new Date().toISOString(), 'robot');
    }).toThrow();
  });

  test('runMigration68 is idempotent — running twice does not error', () => {
    createLegacySdkMessagesTable(db);
    runMigration68(db);
    expect(() => runMigration68(db)).not.toThrow();
    expect(columnExists(db, 'sdk_messages', 'origin')).toBe(true);
  });

  test('existing rows without origin are NULL after migration', () => {
    createLegacySdkMessagesTable(db);

    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp)
			 VALUES (?, ?, ?, ?, ?)`
    ).run('old-msg', 'session-1', 'assistant', '{}', new Date().toISOString());

    runMigration68(db);

    const row = db.prepare(`SELECT origin FROM sdk_messages WHERE id = 'old-msg'`).get() as {
      origin: string | null;
    };
    expect(row.origin).toBeNull();
  });

  test('fresh DB via createTables has origin column on sdk_messages', () => {
    createTables(db);
    expect(columnExists(db, 'sdk_messages', 'origin')).toBe(true);
  });

  test('runMigration68 is no-op when sdk_messages does not exist', () => {
    expect(() => runMigration68(db)).not.toThrow();
  });
});
