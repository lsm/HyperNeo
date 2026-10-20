import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DatabaseCore } from '../../../../src/storage/database-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  };
  repo.saveSDKMessage('s', message as SDKMessage);
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

test.each(['unfinished', 'missing', 'reversed'])(
  'daemon refuses side-only startup with %s historical data, preserving every byte',
  async (fault) => {
    const directory = mkdtempSync(join(tmpdir(), 'sdk-side-admission-'));
    const path = join(directory, 'daemon.db');
    const original = new DatabaseCore(path);
    const restarted = new DatabaseCore(path);
    try {
      await original.initialize();
      const source = original.getDb();
      source.exec('PRAGMA foreign_keys=OFF');
      new SDKMessageRepository(source).saveSDKMessage('s', {
        type: 'result',
        uuid: 'keep',
        subtype: 'success',
        result,
      } as SDKMessage);
      source
        .prepare('INSERT OR IGNORE INTO migration_markers(key,applied_at) VALUES (?,?)')
        .run(
          fault === 'reversed'
            ? 'sdk_message_bodies_copy_v1:reversed'
            : 'sdk_message_bodies_copy_v1:complete',
          Date.now()
        );
      if (fault === 'unfinished')
        source.exec(
          "DELETE FROM migration_markers WHERE key='sdk_message_bodies_copy_v1:complete'"
        );
      if (fault === 'missing') source.exec('DELETE FROM sdk_message_bodies');
      const before = source.prepare('SELECT * FROM sdk_messages').all();
      original.close();
      await expect(restarted.initialize()).rejects.toThrow('side-only startup refused');
      const read = new Database(path, { readonly: true });
      try {
        expect(read.prepare('SELECT * FROM sdk_messages').all()).toEqual(before);
      } finally {
        read.close();
      }
    } finally {
      original.close();
      if (restarted.getDb()) restarted.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
