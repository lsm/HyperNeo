import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration178 } from '../../../../../src/storage/schema/migrations';

function createPre178SdkMessages(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE sdk_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      message_subtype TEXT,
      sdk_message TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      send_status TEXT DEFAULT 'consumed',
      is_renderable INTEGER NOT NULL DEFAULT 1,
      is_terminal INTEGER NOT NULL DEFAULT 0,
      task_id TEXT,
      parent_tool_use_id TEXT
    )
  `);
}

function indexExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(name);
}

function insert(
  db: BunDatabase,
  id: string,
  task: string | null,
  type: string,
  renderable: number,
  ts: string,
  sendStatus?: string,
  session = 's1'
): void {
  db.prepare(
    `INSERT INTO sdk_messages (id, session_id, message_type, is_renderable, task_id, timestamp, send_status, sdk_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}')`
  ).run(id, session, type, renderable, task, ts, sendStatus ?? null);
}

describe('Migration 178: conversation_turn_index backfill + index', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  test('backfills a global per-task turn index that increments at each anchor', () => {
    createPre178SdkMessages(db);
    insert(db, 'sys-init', 't1', 'system', 1, '2024-01-01T00:00:00Z');
    insert(db, 'u1', 't1', 'user', 1, '2024-01-01T00:00:01Z');
    insert(db, 'a1', 't1', 'assistant', 1, '2024-01-01T00:00:02Z');
    insert(db, 'tr1', 't1', 'user', 0, '2024-01-01T00:00:03Z');
    insert(db, 'u2', 't1', 'user', 1, '2024-01-01T00:00:04Z');
    insert(db, 'a2', 't1', 'assistant', 1, '2024-01-01T00:00:05Z');
    insert(db, 'r1', 't1', 'result', 1, '2024-01-01T00:00:06Z');
    insert(db, 'u-other', 't2', 'user', 1, '2024-01-01T00:00:07Z');
    insert(db, 'no-task', null, 'user', 1, '2024-01-01T00:00:08Z');

    runMigration178(db);

    const rows = db
      .prepare(`SELECT id, task_id, conversation_turn_index AS t FROM sdk_messages ORDER BY id`)
      .all() as Array<{ id: string; task_id: string | null; t: number | null }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('sys-init')?.t).toBe(0);
    expect(byId.get('u1')?.t).toBe(1);
    expect(byId.get('a1')?.t).toBe(1);
    expect(byId.get('tr1')?.t).toBe(1);
    expect(byId.get('u2')?.t).toBe(2);
    expect(byId.get('a2')?.t).toBe(2);
    expect(byId.get('r1')?.t).toBe(2);
    expect(byId.get('u-other')?.t).toBe(1);
    expect(byId.get('no-task')?.t).toBe(null);
  });

  test('orders by (timestamp, rowid), not insertion order', () => {
    createPre178SdkMessages(db);
    insert(db, 'late-u', 't1', 'user', 1, '2024-01-01T00:00:05Z');
    insert(db, 'early-u', 't1', 'user', 1, '2024-01-01T00:00:01Z');
    insert(db, 'mid', 't1', 'assistant', 1, '2024-01-01T00:00:03Z');

    runMigration178(db);

    const rows = db
      .prepare(`SELECT id, conversation_turn_index AS t FROM sdk_messages ORDER BY id`)
      .all() as Array<{ id: string; t: number }>;
    const byId = new Map(rows.map((r) => [r.id, r.t]));
    expect(byId.get('early-u')).toBe(1);
    expect(byId.get('mid')).toBe(1);
    expect(byId.get('late-u')).toBe(2);
  });

  test("non-anchor rows inherit their own session's turn, not the task-wide max (#2338)", () => {
    createPre178SdkMessages(db);
    insert(db, 'u-a', 't1', 'user', 1, '2024-01-01T00:00:01Z', 'consumed', 'sA');
    insert(db, 'u-b', 't1', 'user', 1, '2024-01-01T00:00:02Z', 'consumed', 'sB');
    insert(db, 'a-a', 't1', 'assistant', 1, '2024-01-01T00:00:03Z', undefined, 'sA');
    insert(db, 'a-b', 't1', 'assistant', 1, '2024-01-01T00:00:04Z', undefined, 'sB');

    runMigration178(db);

    const rows = db
      .prepare(`SELECT id, conversation_turn_index AS t FROM sdk_messages ORDER BY id`)
      .all() as Array<{ id: string; t: number }>;
    const byId = new Map(rows.map((r) => [r.id, r.t]));
    expect(byId.get('u-a')).toBe(1);
    expect(byId.get('u-b')).toBe(2);
    expect(byId.get('a-a')).toBe(1);
    expect(byId.get('a-b')).toBe(2);
  });

  test('an enqueued user row is NOT an anchor until consumed (#2338)', () => {
    createPre178SdkMessages(db);
    insert(db, 'u1', 't1', 'user', 1, '2024-01-01T00:00:01Z');
    insert(db, 'a1', 't1', 'assistant', 1, '2024-01-01T00:00:02Z');
    insert(db, 'u-enq', 't1', 'user', 1, '2024-01-01T00:00:03Z', 'enqueued');
    insert(db, 'r1', 't1', 'result', 1, '2024-01-01T00:00:04Z');

    runMigration178(db);

    const rows = db
      .prepare(`SELECT id, conversation_turn_index AS t FROM sdk_messages ORDER BY id`)
      .all() as Array<{ id: string; t: number }>;
    const byId = new Map(rows.map((r) => [r.id, r.t]));
    expect(byId.get('u1')).toBe(1);
    expect(byId.get('a1')).toBe(1);
    expect(byId.get('u-enq')).toBe(1);
    expect(byId.get('r1')).toBe(1);
  });

  test('creates the (task_id, conversation_turn_index) index', () => {
    createPre178SdkMessages(db);
    runMigration178(db);
    expect(indexExists(db, 'idx_sdk_messages_task_turn')).toBe(true);
  });

  test('recent-turn seek uses the index (sargable)', () => {
    createPre178SdkMessages(db);
    runMigration178(db);
    insert(db, 'a', 't1', 'user', 1, '2024-01-02T00:00:00Z');

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
          SELECT id FROM sdk_messages
          WHERE task_id = 't1'
            AND conversation_turn_index >= (SELECT MAX(conversation_turn_index) FROM sdk_messages WHERE task_id = 't1') - 9`
      )
      .all() as Array<{ detail: string }>;
    const text = plan.map((row) => row.detail).join('\n');
    expect(text).toContain('idx_sdk_messages_task_turn');
  });

  test('per-session turn-inheritance seek uses the session-scoped index (sargable, #2338)', () => {
    createPre178SdkMessages(db);
    runMigration178(db);
    insert(db, 'a', 't1', 'user', 1, '2024-01-02T00:00:00Z');

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
          SELECT MAX(conversation_turn_index) AS m FROM sdk_messages
          WHERE task_id = 't1' AND session_id = 's1'`
      )
      .all() as Array<{ detail: string }>;
    const text = plan.map((row) => row.detail).join('\n');
    expect(text).toContain('idx_sdk_messages_task_session_turn');
  });

  test('is idempotent', () => {
    createPre178SdkMessages(db);
    insert(db, 'u1', 't1', 'user', 1, '2024-01-01T00:00:01Z');
    runMigration178(db);
    expect(() => runMigration178(db)).not.toThrow();
    expect(
      (
        db.prepare(`SELECT conversation_turn_index AS t FROM sdk_messages WHERE id='u1'`).get() as {
          t: number;
        }
      ).t
    ).toBe(1);
  });

  test('is a no-op without sdk_messages', () => {
    expect(() => runMigration178(db)).not.toThrow();
  });
});
