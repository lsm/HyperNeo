import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DatabaseCore } from '../../../../src/storage/database-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectSdkBodyWriteMode } from '../../../../src/storage/sdk-message-body-admission';

let db: Database;
let repo: SDKMessageRepository;
const result = '完整工具结果'.repeat(100000);
beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.exec('PRAGMA foreign_keys=OFF');
  repo = new SDKMessageRepository(db);
  db.exec("INSERT INTO migration_markers VALUES ('sdk_message_bodies_copy_v1:complete',1)");
  await selectSdkBodyWriteMode(db);
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

test.each(['side-only', 'dual-write'])(
  'a side-body failure rolls back metadata in %s mode',
  async (mode) => {
    if (mode === 'dual-write') {
      db.exec("DELETE FROM migration_markers WHERE key='sdk_message_bodies_copy_v1:complete'");
      await selectSdkBodyWriteMode(db);
    }
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
  }
);

test.each(['unfinished', 'missing', 'reversed'])(
  'daemon serves dual-write on %s data, preserving complete tool results',
  async (fault) => {
    const directory = mkdtempSync(join(tmpdir(), 'sdk-side-admission-'));
    const path = join(directory, 'daemon.db');
    const original = new DatabaseCore(path);
    const restarted = new DatabaseCore(path);
    let originalOpen = true;
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
        .prepare('UPDATE sdk_messages SET sdk_message=?')
        .run(JSON.stringify({ type: 'result', uuid: 'keep', subtype: 'success', result }));
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
      original.close();
      originalOpen = false;
      await restarted.initialize();
      const repository = new SDKMessageRepository(restarted.getDb());
      expect(repository.getMessageByUuid('s', 'keep')).toMatchObject({ result });
      repository.markResultInternalCompactionTurn('s', 'keep');
      const legacy = restarted.getDb().prepare('SELECT sdk_message FROM sdk_messages').get() as {
        sdk_message: string;
      };
      const side = restarted
        .getDb()
        .prepare('SELECT sdk_message FROM sdk_message_bodies')
        .get() as { sdk_message: string };
      expect(JSON.parse(side.sdk_message)).toMatchObject({ result, internal_compaction_turn: 1 });
      expect(side).toEqual(legacy);
    } finally {
      if (originalOpen) original.close();
      if (restarted.getDb()) restarted.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
);

test('completion changes writes only on the next startup, with independent DB modes', async () => {
  const other = new Database(':memory:');
  try {
    runMigrations(other, () => {});
    createTables(other);
    other.exec('PRAGMA foreign_keys=OFF');
    expect(await selectSdkBodyWriteMode(other)).toMatchObject({ mode: 'dual-write' });
    const writer = new SDKMessageRepository(other);
    other.exec("INSERT INTO migration_markers VALUES ('sdk_message_bodies_copy_v1:complete',1)");
    writer.saveSDKMessage('s', { type: 'result', uuid: 'during', result } as SDKMessage);
    expect(
      other.prepare("SELECT sdk_message FROM sdk_messages WHERE sdk_uuid='during'").get()
    ).toEqual(other.prepare('SELECT sdk_message FROM sdk_message_bodies').get());
    expect(await selectSdkBodyWriteMode(other)).toMatchObject({ mode: 'side-only' });
    writer.saveSDKMessage('s', { type: 'result', uuid: 'after', result } as SDKMessage);
    expect(
      other.prepare("SELECT sdk_message FROM sdk_messages WHERE sdk_uuid='after'").get()
    ).toEqual({ sdk_message: '' });
    repo.saveSDKMessage('s', { type: 'result', uuid: 'independent', result } as SDKMessage);
    expect(db.prepare('SELECT sdk_message FROM sdk_messages').get()).toEqual({ sdk_message: '' });
    expect(writer.getMessageByUuid('s', 'after')).toMatchObject({ result });
  } finally {
    other.close();
  }
});
