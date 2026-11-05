import { expect, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { StateProjectionService } from '../../../../src/lib/state-projection-service';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { AuthManager } from '../../../../src/lib/auth-manager';
import type { SettingsManager } from '../../../../src/lib/settings-manager';
import type { Config } from '../../../../src/config';
import type { Database } from '../../../../src/storage/database';
import { createTestDb, createTestSession } from '../../../helpers/database';

function handler(db: Database, explicit = true) {
  const handlers = new Map<string, (data: unknown) => Promise<unknown>>();
  new StateProjectionService(
    {
      onRequest: (name: string, callback: (data: unknown) => Promise<unknown>) =>
        handlers.set(name, callback),
    } as unknown as MessageHub,
    { getDatabase: () => db } as SessionManager,
    {} as AuthManager,
    {} as SettingsManager,
    {} as Config,
    explicit ? db : undefined
  );
  return handlers.get('state.sdkMessages')!;
}

test('legacy snapshots preserve complete history and since without loading an actor', async () => {
  const db = await createTestDb();
  try {
    await db.createSession(createTestSession('snapshot-history'));
    await db.saveUserMessage(
      'snapshot-history',
      {
        type: 'user',
        uuid: 'snapshot-user',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'Complete history 🦊' },
      },
      'consumed'
    );
    const read = handler(db);
    const page = (await read({ sessionId: 'snapshot-history' })) as {
      sdkMessages: { uuid: string; message: { content: string } }[];
      hasMore: boolean;
      timestamp: number;
    };
    expect(page.sdkMessages).toHaveLength(1);
    expect(page.sdkMessages[0].uuid).toBe('snapshot-user');
    expect(page.sdkMessages[0].message.content).toBe('Complete history 🦊');
    expect(page.hasMore).toBe(false);
    expect(typeof page.timestamp).toBe('number');
    expect(await read({ sessionId: 'snapshot-history', since: Date.now() + 60_000 })).toEqual({
      sdkMessages: [],
      hasMore: false,
      timestamp: expect.any(Number),
    });
  } finally {
    await db.close();
  }
});

test('legacy snapshots preserve missing-session errors and explicit room/conversation fallback', async () => {
  const db = await createTestDb();
  try {
    await expect(handler(db)({ sessionId: 'missing' })).rejects.toThrow('Session not found');
    for (const sessionId of ['conv:missing', 'room:missing']) {
      expect(await handler(db)({ sessionId })).toEqual({
        sdkMessages: [],
        hasMore: false,
        timestamp: expect.any(Number),
      });
      await expect(handler(db, false)({ sessionId })).rejects.toThrow('Session not found');
    }
  } finally {
    await db.close();
  }
});
