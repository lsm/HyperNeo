import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigration183 } from '../../../../../src/storage/schema/migrations';

describe('Migration 183: ACP delivery statuses', () => {
  let db: BunDatabase;
  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('s');
      CREATE TABLE sdk_messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sdk_message TEXT NOT NULL,
        send_status TEXT DEFAULT 'consumed' CHECK(send_status IN ('deferred', 'enqueued', 'consumed', 'failed')),
        sdk_uuid TEXT, generated_uuid TEXT GENERATED ALWAYS AS (COALESCE(sdk_uuid, '')) VIRTUAL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX sdk_messages_uuid_test ON sdk_messages(session_id, generated_uuid);
      CREATE TABLE audit (message_id TEXT);
      CREATE TRIGGER sdk_messages_audit AFTER INSERT ON sdk_messages BEGIN INSERT INTO audit VALUES (NEW.id); END;
      INSERT INTO sdk_messages (id, session_id, sdk_message, send_status, sdk_uuid) VALUES ('m', 's', '{}', 'enqueued', 'u');`);
  });
  afterEach(() => db.close());

  test('preserves data, generated columns, indexes, triggers, and foreign keys', () => {
    runMigration183(db);
    db.exec(`UPDATE sdk_messages SET send_status = 'submitted' WHERE id = 'm'`);
    expect(() =>
      db.exec(`UPDATE sdk_messages SET send_status = 'accepted' WHERE id = 'm'`)
    ).toThrow();
    db.exec(
      `INSERT INTO sdk_messages (id, session_id, sdk_message, send_status, sdk_uuid) VALUES ('m2', 's', '{}', 'submitted', 'u2')`
    );
    expect(db.prepare(`SELECT generated_uuid FROM sdk_messages WHERE id = 'm'`).get()).toEqual({
      generated_uuid: 'u',
    });
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name='sdk_messages_uuid_test'`
        )
        .get()
    ).toBeTruthy();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM audit`).get()).toEqual({ n: 2 });
    expect(db.prepare(`PRAGMA foreign_key_list('sdk_messages')`).all()).toHaveLength(1);
    expect(() => runMigration183(db)).not.toThrow();
  });
});
