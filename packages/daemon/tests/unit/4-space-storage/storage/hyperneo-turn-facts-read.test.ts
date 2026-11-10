import { beforeEach, describe, expect, test } from 'bun:test';
import { readHyperneoTurnFacts } from '../../../../src/storage/hyperneo-turn-facts-read.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { fillSdkMessageFixtureColumns } from '../../helpers/sdk-message-fixture-columns.ts';

const at = (seconds: number) => new Date(seconds * 1000).toISOString();
let db: Database;
let seq = 0;

function write(
  type: 'user' | 'assistant' | 'result',
  body: object,
  seconds: number,
  columns: { uuid?: string; consumed?: number } = {}
) {
  seq += 1;
  db.prepare(`INSERT INTO sdk_messages (seq, id, session_id, message_type, sdk_message, timestamp,
    sdk_uuid, consumed_seq, is_terminal, message_subtype) VALUES (?, ?, 'w', ?, ?, ?, ?, ?, ?, ?)`).run(
    seq,
    `m${seq}`,
    type,
    JSON.stringify({ type, ...body }),
    at(seconds),
    columns.uuid ?? `u${seq}`,
    columns.consumed ?? null,
    Number(type === 'result'),
    (body as { subtype?: string }).subtype ?? null
  );
}
const input = (uuid: string, seconds: number, consumed: number) =>
  write('user', { message: { content: 'Do it' } }, seconds, { uuid, consumed });
const toolOutput = (text: string, seconds: number) =>
  write(
    'user',
    { message: { content: [{ type: 'tool_result', content: text, tool_use_id: 't' }] } },
    seconds
  );
const result = (text: string, seconds: number, consumed: number, subtype = 'success') =>
  write('result', { subtype, result: text, is_error: false }, seconds, { consumed });
const read = (cursor?: string) => {
  fillSdkMessageFixtureColumns(db);
  return readHyperneoTurnFacts(db, 'w', cursor);
};

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.exec('PRAGMA foreign_keys = OFF');
  seq = 0;
});

describe('HyperNeo turn facts', () => {
  test('a turn holds its inputs, times, ending and the URLs it produced', () => {
    input('in-1', 10, 1);
    write('assistant', { message: { content: 'see https://example.com/thinking' } }, 11);
    toolOutput('Created https://github.com/o/r/pull/7\n', 12);
    result('Opened https://github.com/o/r/pull/7, and https://example.com/a.', 13, 1);
    expect(read()).toEqual([
      expect.objectContaining({
        id: 'm4',
        startedAt: 10_000,
        endedAt: 13_000,
        ended: 'success',
        inputs: ['in-1'],
        urls: ['https://github.com/o/r/pull/7', 'https://example.com/a'],
        complete: true,
      }),
    ]);
  });

  test('final URLs come from the final message only', () => {
    input('in-1', 10, 1);
    toolOutput('Listed https://github.com/o/r/pull/8\n', 11);
    result('Opened https://github.com/o/r/pull/7', 12, 1);
    expect(read()[0].urls).toEqual([
      'https://github.com/o/r/pull/8',
      'https://github.com/o/r/pull/7',
    ]);
    expect(read()[0].finalUrls).toEqual(['https://github.com/o/r/pull/7']);
  });

  test('several inputs share a turn, and an input queued earlier joins the turn that took it', () => {
    input('in-1', 10, 1);
    input('queued', 11, 3);
    input('steer', 12, 2);
    result('First', 13, 2);
    result('Second', 14, 3);
    expect(read().map((turn) => turn.inputs)).toEqual([['in-1', 'steer'], ['queued']]);
  });

  test('a turn with no input of its own is still recorded, starting at the last end', () => {
    input('in-1', 10, 1);
    result('Stopped', 11, 1, 'error_during_execution');
    result('Went on', 20, 1);
    const turns = read();
    expect(turns[0].ended).toBe('error_during_execution');
    expect(turns[1]).toMatchObject({ inputs: [], startedAt: 11_000, endedAt: 20_000 });
  });

  test('a system input is not one of the turn inputs', () => {
    write(
      'user',
      { message: { content: 'The human is now listening.' }, inputKind: 'system' },
      10,
      {
        uuid: 'system',
        consumed: 1,
      }
    );
    input('in-1', 11, 2);
    result('Done', 12, 2);
    expect(read()[0].inputs).toEqual(['in-1']);
  });

  test('a turn still running is not recorded yet', () => {
    input('in-1', 10, 1);
    toolOutput('https://example.com/early', 11);
    expect(read()).toEqual([]);
  });

  test('the cursor resumes after the last turn it read', () => {
    input('in-1', 10, 1);
    result('First', 11, 1);
    const [first] = read();
    input('in-2', 12, 2);
    result('Second', 13, 2);
    expect(read(first.cursor).map((turn) => turn.inputs)).toEqual([['in-2']]);
    expect(read(first.cursor)[0].startedAt).toBe(12_000);
  });

  test('a turn whose output is gone is marked incomplete', () => {
    input('in-1', 10, 1);
    toolOutput('https://example.com/lost', 11);
    result('Done', 12, 1);
    fillSdkMessageFixtureColumns(db);
    db.prepare('DELETE FROM sdk_message_bodies WHERE seq = 2').run();
    db.prepare("UPDATE sdk_messages SET sdk_message = '' WHERE seq = 2").run();
    expect(readHyperneoTurnFacts(db, 'w')[0]).toMatchObject({ complete: false, urls: [] });
  });
});
