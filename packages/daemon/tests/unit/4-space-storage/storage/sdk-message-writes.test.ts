import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { TableChange } from '../../../../src/storage/db-gateway/db-op';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { sdkMessageWrites } from '../../../../src/storage/repositories/sdk-message-writes';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';

const SESSION_ID = 'sess-writes';
const TASK_ID = 'task-writes';

const initMessage = {
  type: 'system',
  subtype: 'init',
  uuid: 'init-1',
  session_id: SESSION_ID,
} as unknown as SDKMessage;
const assistantMessage = {
  type: 'assistant',
  uuid: 'assistant-1',
  message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
} as unknown as SDKMessage;
const userMessage = (uuid: string) =>
  ({
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'text', text: uuid }] },
  }) as unknown as SDKMessage;

function seededDb(): Database {
  const db = new Database(':memory:');
  createSpaceTables(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata, session_context, type)
     VALUES (?, '', ?, ?, 'active', '{}', '{}', ?, 'worker')`
  ).run(SESSION_ID, now, now, JSON.stringify({ taskId: TASK_ID }));
  return db;
}

interface Writes {
  saveSDKMessage(...args: Parameters<SDKMessageRepository['saveSDKMessage']>): Promise<boolean>;
  saveUserMessage(...args: Parameters<SDKMessageRepository['saveUserMessage']>): Promise<string>;
  updateMessageStatus(...args: Parameters<SDKMessageRepository['updateMessageStatus']>): unknown;
  updateMessageTimestamp(
    ...args: Parameters<SDKMessageRepository['updateMessageTimestamp']>
  ): unknown;
  deletePendingUserMessage(
    ...args: Parameters<SDKMessageRepository['deletePendingUserMessage']>
  ): unknown;
  deleteMessagesAfter(...args: Parameters<SDKMessageRepository['deleteMessagesAfter']>): unknown;
  deleteMessagesAtAndAfter(
    ...args: Parameters<SDKMessageRepository['deleteMessagesAtAndAfter']>
  ): unknown;
}

async function writeConversation(writes: Writes): Promise<void> {
  await writes.saveSDKMessage(SESSION_ID, initMessage);
  await writes.saveSDKMessage(SESSION_ID, assistantMessage);
  const consumed = await writes.saveUserMessage(SESSION_ID, userMessage('user-1'), 'enqueued');
  await writes.updateMessageStatus([consumed], 'consumed');
  await writes.updateMessageTimestamp(consumed, 5_000);
  const pending = await writes.saveUserMessage(SESSION_ID, userMessage('user-2'), 'enqueued');
  await writes.deletePendingUserMessage(SESSION_ID, pending);
  await writes.deleteMessagesAfter(SESSION_ID, 4_000);
  await writes.deleteMessagesAtAndAfter(SESSION_ID, 0);
}

async function changesThroughProxy(): Promise<TableChange[]> {
  const db = seededDb();
  const changes: TableChange[] = [];
  let repository: SDKMessageRepository | null = null;
  const facade = {
    getDatabase: () => db,
    saveSDKMessage: (...args: Parameters<Writes['saveSDKMessage']>) =>
      Promise.resolve(repository!.saveSDKMessage(...args)),
    saveUserMessage: async (...args: Parameters<Writes['saveUserMessage']>) =>
      repository!.saveUserMessage(...args),
    updateMessageStatus: async (...args: Parameters<Writes['updateMessageStatus']>) =>
      repository!.updateMessageStatus(...args),
    updateMessageTimestamp: async (...args: Parameters<Writes['updateMessageTimestamp']>) =>
      repository!.updateMessageTimestamp(...args),
    deletePendingUserMessage: async (...args: Parameters<Writes['deletePendingUserMessage']>) =>
      repository!.deletePendingUserMessage(...args),
    deleteMessagesAfter: async (...args: Parameters<Writes['deleteMessagesAfter']>) =>
      repository!.deleteMessagesAfter(...args),
    deleteMessagesAtAndAfter: async (...args: Parameters<Writes['deleteMessagesAtAndAfter']>) =>
      repository!.deleteMessagesAtAndAfter(...args),
  };
  const reactiveDb = createReactiveDatabase(facade as never);
  repository = new SDKMessageRepository(db, reactiveDb);
  reactiveDb.on('change', ({ tables, scope }) => {
    for (const table of tables) changes.push(scope ? { table, scope } : { table });
  });
  await writeConversation(reactiveDb.db as unknown as Writes);
  return changes;
}

async function changesThroughGateway(): Promise<TableChange[]> {
  const gateway = new DbGateway(':memory:', seededDb());
  const changes: TableChange[] = [];
  gateway.onChanges = (recorded) => changes.push(...recorded);
  await writeConversation({
    saveSDKMessage: (...args) => gateway.call(sdkMessageWrites, 'saveSDKMessage', ...args),
    saveUserMessage: (...args) => gateway.call(sdkMessageWrites, 'saveUserMessage', ...args),
    updateMessageStatus: (...args) =>
      gateway.call(sdkMessageWrites, 'updateMessageStatus', ...args),
    updateMessageTimestamp: (...args) =>
      gateway.call(sdkMessageWrites, 'updateMessageTimestamp', ...args),
    deletePendingUserMessage: (...args) =>
      gateway.call(sdkMessageWrites, 'deletePendingUserMessage', ...args),
    deleteMessagesAfter: (...args) =>
      gateway.call(sdkMessageWrites, 'deleteMessagesAfter', ...args),
    deleteMessagesAtAndAfter: (...args) =>
      gateway.call(sdkMessageWrites, 'deleteMessagesAtAndAfter', ...args),
  });
  return changes;
}

describe('sdkMessageWrites', () => {
  test('records the same table changes and scopes the reactive proxy announced', async () => {
    const proxied = await changesThroughProxy();
    const recorded = await changesThroughGateway();

    expect(recorded).toEqual(proxied);
    expect(recorded).toContainEqual({
      table: 'sdk_messages',
      scope: { sessionId: SESSION_ID, taskId: TASK_ID, messageSubtype: 'init' },
    });
  });

  test('writes the rows a direct repository call writes', async () => {
    const db = seededDb();
    const gateway = new DbGateway(':memory:', db);
    const saved = await gateway.call(
      sdkMessageWrites,
      'saveSDKMessage',
      SESSION_ID,
      assistantMessage
    );
    const id = await gateway.call(
      sdkMessageWrites,
      'saveUserMessage',
      SESSION_ID,
      userMessage('user-1'),
      'enqueued'
    );

    expect(saved).toBe(true);
    const reader = new SDKMessageRepository(db);
    expect(reader.getUserMessageIdsByStatus(SESSION_ID, 'enqueued').map((row) => row.dbId)).toEqual(
      [id]
    );
    expect(reader.getSDKMessageCount(SESSION_ID)).toBe(1);
  });

  test('refuses a method that is not an sdk_messages write', async () => {
    const gateway = new DbGateway(':memory:', seededDb());

    await expect(
      gateway.run(sdkMessageWrites, { method: 'getSDKMessages', args: [SESSION_ID] })
    ).rejects.toThrow('sdk_messages.write does not run getSDKMessages');
  });

  test('the worker registry holds the op', () => {
    expect(DB_OPS.get(sdkMessageWrites.name)).toBe(sdkMessageWrites);
  });
});
