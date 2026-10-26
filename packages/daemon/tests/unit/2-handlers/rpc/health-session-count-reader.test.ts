import { expect, mock, test } from 'bun:test';
import type { HealthStatus, MessageHub, Session } from '@hyperneo/shared';
import { setupSystemHandlers } from '../../../../src/lib/rpc-handlers/system-handlers';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { Database } from '../../../../src/storage/database';
import { BUILD_METADATA } from '../../../../src/lib/build-metadata';
import { createTestDb, createTestSession } from '../../../helpers/database';

function handler(db: Database, active = 5) {
  let read: (() => Promise<HealthStatus>) | undefined;
  const syncCount = mock(() => {
    throw new Error('health must not read its count synchronously');
  });
  const migration = {
    name: 'synthetic-migration',
    state: 'complete',
    through: 4,
    total: 4,
  } as const;
  setupSystemHandlers(
    {
      onRequest: (_name: string, callback: () => Promise<HealthStatus>) => {
        read = callback;
      },
    } as unknown as MessageHub,
    {
      getActiveSessions: () => active,
      getTotalSessions: syncCount,
      getDatabase: () => db,
    } as unknown as SessionManager,
    () => migration
  );
  return { read: () => read!(), syncCount, migration };
}

test('health preserves cached active count and persisted human total semantics', async () => {
  const db = await createTestDb();
  try {
    const sessions: Session[] = [
      createTestSession('health-active'),
      { ...createTestSession('health-paused'), status: 'paused' },
      { ...createTestSession('health-archived'), status: 'archived' },
      { ...createTestSession('health-space'), context: { spaceId: 'synthetic-space' } },
      { ...createTestSession('health-room'), context: { roomId: 'synthetic-room' } },
      { ...createTestSession('health-lobby'), type: 'lobby' },
    ];
    for (const session of sessions) await db.createSession(session);
    const { read, syncCount, migration } = handler(db);
    const response = await read();
    expect(response.sessions).toEqual({ active: 5, total: 3 });
    expect(response.status).toBe('ok');
    expect(response.version).toBe(BUILD_METADATA.version);
    expect(response.uptime).toBeGreaterThanOrEqual(0);
    expect(response.dataMigration).toEqual(migration);
    expect(syncCount).not.toHaveBeenCalled();
  } finally {
    await db.close();
  }
});

test('later health requests observe newly committed sessions', async () => {
  const db = await createTestDb();
  try {
    const { read, syncCount } = handler(db, 0);
    expect((await read()).sessions.total).toBe(0);
    await db.createSession(createTestSession('health-later'));
    expect((await read()).sessions).toEqual({ active: 0, total: 1 });
    expect(syncCount).not.toHaveBeenCalled();
  } finally {
    await db.close();
  }
});

test('health counter reader failure rejects without a stale count or synchronous fallback', async () => {
  const { read, syncCount } = handler({
    gateway: {
      call: async () => {
        throw new Error('synthetic health reader failure');
      },
    },
  } as unknown as Database);
  await expect(read()).rejects.toThrow('synthetic health reader failure');
  expect(syncCount).not.toHaveBeenCalled();
});
