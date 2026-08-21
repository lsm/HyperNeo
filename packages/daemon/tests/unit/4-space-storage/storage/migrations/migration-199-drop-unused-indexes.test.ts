import { Database as BunDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTables, runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration199 } from '../../../../../src/storage/schema/migrations.ts';

function indexExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(name);
}

function createPre199SdkMessages(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE sdk_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      message_subtype TEXT,
      sdk_message TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      consumed_seq INTEGER
    )
  `);
  db.exec(`CREATE INDEX idx_sdk_messages_type ON sdk_messages(message_type, message_subtype)`);
  db.exec(`CREATE INDEX idx_sdk_messages_consumed_seq ON sdk_messages(consumed_seq)`);
  db.exec(`CREATE INDEX idx_sdk_messages_session_timestamp_id
    ON sdk_messages(session_id, timestamp DESC, id DESC)`);
}

describe('Migration 199: drop planner-unused sdk_messages indexes', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('fresh DB (all migrations applied)', () => {
    beforeEach(() => {
      runMigrations(db, () => {});
      createTables(db);
    }, 30_000);

    test('does not create the dropped indexes', () => {
      expect(indexExists(db, 'idx_sdk_messages_type')).toBe(false);
      expect(indexExists(db, 'idx_sdk_messages_consumed_seq')).toBe(false);
      expect(indexExists(db, 'idx_sdk_messages_session_timestamp_id')).toBe(true);
      expect(indexExists(db, 'idx_sdk_messages_send_status_timestamp')).toBe(true);
      expect(indexExists(db, 'idx_sdk_messages_session_subtype_parent')).toBe(true);
    });
  });

  describe('pre-199 schema', () => {
    beforeEach(() => {
      createPre199SdkMessages(db);
    });

    test('drops both indexes and keeps the rest', () => {
      expect(indexExists(db, 'idx_sdk_messages_type')).toBe(true);
      expect(indexExists(db, 'idx_sdk_messages_consumed_seq')).toBe(true);
      runMigration199(db);
      expect(indexExists(db, 'idx_sdk_messages_type')).toBe(false);
      expect(indexExists(db, 'idx_sdk_messages_consumed_seq')).toBe(false);
      expect(indexExists(db, 'idx_sdk_messages_session_timestamp_id')).toBe(true);
    });

    test('session-scoped type queries still plan via the session-leading index', () => {
      runMigration199(db);
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT sdk_message FROM sdk_messages
         WHERE session_id = ? AND message_type = ? ORDER BY timestamp ASC LIMIT 100`
        )
        .all('session-1', 'user') as Array<{ detail: string }>;
      const joined = plan.map((r) => r.detail).join(' | ');
      expect(joined).toContain('idx_sdk_messages_session_timestamp_id');
      expect(joined).not.toContain('SCAN sdk_messages');
    });

    test('is idempotent — running twice does not throw', () => {
      runMigration199(db);
      expect(() => runMigration199(db)).not.toThrow();
    });
  });

  describe('no-op guards', () => {
    test('does not throw when sdk_messages does not exist', () => {
      expect(() => runMigration199(db)).not.toThrow();
    });
  });
});
