import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runMigration304 } from '../../../../src/storage/schema/m304-task-message-rows';
import { ensureTaskMessageRows } from '../../../../src/storage/schema/task-message-rows';
import { Database } from '../../../../src/storage/sqlite-compat';

const SDK_MESSAGES = `CREATE TABLE sdk_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  message_subtype TEXT,
  sdk_message TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  send_status TEXT DEFAULT 'consumed',
  is_renderable INTEGER NOT NULL DEFAULT 1,
  is_terminal INTEGER NOT NULL DEFAULT 0,
  conversation_turn_index INTEGER,
  parent_tool_use_id TEXT,
  task_id TEXT,
  sdk_uuid TEXT
)`;

const TEXT = 1;
const THINKING = 2;
const TOOL_USE = 4;
const MUTATING_TOOL = 8;
const VALID_JSON = 16;
const INFO_LEVEL = 32;
const UNRESOLVED_ACTION = 64;

function assistant(...content: unknown[]) {
  return { type: 'assistant', message: { content } };
}

describe('task message rows', () => {
  let db: Database;

  const insert = (
    id: string,
    type: string,
    message: unknown,
    extra: { taskId?: string | null; subtype?: string } = {}
  ) =>
    db
      .prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, task_id, conversation_turn_index, sdk_uuid)
         VALUES (?, 'session-1', ?, ?, ?, '2026-10-06T10:00:00.000Z', ?, 3, ?)`
      )
      .run(
        id,
        type,
        extra.subtype ?? null,
        typeof message === 'string' ? message : JSON.stringify(message),
        extra.taskId === undefined ? 'task-1' : extra.taskId,
        `uuid-${id}`
      );
  const flagsOf = (id: string) =>
    (
      db.prepare('SELECT flags FROM task_message_rows WHERE id = ?').get(id) as {
        flags: number;
      } | null
    )?.flags;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SDK_MESSAGES);
    runMigration304(db);
    runMigration304(db);
  });
  afterEach(() => db.close());

  test('records each task message with the flags the feeds read from its JSON', () => {
    insert('text', 'assistant', assistant({ type: 'text', text: 'done' }));
    insert('blank', 'assistant', assistant({ type: 'text', text: '  ' }));
    insert('thinking', 'assistant', assistant({ type: 'thinking', thinking: 'hmm' }));
    insert(
      'edit',
      'assistant',
      assistant({ type: 'tool_use', id: 't1', name: 'Edit', input: {} }, 'stray')
    );
    insert('read', 'assistant', assistant({ type: 'tool_use', id: 't2', name: 'Read', input: {} }));
    insert(
      'info',
      'system',
      { type: 'system', subtype: 'informational', level: 'info' },
      {
        subtype: 'informational',
      }
    );
    insert('action', 'hyperneo_action', { type: 'hyperneo_action', resolved: false });
    insert('broken', 'assistant', '{not json');

    expect(flagsOf('text')).toBe(VALID_JSON | TEXT);
    expect(flagsOf('blank')).toBe(VALID_JSON);
    expect(flagsOf('thinking')).toBe(VALID_JSON | THINKING);
    expect(flagsOf('edit')).toBe(VALID_JSON | TOOL_USE | MUTATING_TOOL);
    expect(flagsOf('read')).toBe(VALID_JSON | TOOL_USE);
    expect(flagsOf('info')).toBe(VALID_JSON | INFO_LEVEL);
    expect(flagsOf('action')).toBe(VALID_JSON | UNRESOLVED_ACTION);
    expect(flagsOf('broken')).toBe(0);
    expect(
      db
        .prepare(
          `SELECT task_id, session_id, message_type, json_subtype, turn_index, sdk_uuid, created_at
           FROM task_message_rows WHERE id = 'info'`
        )
        .get()
    ).toEqual({
      task_id: 'task-1',
      session_id: 'session-1',
      message_type: 'system',
      json_subtype: 'informational',
      turn_index: 3,
      sdk_uuid: 'uuid-info',
      created_at: Date.parse('2026-10-06T10:00:00.000Z'),
    });
  });

  test('skips messages outside a task', () => {
    insert('chat', 'assistant', assistant({ type: 'text', text: 'hi' }), { taskId: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_message_rows').get()).toEqual({ n: 0 });
  });

  test('follows content rewrites, status flips and deletes', () => {
    insert('action', 'hyperneo_action', { type: 'hyperneo_action', resolved: false });
    db.prepare('UPDATE sdk_messages SET sdk_message = ? WHERE id = ?').run(
      JSON.stringify({ type: 'hyperneo_action', resolved: true }),
      'action'
    );
    expect(flagsOf('action')).toBe(VALID_JSON);

    db.prepare(
      "UPDATE sdk_messages SET send_status = 'failed', conversation_turn_index = 7 WHERE id = ?"
    ).run('action');
    expect(
      db.prepare("SELECT send_status, turn_index FROM task_message_rows WHERE id = 'action'").get()
    ).toEqual({ send_status: 'failed', turn_index: 7 });

    db.prepare('UPDATE sdk_messages SET task_id = NULL WHERE id = ?').run('action');
    expect(flagsOf('action')).toBeUndefined();

    insert('gone', 'assistant', assistant({ type: 'text', text: 'bye' }));
    db.prepare('DELETE FROM sdk_messages WHERE id = ?').run('gone');
    expect(flagsOf('gone')).toBeUndefined();
  });

  test('drops rows when a session delete cascades to its messages', () => {
    const cascading = new Database(':memory:');
    cascading.exec('PRAGMA foreign_keys = ON');
    cascading.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
    cascading.exec(
      SDK_MESSAGES.replace(
        'sdk_uuid TEXT\n)',
        'sdk_uuid TEXT,\n  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE\n)'
      )
    );
    runMigration304(cascading);
    cascading.exec("INSERT INTO sessions VALUES ('session-1')");
    cascading
      .prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, task_id)
         VALUES ('m1', 'session-1', 'assistant', '{}', '2026-10-06T10:00:00.000Z', 'task-1')`
      )
      .run();
    cascading.exec("DELETE FROM sessions WHERE id = 'session-1'");
    expect(cascading.prepare('SELECT COUNT(*) AS n FROM task_message_rows').get()).toEqual({
      n: 0,
    });
    cascading.close();
  });
});

describe('runMigration304', () => {
  test('skips databases without sdk_messages', () => {
    const empty = new Database(':memory:');
    runMigration304(empty);
    expect(
      empty
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'task_message_rows'")
        .get()
    ).toEqual({ n: 0 });
    empty.close();
  });
});

describe('ensureTaskMessageRows', () => {
  test('projects a task whose messages predate the triggers, once', () => {
    const db = new Database(':memory:');
    db.exec(SDK_MESSAGES);
    const insert = db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, task_id)
       VALUES (?, 'session-1', 'assistant', ?, '2026-10-06T10:00:00.000Z', ?)`
    );
    insert.run('old', JSON.stringify(assistant({ type: 'text', text: 'hi' })), 'task-1');
    insert.run('other', JSON.stringify(assistant({ type: 'text', text: 'hi' })), 'task-2');
    runMigration304(db);
    insert.run('new', JSON.stringify(assistant({ type: 'thinking', thinking: 'hm' })), 'task-1');

    ensureTaskMessageRows(db, 'task-1');
    ensureTaskMessageRows(db, 'task-1');

    expect(db.prepare('SELECT id, flags FROM task_message_rows ORDER BY id').all()).toEqual([
      { id: 'new', flags: VALID_JSON | THINKING },
      { id: 'old', flags: VALID_JSON | TEXT },
    ]);
    db.close();
  });
});
