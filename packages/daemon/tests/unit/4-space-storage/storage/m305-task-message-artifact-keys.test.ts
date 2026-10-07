import { describe, expect, test } from 'bun:test';
import { runMigration304 } from '../../../../src/storage/schema/m304-task-message-rows';
import { runMigration305 } from '../../../../src/storage/schema/m305-task-message-artifact-keys';
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

const toolUse = (id: string, name: string, input: unknown) => ({
  type: 'tool_use',
  id,
  name,
  input,
});

describe('runMigration305', () => {
  test('keys file and todo pins for rows projected before and after it', () => {
    const db = new Database(':memory:');
    db.exec(SDK_MESSAGES);
    runMigration304(db);
    const insert = db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, task_id)
       VALUES (?, 's1', 'assistant', ?, '2026-10-06T10:00:00.000Z', 'task-1')`
    );
    const assistant = (...content: unknown[]) =>
      JSON.stringify({ type: 'assistant', message: { content } });
    insert.run(
      'before',
      assistant(
        toolUse('t1', 'Write', { file_path: 'a.ts', content: 'x' }),
        toolUse('t2', 'Edit', { file_path: 'b.ts', old_string: 'x' }),
        toolUse('t3', 'TodoWrite', { todos: [{ content: 'do', status: 'pending' }] })
      )
    );

    runMigration305(db);
    runMigration305(db);
    insert.run('after', assistant(toolUse('t4', 'Read', { file_path: 'c.ts' })));

    expect(db.prepare('SELECT id, artifact_keys FROM task_message_rows ORDER BY id').all()).toEqual(
      [
        { id: 'after', artifact_keys: null },
        { id: 'before', artifact_keys: '["file:a.ts","todo"]' },
      ]
    );
    db.close();
  });

  test('skips databases without task_message_rows', () => {
    const db = new Database(':memory:');
    runMigration305(db);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'").get()
    ).toEqual({ n: 0 });
    db.close();
  });
});
