import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createTables } from '../../../../src/storage/schema';
import {
  createReactiveDatabase,
  type ReactiveDatabase,
} from '../../../../src/storage/reactive-database';
import { AppMcpServerRepository } from '../../../../src/storage/repositories/app-mcp-server-repository';
import { McpEnablementRepository } from '../../../../src/storage/repositories/mcp-enablement-repository';

describe('McpEnablementRepository', () => {
  let bunDb: BunDatabase;
  let reactiveDb: ReactiveDatabase;
  let notifyChangeSpy: ReturnType<typeof mock>;
  let appMcpRepo: AppMcpServerRepository;
  let repo: McpEnablementRepository;
  let serverA: string;
  let serverB: string;

  beforeEach(() => {
    bunDb = new BunDatabase(':memory:');
    createTables(bunDb);

    reactiveDb = createReactiveDatabase({ getDatabase: () => bunDb } as never);
    notifyChangeSpy = mock(() => {});
    reactiveDb.notifyChange = notifyChangeSpy;

    appMcpRepo = new AppMcpServerRepository(bunDb, reactiveDb);
    repo = new McpEnablementRepository(bunDb, reactiveDb);

    serverA = appMcpRepo.create({ name: 'server-a', sourceType: 'stdio', command: 'echo' }).id;
    serverB = appMcpRepo.create({ name: 'server-b', sourceType: 'stdio', command: 'echo' }).id;
  });

  afterEach(() => {
    bunDb.close();
  });

  describe('setOverride', () => {
    test('inserts a new row and returns it', () => {
      notifyChangeSpy.mockClear();
      const override = repo.setOverride('space', 'space-1', serverA, false);

      expect(override.scopeType).toBe('space');
      expect(override.scopeId).toBe('space-1');
      expect(override.serverId).toBe(serverA);
      expect(override.enabled).toBe(false);

      expect(notifyChangeSpy).toHaveBeenCalledTimes(1);
      expect(notifyChangeSpy).toHaveBeenCalledWith('mcp_enablement');
    });

    test('updates an existing row (does not duplicate)', () => {
      repo.setOverride('room', 'room-1', serverA, true);
      const second = repo.setOverride('room', 'room-1', serverA, false);

      expect(second.enabled).toBe(false);

      const all = repo.listForScope('room', 'room-1');
      expect(all).toHaveLength(1);
      expect(all[0].enabled).toBe(false);
    });

    test('notifies on update too', () => {
      repo.setOverride('space', 'space-x', serverA, true);
      notifyChangeSpy.mockClear();
      repo.setOverride('space', 'space-x', serverA, false);
      expect(notifyChangeSpy).toHaveBeenCalledTimes(1);
      expect(notifyChangeSpy).toHaveBeenCalledWith('mcp_enablement');
    });

    test('distinct scopes for the same server do not conflict', () => {
      repo.setOverride('space', 'space-1', serverA, false);
      repo.setOverride('room', 'room-1', serverA, true);
      repo.setOverride('session', 'sess-1', serverA, false);

      expect(repo.listForServer(serverA)).toHaveLength(3);
    });
  });

  describe('getOverride', () => {
    test('returns the row when present', () => {
      repo.setOverride('room', 'room-1', serverA, true);
      const row = repo.getOverride('room', 'room-1', serverA);
      expect(row).not.toBeNull();
      expect(row!.enabled).toBe(true);
    });

    test('returns null when missing', () => {
      expect(repo.getOverride('room', 'no-such-room', serverA)).toBeNull();
    });

    test('does not leak overrides across scope types with the same id', () => {
      repo.setOverride('space', 'shared-id', serverA, true);
      expect(repo.getOverride('room', 'shared-id', serverA)).toBeNull();
      expect(repo.getOverride('session', 'shared-id', serverA)).toBeNull();
    });
  });

  describe('listForScope / listForServer / listAll / listForScopes', () => {
    beforeEach(() => {
      repo.setOverride('space', 'space-1', serverA, false);
      repo.setOverride('space', 'space-1', serverB, true);
      repo.setOverride('room', 'room-1', serverA, true);
      repo.setOverride('session', 'sess-1', serverB, false);
    });

    test('listForScope returns every row at that scope only', () => {
      const spaceRows = repo.listForScope('space', 'space-1');
      expect(spaceRows.map((r) => r.serverId).sort()).toEqual([serverA, serverB].sort());
      expect(repo.listForScope('space', 'other')).toEqual([]);
    });

    test('listForServer returns every override targeting a server', () => {
      const rows = repo.listForServer(serverA);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.scopeType).sort()).toEqual(['room', 'space']);
    });

    test('listAll returns every override', () => {
      expect(repo.listAll()).toHaveLength(4);
    });

    test('listForScopes filters to only the scopes passed in', () => {
      const rows = repo.listForScopes([
        { scopeType: 'session', scopeId: 'sess-1' },
        { scopeType: 'space', scopeId: 'space-1' },
      ]);
      expect(rows).toHaveLength(3);
      const byScope = rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.scopeType] = (acc[r.scopeType] ?? 0) + 1;
        return acc;
      }, {});
      expect(byScope).toEqual({ space: 2, session: 1 });
    });

    test('listForScopes returns [] when given an empty chain', () => {
      expect(repo.listForScopes([])).toEqual([]);
    });
  });

  describe('clearOverride', () => {
    test('deletes the row and returns true', () => {
      repo.setOverride('session', 'sess-1', serverA, false);
      notifyChangeSpy.mockClear();

      const deleted = repo.clearOverride('session', 'sess-1', serverA);
      expect(deleted).toBe(true);
      expect(repo.getOverride('session', 'sess-1', serverA)).toBeNull();
      expect(notifyChangeSpy).toHaveBeenCalledTimes(1);
      expect(notifyChangeSpy).toHaveBeenCalledWith('mcp_enablement');
    });

    test('returns false and does not notify when nothing to delete', () => {
      notifyChangeSpy.mockClear();
      const deleted = repo.clearOverride('session', 'nobody', serverA);
      expect(deleted).toBe(false);
      expect(notifyChangeSpy).not.toHaveBeenCalled();
    });
  });

  describe('clearScope', () => {
    test('deletes every row at that scope, returns count, and notifies once', () => {
      repo.setOverride('room', 'room-cleanup', serverA, false);
      repo.setOverride('room', 'room-cleanup', serverB, true);
      repo.setOverride('room', 'room-keep', serverA, false);
      notifyChangeSpy.mockClear();

      const count = repo.clearScope('room', 'room-cleanup');
      expect(count).toBe(2);
      expect(repo.listForScope('room', 'room-cleanup')).toEqual([]);
      expect(repo.listForScope('room', 'room-keep')).toHaveLength(1);
      expect(notifyChangeSpy).toHaveBeenCalledTimes(1);
      expect(notifyChangeSpy).toHaveBeenCalledWith('mcp_enablement');
    });

    test('returns 0 and does not notify when nothing matches', () => {
      notifyChangeSpy.mockClear();
      expect(repo.clearScope('space', 'empty')).toBe(0);
      expect(notifyChangeSpy).not.toHaveBeenCalled();
    });
  });

  describe('foreign key cascade', () => {
    test('deleting the underlying app_mcp_servers row removes overrides', () => {
      bunDb.exec('PRAGMA foreign_keys = ON');
      repo.setOverride('space', 'space-1', serverA, false);
      repo.setOverride('room', 'room-1', serverA, true);

      expect(appMcpRepo.delete(serverA)).toBe(true);

      expect(repo.listForServer(serverA)).toEqual([]);
    });
  });
});
