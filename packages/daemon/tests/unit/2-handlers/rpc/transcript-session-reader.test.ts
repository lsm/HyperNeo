import { expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { setupMessageHandlers } from '../../../../src/lib/rpc-handlers/message-handlers';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { Database } from '../../../../src/storage/database';
import { createTestDb, createTestSession } from '../../../helpers/database';

function handler(db: Database, explicitDb = true) {
  const handlers = new Map<string, (data: unknown) => Promise<unknown>>();
  const hub = {
    onRequest: (name: string, callback: (data: unknown) => Promise<unknown>) =>
      handlers.set(name, callback),
  } as unknown as MessageHub;
  const restore = mock(async () => {
    throw new Error('history must not restore an actor');
  });
  const manager = { getSessionForControl: restore, getDatabase: () => db };
  setupMessageHandlers(hub, manager as unknown as SessionManager, explicitDb ? db : undefined);
  return { read: handlers.get('message.sdkMessages')!, restore };
}

test('persisted transcript reads do not restore an actor', async () => {
  const db = await createTestDb();
  try {
    await db.createSession(createTestSession('persisted-history'));
    await db.saveUserMessage(
      'persisted-history',
      {
        type: 'user',
        uuid: 'history-user',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'Complete history 🦊' },
      },
      'consumed'
    );
    const { read, restore } = handler(db);
    const expected = await db.getSDKMessagePageAsync('persisted-history', { limit: 1 });
    expect(await read({ sessionId: 'persisted-history', limit: 1 })).toEqual(expected);
    expect(restore).not.toHaveBeenCalled();
  } finally {
    await db.close();
  }
});

test('missing ordinary sessions reject through the transcript gate', async () => {
  const db = await createTestDb();
  try {
    const { read, restore } = handler(db);
    await expect(read({ sessionId: 'absent-history' })).rejects.toThrow('Session not found');
    expect(restore).not.toHaveBeenCalled();
  } finally {
    await db.close();
  }
});

test('conversation fallback still needs the explicitly supplied database', async () => {
  const db = await createTestDb();
  try {
    const explicit = handler(db);
    expect(await explicit.read({ sessionId: 'conv:absent' })).toEqual({
      sdkMessages: [],
      hasMore: false,
      backgroundTaskMessages: [],
    });
    const implicit = handler(db, false);
    await expect(implicit.read({ sessionId: 'conv:absent' })).rejects.toThrow('Session not found');
    expect(explicit.restore).not.toHaveBeenCalled();
    expect(implicit.restore).not.toHaveBeenCalled();
  } finally {
    await db.close();
  }
});

test('transcript reader errors reject without actor fallback', async () => {
  const readPage = mock(async () => {
    throw new Error('synthetic transcript reader error');
  });
  const { read, restore } = handler({
    getDbPath: () => ':memory:',
    getSDKMessagePageAsync: readPage,
  } as unknown as Database);
  await expect(read({ sessionId: 'persisted-history' })).rejects.toThrow(
    'synthetic transcript reader error'
  );
  expect(restore).not.toHaveBeenCalled();
});
