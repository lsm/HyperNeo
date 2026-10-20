import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeSdkMessageBody } from '../../../../src/storage/repositories/sdk-message-body-write';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { runMigration419 } from '../../../../src/storage/schema/m419-task-message-body-triggers';
import { createTaskMessageRows } from '../../../../src/storage/schema/task-message-rows';
import { ensureTaskMessageRows } from '../../../../src/storage/schema/task-message-rows';
import { TASK_MESSAGE_FLAG as F } from '../../../../src/storage/schema/task-message-rows';
import {
  deriveSdkMessageColumns,
  SDK_MESSAGE_COLUMN_TYPES,
} from '../../../../src/storage/sdk-message-columns';
import { Database } from '../../../../src/storage/sqlite-compat';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.exec('PRAGMA foreign_keys=OFF');
});
afterEach(() => db.close());

const assistant = (path: string) => ({
  type: 'assistant',
  subtype: 'body-subtype',
  message: {
    content: [
      { type: 'text', text: 'complete' },
      {
        type: 'tool_use',
        id: 'edit',
        name: 'Write',
        input: { file_path: path, content: 'full content' },
      },
    ],
  },
});

function put(id: string, body: Record<string, unknown>, taskId: string | null = 'task') {
  const derived = deriveSdkMessageColumns(body, taskId);
  const names = Object.keys(SDK_MESSAGE_COLUMN_TYPES) as (keyof typeof SDK_MESSAGE_COLUMN_TYPES)[];
  writeSdkMessageBody(
    db,
    () =>
      db
        .prepare(`INSERT INTO sdk_messages
    (id,session_id,task_id,message_type,sdk_message,timestamp,sdk_uuid,replacement_metadata_normalized,${names.join(',')})
    VALUES (?,'s',?,?,?,'2026-10-20T00:00:00Z',?,1,${names.map(() => '?').join(',')})`)
        .run(id, taskId, body.type, JSON.stringify(body), id, ...names.map((key) => derived[key])),
    'id=?',
    [id]
  );
}

function projection(id: string) {
  return db.prepare('SELECT * FROM task_message_rows WHERE id=?').get(id) as Record<
    string,
    unknown
  >;
}

