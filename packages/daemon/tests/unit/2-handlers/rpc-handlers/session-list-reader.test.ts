import { expect, mock, test } from 'bun:test';
import type { MessageHub, Session } from '@hyperneo/shared';
import { setupSessionHandlers } from '../../../../src/lib/rpc-handlers/session-handlers';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database';

test.each([
  undefined,
  {},
  { status: 'paused' },
  { includeArchived: true },
  { status: 'archived', includeArchived: false },
  { status: 'missing' },
  { includeArchived: true, includeSpaceSessions: true },
])('session.list preserves full persisted rows and filters for %j', async (options) => {
  const db = await createTestDb();
  const bus = await createTestInternalEventBus();
  try {
    const sessions: Session[] = [
      createTestSession('active-list'),
      { ...createTestSession('paused-list'), status: 'paused' },
      { ...createTestSession('archived-list'), status: 'archived' },
      { ...createTestSession('space-list'), context: { spaceId: 'synthetic-space' } },
      { ...createTestSession('room-list'), context: { roomId: 'synthetic-room' } },
      { ...createTestSession('lobby-list'), type: 'lobby' },
    ];
    for (const [index, session] of sessions.entries())
      await db.createSession({
        ...session,
        lastActiveAt: new Date(1_000_000 + index * 1000).toISOString(),
        availableCommands: ['/fixture'],
        processingState: JSON.stringify({ status: 'idle' }),
      });
    const expected = db.listSessions({
      status: options?.status,
      includeArchived: options?.includeArchived,
    });
    const handlers = new Map<string, (data: unknown) => Promise<unknown>>();
    const syncList = mock(() => {
      throw new Error('session list must not use the synchronous manager');
    });
    setupSessionHandlers(
      {
        onRequest: (name: string, callback: (data: unknown) => Promise<unknown>) =>
          handlers.set(name, callback),
      } as unknown as MessageHub,
      { listSessions: syncList, getDatabase: () => db } as unknown as SessionManager,
      bus,
      {} as SpaceManager
    );
    expect(await handlers.get('session.list')!(options)).toEqual({ sessions: expected });
    expect(syncList).not.toHaveBeenCalled();
  } finally {
    bus.clear();
    await db.close();
  }
});

test('session.list propagates a reader rejection without synchronous fallback', async () => {
  const bus = await createTestInternalEventBus();
  try {
    const handlers = new Map<string, (data: unknown) => Promise<unknown>>();
    const syncList = mock(() => {
      throw new Error('synchronous fallback must not run');
    });
    const read = mock(async () => {
      throw new Error('synthetic session-list reader failure');
    });
    setupSessionHandlers(
      {
        onRequest: (name: string, callback: (data: unknown) => Promise<unknown>) =>
          handlers.set(name, callback),
      } as unknown as MessageHub,
      {
        listSessions: syncList,
        getDatabase: () => ({ gateway: { call: read } }),
      } as unknown as SessionManager,
      bus,
      {} as SpaceManager
    );
    await expect(handlers.get('session.list')!({})).rejects.toThrow(
      'synthetic session-list reader failure'
    );
    expect(syncList).not.toHaveBeenCalled();
  } finally {
    bus.clear();
  }
});
