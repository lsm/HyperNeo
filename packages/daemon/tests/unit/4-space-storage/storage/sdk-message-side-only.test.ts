import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

let db: Database;
let repo: SDKMessageRepository;
const result = '完整工具结果'.repeat(100000);
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.exec('PRAGMA foreign_keys=OFF');
  repo = new SDKMessageRepository(db);
});
afterEach(() => db.close());

test('new messages retain every tool-result byte only in the side body', () => {
  const message = {
    type: 'user',
    uuid: 'tool',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't', content: result }],
    },
  } as unknown as SDKMessage;
  repo.saveSDKMessage('s', message);
  expect(repo.getMessageByUuid('s', 'tool')).toMatchObject({ message: message.message });
  expect(db.prepare('SELECT sdk_message FROM sdk_messages').get()).toEqual({ sdk_message: '' });
  expect(db.prepare('SELECT sdk_message FROM sdk_message_bodies').get()).toEqual({
    sdk_message: JSON.stringify(message),
  });
});

test('result flags patch the complete side body without rehydrating the retired column', () => {
  repo.saveSDKMessage('s', { type: 'result', subtype: 'success', uuid: 'r', result } as SDKMessage);
  repo.markResultRecoveryIntercepted('s', 'r', true);
  repo.markResultInternalCompactionTurn('s', 'r');
  expect(repo.getMessageByUuid('s', 'r')).toMatchObject({
    result,
    recovery_intercepted: 1,
    recovery_billing_terminal: 1,
    internal_compaction_turn: 1,
  });
  expect(db.prepare('SELECT sdk_message FROM sdk_messages').get()).toEqual({ sdk_message: '' });
});

test('a side-body failure rolls back the metadata insert', () => {
  db.exec(
    "CREATE TRIGGER reject_synthetic_body BEFORE INSERT ON sdk_message_bodies BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"
  );
  expect(() =>
    repo.saveUserMessage(
      's',
      { type: 'user', uuid: 'failed', message: { role: 'user', content: result } } as SDKMessage,
      'enqueued'
    )
  ).toThrow('synthetic failure');
  expect(db.prepare('SELECT COUNT(*) AS n FROM sdk_messages').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM sdk_message_bodies').get()).toEqual({ n: 0 });
});
