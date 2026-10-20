import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  readHyperneoExchange,
  readHyperneoInputs,
  readHyperneoLastResult,
} from '../../../../src/lib/drivers/hyperneo-adapter';
import { readSpaceStartReceipt } from '../../../../src/lib/drivers/space-adapter';
import { readSessionInputEvidence } from '../../../../src/lib/drivers/space-input-evidence';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import {
  SDK_MESSAGE_COLUMN_TYPES,
  deriveSdkMessageColumns,
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

function put(
  id: string,
  type: string,
  body: Record<string, unknown>,
  at: number,
  options: { taskId?: string; seq?: number | null; status?: string; raw?: string } = {}
) {
  const message = { type, ...body };
  const names = Object.keys(SDK_MESSAGE_COLUMN_TYPES) as (keyof typeof SDK_MESSAGE_COLUMN_TYPES)[];
  const derived = deriveSdkMessageColumns(message, options.taskId ?? null);
  db.prepare(
    `INSERT INTO sdk_messages (id,session_id,message_type,message_subtype,sdk_uuid,sdk_message,timestamp,task_id,send_status,consumed_seq,is_terminal,replacement_metadata_normalized,${names.join(',')}) VALUES (?,'s',?,?,?,?,?,?,?,?,?,1,${names.map(() => '?').join(',')})`
  ).run(
    id,
    type,
    type === 'result' ? 'success' : null,
    id,
    options.raw ?? JSON.stringify(message),
    new Date(at * 1000).toISOString(),
    options.taskId ?? null,
    options.status ?? 'consumed',
    options.seq === undefined ? at : options.seq,
    Number(type === 'result'),
    ...names.map((name) => (options.raw ? null : derived[name]))
  );
}

describe('SDK runtime filter contracts', () => {
  test('start receipts reject malformed JSON, replay, compaction and tool results', () => {
    const taskId = 'k';
    put('bad', 'user', {}, 1, { taskId, raw: '{broken' });
    put('replay', 'user', { isReplay: true }, 2, { taskId });
    put('text-zero', 'user', { isReplay: '0' }, 3, { taskId });
    put('compact', 'user', { internal_compaction_turn: 1 }, 4, { taskId });
    put('tool', 'user', { message: { content: [{ type: 'tool_result' }] } }, 5, { taskId });
    expect(readSpaceStartReceipt(db, taskId)).toBeNull();
    put('first', 'user', { isReplay: null }, 6, { taskId });
    put('later', 'user', { isReplay: 0 }, 7, { taskId });
    expect(readSpaceStartReceipt(db, taskId)).toEqual({ executionId: 's', inputId: 'first' });
  });

  test('input evidence skips non-input boundaries and non-billing recovery results', () => {
    put('prompt', 'user', { message: { content: 'Build it' } }, 10);
    put('replay', 'user', { isReplay: true }, 11, { seq: null });
    put('tool', 'user', { message: { content: [{ type: 'tool_result' }] } }, 12, { seq: null });
    put('compact', 'result', { result: 'compact', internal_compaction_turn: 1 }, 13);
    put('recovery', 'result', { result: 'retry', recovery_intercepted: 1 }, 14);
    put('good', 'result', { result: 'Shipped' }, 15);
    const receipt = { executionId: 's', inputId: 'prompt' };
    const evidence = readSessionInputEvidence(db, 's', receipt);
    expect(evidence).toEqual({
      receipt,
      state: 'observed',
      exchange: [
        { at: 10_000, role: 'user', text: 'Build it' },
        { at: 15_000, role: 'agent', text: 'Shipped' },
      ],
      exchangeCut: false,
    });
    put('uncertain', 'user', {}, 16, { seq: null, raw: '{broken' });
    expect(readSessionInputEvidence(db, 's', receipt)).toEqual({ receipt, state: 'unavailable' });
  });

  test('landed inputs keep null kinds and replay text, skipping queued, system and tool-first rows', () => {
    put('human', 'user', { inputKind: 'human', message: { content: 'Human' } }, 1);
    put('system', 'user', { inputKind: 'system', message: { content: 'System' } }, 2);
    put(
      'tool',
      'user',
      { message: { content: [{ type: 'tool_result' }, { type: 'text', text: 'Hidden' }] } },
      3
    );
    put('queued', 'user', { message: { content: 'Queued' } }, 4, { status: 'enqueued' });
    put('null', 'user', { inputKind: null, message: { content: 'Null kind' } }, 5);
    put(
      'replay',
      'user',
      { isReplay: true, message: { content: [{ type: 'text', text: 'Replay text' }] } },
      6
    );
    expect(readHyperneoInputs(db, 's').map((input) => input.text)).toEqual([
      'Human',
      'Null kind',
      'Replay text',
    ]);
    expect(readHyperneoInputs(db, 's', 4_000).map((input) => input.text)).toEqual([
      'Null kind',
      'Replay text',
    ]);
  });

  test('exchange and last-result reads skip compaction but retain their distinct input rules', () => {
    put('human', 'user', { inputKind: 'human', message: { content: 'Fix' } }, 1);
    put('system', 'user', { inputKind: 'system', message: { content: 'Event' } }, 2);
    put('tool', 'user', { message: { content: [{ type: 'tool_result' }] } }, 3);
    put('good', 'result', { result: 'Fixed', is_error: '1' }, 4);
    put('compact', 'result', { result: 'Compacted', internal_compaction_turn: true }, 5);
    expect(readHyperneoLastResult(db, 's')).toEqual({
      reply: 'Fixed',
      failed: '1',
      at: new Date(4_000).toISOString(),
    });
    const exchange = readHyperneoExchange(db, 's', 0);
    expect(exchange.entries.map((entry) => entry.text)).toEqual(['Fix', 'Event', 'Fixed']);
  });
});
