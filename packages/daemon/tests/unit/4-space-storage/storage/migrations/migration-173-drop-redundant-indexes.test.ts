import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration173 } from '../../../../../src/storage/schema/migrations';

function createPre173SdkMessages(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE sdk_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      message_subtype TEXT,
      sdk_message TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      send_status TEXT,
      sdk_uuid TEXT
    )
  `);
  db.exec(`CREATE INDEX idx_sdk_messages_session ON sdk_messages(session_id, timestamp)`);
  db.exec(
    `CREATE INDEX idx_sdk_messages_session_timestamp_id ON sdk_messages(session_id, timestamp DESC, id DESC)`
  );
  db.exec(
    `CREATE INDEX idx_sdk_messages_uuid_status ON sdk_messages(session_id, send_status, json_extract(sdk_message, '$.uuid'))`
  );
  db.exec(`CREATE INDEX idx_sdk_messages_session_uuid ON sdk_messages(session_id, sdk_uuid)`);
}

function indexExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(name);
}

describe('Migration 173: drop redundant sdk_messages indexes', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  test('drops idx_sdk_messages_session (strict prefix of session_timestamp_id)', () => {
    createPre173SdkMessages(db);
    expect(indexExists(db, 'idx_sdk_messages_session')).toBe(true);
    runMigration173(db);
    expect(indexExists(db, 'idx_sdk_messages_session')).toBe(false);
  });

  test('drops idx_sdk_messages_uuid_status (superseded by session_uuid)', () => {
    createPre173SdkMessages(db);
    expect(indexExists(db, 'idx_sdk_messages_uuid_status')).toBe(true);
    runMigration173(db);
    expect(indexExists(db, 'idx_sdk_messages_uuid_status')).toBe(false);
  });

  test('leaves idx_sdk_messages_session_uuid and session_timestamp_id intact', () => {
    createPre173SdkMessages(db);
    runMigration173(db);
    expect(indexExists(db, 'idx_sdk_messages_session_uuid')).toBe(true);
    expect(indexExists(db, 'idx_sdk_messages_session_timestamp_id')).toBe(true);
  });

  test('uuid lookups seek idx_sdk_messages_session_uuid after the drop (sargable)', () => {
    createPre173SdkMessages(db);
    runMigration173(db);
    const insert = db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < 50; i++) {
      insert.run(
        `r${i}`,
        's1',
        i % 5 === 0 ? 'user' : 'assistant',
        '{"uuid":"u' + i + '"}',
        '2024-01-01',
        'consumed',
        `u${i}`
      );
    }

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
          SELECT id FROM sdk_messages
          WHERE session_id = 's1' AND send_status = 'consumed' AND sdk_uuid = 'u5'`
      )
      .all() as Array<{ detail: string }>;
    const text = plan.map((row) => row.detail).join('\n');
    expect(text).toContain('idx_sdk_messages_session_uuid');
    expect(text).not.toContain('SCAN sdk_messages');
  });

  test('is idempotent', () => {
    createPre173SdkMessages(db);
    runMigration173(db);
    expect(() => runMigration173(db)).not.toThrow();
  });

  test('is a no-op without sdk_messages', () => {
    expect(() => runMigration173(db)).not.toThrow();
  });
});
