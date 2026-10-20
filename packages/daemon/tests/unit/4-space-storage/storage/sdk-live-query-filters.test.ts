import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NAMED_QUERY_REGISTRY } from '../../../../src/lib/live-query/registry';
import { BACKGROUND_TASK_METADATA_SQL } from '../../../../src/lib/live-query/queries/messages';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { runMigration417 } from '../../../../src/storage/schema/m417-sdk-message-session-window';
import { Database } from '../../../../src/storage/sqlite-compat';
import { fillSdkMessageFixtureColumns } from '../../helpers/sdk-message-fixture-columns';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.exec('PRAGMA foreign_keys=OFF');
});
afterEach(() => db.close());

function put(
  id: string,
  body: Record<string, unknown>,
  options: {
    at?: number;
    session?: string;
    parent?: string;
    subtype?: string;
    taskId?: string;
    raw?: string;
  } = {}
) {
  db.prepare(
    `INSERT INTO sdk_messages (id,session_id,message_type,message_subtype,sdk_uuid,sdk_message,timestamp,parent_tool_use_id,task_id,replacement_metadata_normalized) VALUES (?,?,?,?,?,?,?,?,?,1)`
  ).run(
    id,
    options.session ?? 's',
    body.type,
    options.subtype ?? null,
    id,
    options.raw ?? JSON.stringify(body),
    new Date(options.at ?? 1000).toISOString(),
    options.parent ?? null,
    options.taskId ?? null
  );
  fillSdkMessageFixtureColumns(db);
}

function feed(limit = 200) {
  const query = NAMED_QUERY_REGISTRY.get('messages.bySession')!;
  let rows = db.prepare(query.sql).all('s', limit) as Record<string, unknown>[];
  if (query.expandRows) rows = query.expandRows(rows, ['s', limit], db);
  return rows.map(query.mapRow!);
}

describe('SDK live-query filter contracts', () => {
  test('session-window index upgrades are idempotent and leave full bodies unchanged', () => {
    put('tool', {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'Full result' }] },
    });
    const definition = () =>
      db
        .prepare("SELECT sql FROM sqlite_schema WHERE name='idx_sdk_messages_session_window'")
        .get();
    const bodies = () => db.prepare('SELECT id,sdk_message FROM sdk_messages ORDER BY seq').all();
    const fresh = definition();
    const original = bodies();
    db.exec('DROP INDEX idx_sdk_messages_session_window');
    runMigration417(db);
    runMigration417(db);
    expect(definition()).toEqual(fresh);
    expect(bodies()).toEqual(original);
  });

  test('hides only informational info rows while preserving invalid, null and mistyped levels', () => {
    for (const [id, level] of [
      ['info', 'info'],
      ['missing', undefined],
      ['null', null],
      ['false', false],
      ['zero', 0],
      ['notice', 'notice'],
      ['array', ['info']],
    ] as const)
      put(id, { type: 'system', level }, { subtype: 'informational' });
    put('bad', { type: 'system' }, { subtype: 'informational', raw: '{broken' });
    expect(feed().map((row) => row.id)).toEqual([
      'missing',
      'null',
      'false',
      'zero',
      'notice',
      'array',
      'bad',
    ]);
    expect(
      new SDKMessageRepository(db)
        .getSDKMessages('s')
        .messages.map((row) => (row as unknown as { id: string }).id)
    ).toEqual(['missing', 'null', 'false', 'zero', 'notice', 'array', 'bad']);
  });

  test('includes only children of tool calls in the selected top-level window', () => {
    put(
      'old',
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'old-tool' }] } },
      { at: 1000 }
    );
    put(
      'old-child',
      { type: 'assistant', message: { content: [] } },
      { parent: 'old-tool', at: 3000 }
    );
    put(
      'parent',
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool' },
            { type: 'tool_use', id: 'tool' },
          ],
        },
      },
      { at: 2000 }
    );
    put(
      'child',
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Result' }] } },
      { parent: 'tool', at: 2000 }
    );
    put(
      'nested',
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'nested-tool' }] } },
      { parent: 'tool', at: 2000 }
    );
    put(
      'grandchild',
      { type: 'assistant', message: { content: [] } },
      { parent: 'nested-tool', at: 2000 }
    );
    put(
      'foreign',
      { type: 'assistant', message: { content: [] } },
      { session: 'other', parent: 'tool', at: 2000 }
    );
    put(
      'thinking',
      { type: 'assistant', message: { content: [] } },
      { parent: 'tool', subtype: 'thinking_tokens', at: 2000 }
    );
    expect(feed(1).map((row) => row.id)).toEqual(['parent', 'child', 'nested']);
  });

  test('keeps column task ids and latest progress independently for each tool id', () => {
    put('start', { type: 'system' }, { subtype: 'task_started', taskId: 'k', at: 1000 });
    put(
      'older',
      { type: 'system', tool_use_id: 'u' },
      { subtype: 'task_progress', taskId: 'k', at: 2000 }
    );
    put(
      'newer',
      { type: 'system', tool_use_id: 'u' },
      { subtype: 'task_progress', taskId: 'k', at: 2000 }
    );
    put(
      'other-tool',
      { type: 'system', task_id: 'k', tool_use_id: 'v' },
      { subtype: 'task_progress', at: 2000 }
    );
    const rows = db.prepare(BACKGROUND_TASK_METADATA_SQL).all(...Array(7).fill('s')) as {
      id: string;
    }[];
    expect(rows.map((row) => row.id)).toEqual(['other-tool', 'newer', 'start']);
    expect(
      new SDKMessageRepository(db)
        .getBackgroundTaskMessages('s')
        .map((row) => (row as unknown as { id: string }).id)
    ).toEqual(['start', 'newer', 'other-tool']);
  });
});
