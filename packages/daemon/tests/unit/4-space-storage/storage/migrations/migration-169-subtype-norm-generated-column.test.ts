import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration169 } from '../../../../../src/storage/schema/migrations';

function createPre169SdkMessages(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE sdk_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      message_subtype TEXT,
      sdk_message TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      parent_tool_use_id TEXT
    )
  `);
}

function indexExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(name);
}

describe('Migration 169: message_subtype_norm generated column + index', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  test('adds a VIRTUAL generated column equal to COALESCE(message_subtype, "")', () => {
    createPre169SdkMessages(db);
    const insert = db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    insert.run('null-subtype', 's1', 'system', null, '{}', '2024-01-01');
    insert.run('task-progress', 's1', 'system', 'task_progress', '{}', '2024-01-01');
    insert.run('informational', 's1', 'system', 'informational', '{}', '2024-01-01');

    runMigration169(db);

    expect(
      db.prepare(`SELECT id, message_subtype_norm FROM sdk_messages ORDER BY id`).all()
    ).toEqual([
      { id: 'informational', message_subtype_norm: 'informational' },
      { id: 'null-subtype', message_subtype_norm: '' },
      { id: 'task-progress', message_subtype_norm: 'task_progress' },
    ]);
  });

  test('message_subtype_norm is always equal to COALESCE(message_subtype, "") (invariant)', () => {
    createPre169SdkMessages(db);
    const insert = db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    insert.run('a', 's1', 'system', null, '{}', '2024-01-01');
    insert.run('b', 's1', 'system', 'task_started', '{}', '2024-01-01');
    insert.run('c', 's1', 'system', '', '{}', '2024-01-01');

    runMigration169(db);

    const drift = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sdk_messages
          WHERE message_subtype_norm != COALESCE(message_subtype, '')`
      )
      .get() as { n: number };
    expect(drift.n).toBe(0);
  });

  test('newly inserted rows derive message_subtype_norm automatically', () => {
    createPre169SdkMessages(db);
    runMigration169(db);

    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('post-migration-null', 's1', 'system', null, '{}', '2024-01-01');

    expect(
      db
        .prepare(`SELECT message_subtype_norm FROM sdk_messages WHERE id = 'post-migration-null'`)
        .get()
    ).toEqual({ message_subtype_norm: '' });
  });

  test('creates the (session_id, message_subtype_norm, parent_tool_use_id) index', () => {
    createPre169SdkMessages(db);
    runMigration169(db);
    expect(indexExists(db, 'idx_sdk_messages_session_subtype_parent')).toBe(true);
  });

  test('sidecar subtype IN filter seeks the new index (sargable)', () => {
    createPre169SdkMessages(db);
    runMigration169(db);

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
          SELECT id FROM sdk_messages
          WHERE session_id = 's1'
            AND parent_tool_use_id IS NULL
            AND message_subtype_norm IN ('task_started', 'task_updated', 'task_notification')`
      )
      .all() as Array<{ detail: string }>;
    const text = plan.map((row) => row.detail).join('\n');
    expect(text).toContain('idx_sdk_messages_session_subtype_parent');
    expect(text).toContain('message_subtype_norm');
    expect(text).not.toContain('SCAN sdk_messages');
  });

  test('is idempotent', () => {
    createPre169SdkMessages(db);
    runMigration169(db);
    expect(() => runMigration169(db)).not.toThrow();
  });

  test('is a no-op without sdk_messages', () => {
    expect(() => runMigration169(db)).not.toThrow();
  });
});
