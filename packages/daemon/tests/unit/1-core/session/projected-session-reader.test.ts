import { expect, mock, spyOn, test } from 'bun:test';
import {
  DEFAULT_GLOBAL_SETTINGS,
  STATE_CHANNELS,
  type MessageHub,
  type Session,
} from '@hyperneo/shared';
import { Logger } from '../../../../src/lib/logger';
import { StateProjectionService } from '../../../../src/lib/state-projection-service';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { AuthManager } from '../../../../src/lib/auth-manager';
import type { SettingsManager } from '../../../../src/lib/settings-manager';
import type { Config } from '../../../../src/config';
import type { Database } from '../../../../src/storage/database';
import { BUILD_METADATA } from '../../../../src/lib/build-metadata';
import { createTestDb, createTestSession } from '../../../helpers/database';

function fixture(db: Database, showArchived = false) {
  const emit = mock(async () => {});
  const syncCount = mock(() => {
    throw new Error('projected health must not read the count on main');
  });
  const syncList = mock(() => {
    throw new Error('projected inventory must not list sessions on main');
  });
  const service = new StateProjectionService(
    { onRequest: mock(() => () => {}), event: emit } as unknown as MessageHub,
    {
      getActiveSessions: () => 2,
      getTotalSessions: syncCount,
      listSessions: syncList,
      getDatabase: () => db,
    } as unknown as SessionManager,
    {
      getAuthStatus: async () => ({ method: 'none', isAuthenticated: false, source: 'env' }),
    } as AuthManager,
    {
      getGlobalSettings: () => ({ ...DEFAULT_GLOBAL_SETTINGS, showArchived }),
    } as SettingsManager,
    { defaultModel: 'synthetic-model', maxSessions: 9, dbPath: ':memory:' } as Config,
    db
  );
  return { service, syncCount, syncList, emit };
}

test.each([false, true])(
  'full projected session inventory preserves archived mode %j',
  async (showArchived) => {
    const db = await createTestDb();
    try {
      const sessions: Session[] = [
        createTestSession('projection-active'),
        { ...createTestSession('projection-paused'), status: 'paused' },
        { ...createTestSession('projection-archived'), status: 'archived' },
        { ...createTestSession('projection-space'), context: { spaceId: 'synthetic-space' } },
      ];
      for (const session of sessions) await db.createSession(session);
      const expected = db.listSessions(showArchived ? { includeArchived: true } : undefined);
      const { service, syncCount, syncList } = fixture(db, showArchived);
      const result = await service.getGlobalSnapshot();
      expect(result.sessions.sessions).toEqual(expected);
      expect(result.sessions.hasArchivedSessions).toBe(true);
      expect(result.system.health.sessions).toEqual({ active: 2, total: 3 });
      expect(result.system.auth).toEqual({ method: 'none', isAuthenticated: false, source: 'env' });
      expect(result.system.version).toBe(BUILD_METADATA.version);
      expect(result.settings.settings.showArchived).toBe(showArchived);
      expect(result.meta.channel).toBe('global');
      expect(syncCount).not.toHaveBeenCalled();
      expect(syncList).not.toHaveBeenCalled();
    } finally {
      await db.close();
    }
  }
);

test('system-only projection preserves the response without loading session rows', async () => {
  const db = await createTestDb();
  try {
    await db.createSession(createTestSession('projection-system'));
    const { service, syncCount, syncList } = fixture(db);
    const call = spyOn(db.gateway, 'call');
    const result = await service.getGlobalSystemSnapshot();
    expect(result).not.toHaveProperty('sessions');
    expect(result.system.health.sessions).toEqual({ active: 2, total: 1 });
    expect(result.system.defaultModel).toBe('synthetic-model');
    expect(result.system.maxSessions).toBe(9);
    expect(call.mock.calls.map((args) => args[1])).toEqual(['countHumanSessions']);
    call.mockRestore();
    expect(syncCount).not.toHaveBeenCalled();
    expect(syncList).not.toHaveBeenCalled();
  } finally {
    await db.close();
  }
});

test('projected reader errors reject instead of returning stale data or reading synchronously', async () => {
  const { service, syncCount, syncList } = fixture({
    getDataMigrationStatus: () => undefined,
    gateway: {
      call: async () => {
        throw new Error('synthetic projection reader failure');
      },
    },
  } as unknown as Database);
  await expect(service.getGlobalSystemSnapshot()).rejects.toThrow(
    'synthetic projection reader failure'
  );
  await expect(service.getGlobalSnapshot()).rejects.toThrow('synthetic projection reader failure');
  expect(syncCount).not.toHaveBeenCalled();
  expect(syncList).not.toHaveBeenCalled();
});

test('system broadcast absorbs and logs reader failure without publishing or automatically retrying', async () => {
  let attempts = 0;
  const { service, syncCount, syncList, emit } = fixture({
    getDataMigrationStatus: () => undefined,
    gateway: {
      call: async () => {
        if (++attempts === 1) throw new Error('synthetic broadcast reader failure');
        return 3;
      },
    },
  } as unknown as Database);
  const warn = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  try {
    await expect(service.broadcastSystemChange()).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
    expect(attempts).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      '[StateProjectionService] Failed to broadcast system state:',
      'synthetic broadcast reader failure'
    );
    await service.broadcastSystemChange();
    expect(attempts).toBe(2);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      STATE_CHANNELS.GLOBAL_SYSTEM,
      expect.objectContaining({
        version: 2,
        health: expect.objectContaining({ sessions: { active: 2, total: 3 } }),
      }),
      { channel: 'global' }
    );
    expect(syncCount).not.toHaveBeenCalled();
    expect(syncList).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});