describe('task message body projection', () => {
  test.each(['side', 'legacy'])(
    'repairs a missing projection on status update using the %s body',
    (source) => {
      const body = assistant('kept.ts');
      if (source === 'side') {
        put('old', body);
        db.exec("UPDATE sdk_messages SET sdk_message='' WHERE id='old'");
      } else {
        db.prepare(`INSERT INTO sdk_messages(id,session_id,task_id,message_type,sdk_message,timestamp,replacement_metadata_normalized)
        VALUES ('old','s','task','assistant',?,'2026-10-20T00:00:00Z',1)`).run(
          JSON.stringify(body)
        );
      }
      db.exec("DELETE FROM task_message_rows WHERE id='old'");
      db.exec("UPDATE sdk_messages SET send_status='failed' WHERE id='old'");
      ensureTaskMessageRows(db, 'task');
      expect(projection('old')).toMatchObject({
        send_status: 'failed',
        flags: F.validJson | F.text | F.toolUse | F.mutatingTool,
        artifact_keys: '["file:kept.ts"]',
        json_subtype: 'body-subtype',
      });
    }
  );

  test('matches legacy flags and artifact keys for malformed, mistyped and mutating-tool bodies', () => {
    for (const name of [
      'task_message_rows_ai',
      'task_message_rows_au',
      'task_message_bodies_ai',
      'task_message_bodies_au',
      'task_message_rows_unassigned',
      'task_message_rows_reassigned',
    ])
      db.exec(`DROP TRIGGER ${name}`);
    createTaskMessageRows(db);
    const cases = [
      assistant('a.ts'),
      {
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'hmm' }, 'stray', 0, null, false] },
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '   ' },
            { type: 'tool_use', id: 'read', name: 'Read', input: {} },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'edit',
              name: 'Edit',
              input: { file_path: 'b.ts', old_string: 'a', new_string: 'b' },
            },
            { type: 'tool_use', id: 'bad', name: 'Write', input: {} },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'multi',
              name: 'MultiEdit',
              input: { file_path: 'c.ts', edits: [{ old_string: 'a', new_string: 'b' }] },
            },
            {
              type: 'tool_use',
              id: 'todo',
              name: 'TodoWrite',
              input: { todos: [{ content: 'do', status: 'pending' }] },
            },
          ],
        },
      },
      ...[undefined, null, false, 0, true, 1, '0'].map((resolved) => ({
        type: 'hyperneo_action',
        resolved,
      })),
      ...[undefined, null, false, 0, 'info', 'warn'].map((level) => ({
        type: 'system',
        subtype: 'informational',
        level,
      })),
    ];
    for (const [i, body] of cases.entries()) put(`case-${i}`, body);
    for (const [i, raw] of ['{broken', 'null', 'false', '0', '[]', '"text"'].entries())
      writeSdkMessageBody(
        db,
        () =>
          db
            .prepare(`INSERT INTO sdk_messages(id,session_id,task_id,message_type,sdk_message,timestamp,replacement_metadata_normalized)
        VALUES (?,'s','task','assistant',?,'2026-10-20T00:00:00Z',1)`)
            .run(`raw-${i}`, raw),
        'id=?',
        [`raw-${i}`]
      );
    const before = db.prepare('SELECT * FROM task_message_rows ORDER BY id').all();
    runMigration419(db);
    runMigration419(db);
    db.exec('UPDATE sdk_message_bodies SET sdk_message=sdk_message');
    db.exec('UPDATE sdk_messages SET send_status=send_status');
    expect(db.prepare('SELECT * FROM task_message_rows ORDER BY id').all()).toEqual(before);
  });

  test('body upserts refresh flags, artifact keys and JSON subtype without replacing row metadata', () => {
    put('m', assistant('a.ts'));
    const before = projection('m');
    db.prepare(
      "UPDATE sdk_message_bodies SET sdk_message=? WHERE seq=(SELECT seq FROM sdk_messages WHERE id='m')"
    ).run(
      JSON.stringify({
        type: 'assistant',
        subtype: 'changed',
        message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
      })
    );
    expect(projection('m')).toEqual({
      ...before,
      flags: F.validJson | F.thinking,
      artifact_keys: null,
      json_subtype: 'changed',
    });
  });

  test('blanking the legacy column and changing status retain the full body projection', () => {
    put('m', assistant('a.ts'));
    const before = projection('m');
    db.exec("UPDATE sdk_messages SET sdk_message='' WHERE id='m'");
    expect(projection('m')).toEqual(before);
    db.exec(
      "UPDATE sdk_messages SET send_status='failed',conversation_turn_index=7,timestamp='2026-10-20T01:00:00Z' WHERE id='m'"
    );
    expect(projection('m')).toEqual({
      ...before,
      send_status: 'failed',
      turn_index: 7,
      created_at: Date.parse('2026-10-20T01:00:00Z'),
    });
    expect(
      JSON.parse(
        (db.prepare('SELECT sdk_message FROM sdk_message_bodies').get() as { sdk_message: string })
          .sdk_message
      )
    ).toEqual(assistant('a.ts'));
  });

  test('row and body trigger ownership remains disjoint across combined writes', () => {
    put('m', assistant('a.ts'));
    writeSdkMessageBody(
      db,
      () =>
        db
          .prepare(
            "UPDATE sdk_messages SET sdk_message=?,send_status='failed',conversation_turn_index=9 WHERE id='m'"
          )
          .run(JSON.stringify(assistant('b.ts'))),
      "id='m'",
      []
    );
    expect(projection('m')).toMatchObject({
      send_status: 'failed',
      turn_index: 9,
      artifact_keys: '["file:b.ts"]',
      flags: F.validJson | F.text | F.toolUse | F.mutatingTool,
    });
  });

  test('copy suppression is transactional and normal body writes resume after commit or rollback', () => {
    put('m', assistant('a.ts'));
    const before = projection('m');
    db.transaction(() => {
      db.exec('INSERT INTO sdk_message_body_copy_active DEFAULT VALUES');
      db.prepare('UPDATE sdk_message_bodies SET sdk_message=?').run(
        JSON.stringify(assistant('skipped.ts'))
      );
      expect(projection('m')).toEqual(before);
      db.exec('DELETE FROM sdk_message_body_copy_active');
    })();
    db.prepare('UPDATE sdk_message_bodies SET sdk_message=?').run(
      JSON.stringify(assistant('after.ts'))
    );
    expect(projection('m').artifact_keys).toBe('["file:after.ts"]');
    expect(() =>
      db.transaction(() => {
        db.exec('INSERT INTO sdk_message_body_copy_active DEFAULT VALUES');
        throw new Error('crash');
      })()
    ).toThrow('crash');
    expect(db.prepare('SELECT COUNT(*) AS n FROM sdk_message_body_copy_active').get()).toEqual({
      n: 0,
    });
    db.prepare('UPDATE sdk_message_bodies SET sdk_message=?').run(
      JSON.stringify(assistant('restart.ts'))
    );
    expect(projection('m').artifact_keys).toBe('["file:restart.ts"]');
  });

  test('task detachment and reattachment preserve existing semantics without deleting message bodies', () => {
    put('m', assistant('a.ts'));
    const before = projection('m');
    db.exec("UPDATE sdk_messages SET task_id=NULL WHERE id='m'");
    expect(projection('m')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sdk_message_bodies').get()).toEqual({ n: 1 });
    db.exec("UPDATE sdk_messages SET task_id='other' WHERE id='m'");
    expect(projection('m')).toEqual({ ...before, task_id: 'other' });
    db.exec("DELETE FROM sdk_messages WHERE id='m'");
    expect(projection('m')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sdk_message_bodies').get()).toEqual({ n: 0 });
  });

  test('body writes outside a task remain unprojected until assigned', () => {
    put('m', assistant('a.ts'), null);
    expect(projection('m')).toBeNull();
    db.exec("UPDATE sdk_messages SET task_id='task' WHERE id='m'");
    expect(projection('m')).toMatchObject({ task_id: 'task', artifact_keys: '["file:a.ts"]' });
  });
});
