import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  MessageHub,
  Space,
  SpaceMcpListResponse,
  McpImportsRefreshResponse,
} from '@hyperneo/shared';
import { createTables } from '../../../../src/storage/schema';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { AppMcpServerRepository } from '../../../../src/storage/repositories/app-mcp-server-repository';
import { McpEnablementRepository } from '../../../../src/storage/repositories/mcp-enablement-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceWorkspaceRepository } from '../../../../src/storage/repositories/space-workspace-repository';
import { WorkspaceHistoryRepository } from '../../../../src/storage/repositories/workspace-history-repository';
import { setupSpaceMcpHandlers } from '../../../../src/lib/rpc-handlers/space-mcp-handlers';
import { McpImportService } from '../../../../src/lib/mcp/mcp-import-service';
import { createSpaceTables } from '../../helpers/space-test-db';
import type { Database } from '../../../../src/storage/database';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';

type RequestHandler = (data: unknown, context?: unknown) => unknown;

function createMockHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
  const handlers = new Map<string, RequestHandler>();
  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    onEvent: mock(() => () => {}),
    onClientDisconnect: mock(() => () => {}),
    request: mock(async () => {}),
    event: mock(() => {}),
    joinChannel: mock(async () => {}),
    leaveChannel: mock(async () => {}),
    isConnected: mock(() => true),
    getState: mock(() => 'connected' as const),
    onConnection: mock(() => () => {}),
    onMessage: mock(() => () => {}),
    cleanup: mock(() => {}),
    registerTransport: mock(() => () => {}),
    registerRouter: mock(() => {}),
    getRouter: mock(() => null),
    getPendingCallCount: mock(() => 0),
  } as unknown as MessageHub;
  return { hub, handlers };
}

function createMockDaemonHub(): { daemonHub: DaemonHub; emit: ReturnType<typeof mock> } {
  const emit = mock(async () => {});
  const daemonHub = {
    emit,
    on: mock(() => () => {}),
    off: mock(() => {}),
    once: mock(async () => {}),
  } as unknown as DaemonHub;
  return { daemonHub, emit };
}

function createMockInternalEventBus(): InternalEventBus<any> {
  return {
    publish: mock(async () => {}),
    subscribe: mock(() => () => {}),
  } as unknown as InternalEventBus<any>;
}

function fakeSpace(id: string, workspacePath?: string): Space {
  return {
    id,
    name: id,
    slug: id,
    workspacePath: workspacePath ?? `/tmp/${id}`,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Space;
}

function createSpaceManagerMock(spaces: Space[]): SpaceManager {
  return {
    getSpace: mock(async (id: string) => spaces.find((s) => s.id === id) ?? null),
    listSpaces: mock(async () => spaces),
  } as unknown as SpaceManager;
}

describe('space-mcp-handlers', () => {
  let bunDb: BunDatabase;
  let reactiveDb: ReactiveDatabase;
  let db: Database;
  let appMcpRepo: AppMcpServerRepository;
  let enablementRepo: McpEnablementRepository;
  let mcpImportService: McpImportService;
  let tmpRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    bunDb = new BunDatabase(':memory:');
    bunDb.exec('PRAGMA foreign_keys = ON');
    createTables(bunDb);
    createSpaceTables(bunDb);
    reactiveDb = createReactiveDatabase({ getDatabase: () => bunDb } as never);

    appMcpRepo = new AppMcpServerRepository(bunDb, reactiveDb);
    enablementRepo = new McpEnablementRepository(bunDb, reactiveDb);

    const workspaceHistory = new WorkspaceHistoryRepository(bunDb);
    db = {
      appMcpServers: appMcpRepo,
      mcpEnablement: enablementRepo,
      getDatabase: () => bunDb,
      workspaceHistory,
    } as unknown as Database;
    mcpImportService = new McpImportService(db);

    tmpRoot = mkdtempSync(join(tmpdir(), 'space-mcp-handlers-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpRoot;
  });

  afterEach(() => {
    bunDb.close();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('space.mcp.list', () => {
    test('returns one entry per registry row with resolved enabled state', async () => {
      const globalOn = appMcpRepo.create({
        name: 'global-on',
        sourceType: 'stdio',
        command: 'on',
        enabled: true,
        source: 'user',
      });
      const globalOff = appMcpRepo.create({
        name: 'global-off',
        sourceType: 'stdio',
        command: 'off',
        enabled: false,
        source: 'user',
      });

      enablementRepo.setOverride('space', 'space-A', globalOn.id, false);

      const { hub, handlers } = createMockHub();
      const spaceManager = createSpaceManagerMock([fakeSpace('space-A')]);
      setupSpaceMcpHandlers(hub, createMockInternalEventBus(), db, spaceManager);

      const handler = handlers.get('space.mcp.list')!;
      const result = (await handler({ spaceId: 'space-A' })) as SpaceMcpListResponse;

      expect(result.entries).toHaveLength(2);
      const on = result.entries.find((e) => e.serverId === globalOn.id)!;
      expect(on.globallyEnabled).toBe(true);
      expect(on.overridden).toBe(true);
      expect(on.enabled).toBe(false);

      const off = result.entries.find((e) => e.serverId === globalOff.id)!;
      expect(off.globallyEnabled).toBe(false);
      expect(off.overridden).toBe(false);
      expect(off.enabled).toBe(false);
    });

    test('surfaces imported source + sourcePath on entries', async () => {
      appMcpRepo.create({
        name: 'imp',
        sourceType: 'stdio',
        command: 'x',
        source: 'imported',
        sourcePath: '/repo/.mcp.json',
        enabled: true,
      });

      const { hub, handlers } = createMockHub();
      const spaceManager = createSpaceManagerMock([fakeSpace('space-A')]);
      setupSpaceMcpHandlers(hub, createMockInternalEventBus(), db, spaceManager);

      const handler = handlers.get('space.mcp.list')!;
      const result = (await handler({ spaceId: 'space-A' })) as SpaceMcpListResponse;
      const entry = result.entries.find((e) => e.name === 'imp')!;
      expect(entry.source).toBe('imported');
      expect(entry.sourcePath).toBe('/repo/.mcp.json');
    });

    test('throws when spaceId is missing', async () => {
      const { hub, handlers } = createMockHub();
      const spaceManager = createSpaceManagerMock([]);
      setupSpaceMcpHandlers(hub, createMockInternalEventBus(), db, spaceManager);

      const handler = handlers.get('space.mcp.list')!;
      await expect(handler({})).rejects.toThrow('spaceId is required');
    });

    test('throws when space does not exist', async () => {
      const { hub, handlers } = createMockHub();
      const spaceManager = createSpaceManagerMock([fakeSpace('space-A')]);
      setupSpaceMcpHandlers(hub, createMockInternalEventBus(), db, spaceManager);

      const handler = handlers.get('space.mcp.list')!;
      await expect(handler({ spaceId: 'nope' })).rejects.toThrow('Space not found');
    });
  });

  describe('space.mcp.setEnabled', () => {
    test('upserts an override row and emits mcp.registry.changed', async () => {
      const srv = appMcpRepo.create({
        name: 's1',
        sourceType: 'stdio',
        command: 'x',
        enabled: true,
      });

      const { hub, handlers } = createMockHub();
      const spaceManager = createSpaceManagerMock([fakeSpace('space-A')]);
      const internalEventBus = createMockInternalEventBus();
      const publish = internalEventBus.publish as ReturnType<typeof mock>;
      setupSpaceMcpHandlers(hub, internalEventBus, db, spaceManager);

      const handler = handlers.get('space.mcp.setEnabled')!;
      const result = (await handler({
        spaceId: 'space-A',
        serverId: srv.id,
        enabled: false,
      })) as { ok: boolean };

      expect(result.ok).toBe(true);
      expect(enablementRepo.getOverride('space', 'space-A', srv.id)).toEqual({
        scopeType: 'space',
        scopeId: 'space-A',
        serverId: srv.id,
        enabled: false,
      });
      expect(publish).toHaveBeenCalledWith('mcp.registry.changed', {
        sessionId: 'global',
      });
    });

    test('flip — second call replaces the prior override', async () => {
      const srv = appMcpRepo.create({
        name: 'flipper',
        sourceType: 'stdio',
        command: 'x',
        enabled: true,
      });

      const { hub, handlers } = createMockHub();
      const spaceManager = createSpaceManagerMock([fakeSpace('space-A')]);
      setupSpaceMcpHandlers(hub, createMockInternalEventBus(), db, spaceManager);

      const handler = handlers.get('space.mcp.setEnabled')!;
      await handler({ spaceId: 'space-A', serverId: srv.id, enabled: false });
      await handler({ spaceId: 'space-A', serverId: srv.id, enabled: true });

      expect(enablementRepo.getOverride('space', 'space-A', srv.id)).toEqual({
        scopeType: 'space',
        scopeId: 'space-A',
        serverId: srv.id,
        enabled: true,
      });
    });

    test('throws when serverId does not exist', async () => {
      const { hub, handlers } = createMockHub();
      const spaceManager = createSpaceManagerMock([fakeSpace('space-A')]);
      setupSpaceMcpHandlers(hub, createMockInternalEventBus(), db, spaceManager);

      const handler = handlers.get('space.mcp.setEnabled')!;
      await expect(
        handler({ spaceId: 'space-A', serverId: 'ghost', enabled: true })
      ).rejects.toThrow('MCP server not found');
    });

    test('throws on missing required fields', async () => {
      const { hub, handlers } = createMockHub();
      const spaceManager = createSpaceManagerMock([fakeSpace('space-A')]);
      setupSpaceMcpHandlers(hub, createMockInternalEventBus(), db, spaceManager);

      const handler = handlers.get('space.mcp.setEnabled')!;
      await expect(handler({ serverId: 'x', enabled: true })).rejects.toThrow(
        'spaceId is required'
      );
      await expect(handler({ spaceId: 'space-A', enabled: true })).rejects.toThrow(
        'serverId is required'
      );
      await expect(
        handler({ spaceId: 'space-A', serverId: 'x', enabled: 'nope' as never })
      ).rejects.toThrow('enabled must be a boolean');
    });

    test('throws when space does not exist', async () => {
      const { hub, handlers } = createMockHub();
      const spaceManager = createSpaceManagerMock([fakeSpace('space-A')]);
      setupSpaceMcpHandlers(hub, createMockInternalEventBus(), db, spaceManager);

      const handler = handlers.get('space.mcp.setEnabled')!;
      await expect(handler({ spaceId: 'missing', serverId: 'x', enabled: true })).rejects.toThrow(
        'Space not found'
      );
    });
  });

  describe('space.mcp.clearOverride', () => {
    test('removes the override row and emits changed', async () => {
      const srv = appMcpRepo.create({
        name: 'c1',
        sourceType: 'stdio',
        command: 'x',
        enabled: true,
      });
      enablementRepo.setOverride('space', 'space-A', srv.id, false);

      const { hub, handlers } = createMockHub();
      const spaceManager = createSpaceManagerMock([fakeSpace('space-A')]);
      const internalEventBus = createMockInternalEventBus();
      const publish = internalEventBus.publish as ReturnType<typeof mock>;
      setupSpaceMcpHandlers(hub, internalEventBus, db, spaceManager);

      const handler = handlers.get('space.mcp.clearOverride')!;
      const result = (await handler({ spaceId: 'space-A', serverId: srv.id })) as {
        ok: boolean;
      };

      expect(result.ok).toBe(true);
      expect(enablementRepo.getOverride('space', 'space-A', srv.id)).toBeNull();
      expect(publish).toHaveBeenCalledWith('mcp.registry.changed', {
        sessionId: 'global',
      });
    });

    test('idempotent — no override row still returns ok:true and no emit', async () => {
      const srv = appMcpRepo.create({
        name: 'noop',
        sourceType: 'stdio',
        command: 'x',
        enabled: true,
      });

      const { hub, handlers } = createMockHub();
      const { emit } = createMockDaemonHub();
      const spaceManager = createSpaceManagerMock([fakeSpace('space-A')]);
      setupSpaceMcpHandlers(hub, createMockInternalEventBus(), db, spaceManager);

      const handler = handlers.get('space.mcp.clearOverride')!;
      const result = (await handler({ spaceId: 'space-A', serverId: srv.id })) as {
        ok: boolean;
      };
      expect(result.ok).toBe(true);
      expect(emit).not.toHaveBeenCalled();
    });

    test('throws on missing ids', async () => {
      const { hub, handlers } = createMockHub();
      const spaceManager = createSpaceManagerMock([fakeSpace('space-A')]);
      setupSpaceMcpHandlers(hub, createMockInternalEventBus(), db, spaceManager);

      const handler = handlers.get('space.mcp.clearOverride')!;
      await expect(handler({ serverId: 'x' })).rejects.toThrow('spaceId is required');
      await expect(handler({ spaceId: 'space-A' })).rejects.toThrow('serverId is required');
    });
  });

  describe('mcp.imports.refresh', () => {
    test('scans the given workspace and imports new rows', async () => {
      const wsPath = join(tmpRoot, 'ws');
      const fs = await import('node:fs');
      fs.mkdirSync(wsPath, { recursive: true });
      writeFileSync(
        join(wsPath, '.mcp.json'),
        JSON.stringify({ mcpServers: { foo: { command: 'x' } } })
      );

      const { hub, handlers } = createMockHub();
      const spaceManager = createSpaceManagerMock([]);
      const internalEventBus = createMockInternalEventBus();
      const publish = internalEventBus.publish as ReturnType<typeof mock>;
      setupSpaceMcpHandlers(hub, internalEventBus, db, spaceManager, mcpImportService);

      const handler = handlers.get('mcp.imports.refresh')!;
      const result = (await handler({ workspacePath: wsPath })) as McpImportsRefreshResponse;

      expect(result.ok).toBe(true);
      expect(result.imported).toBe(1);
      expect(result.removed).toBe(0);
      expect(appMcpRepo.getByName('foo')?.source).toBe('imported');
      expect(publish).toHaveBeenCalledWith('mcp.registry.changed', {
        sessionId: 'global',
      });
    });

    test('scans the space registry when no workspacePath narrow is given', async () => {
      const ws1 = join(tmpRoot, 'ws1');
      const ws2 = join(tmpRoot, 'ws2');
      const fs = await import('node:fs');
      fs.mkdirSync(ws1, { recursive: true });
      fs.mkdirSync(ws2, { recursive: true });
      writeFileSync(
        join(ws1, '.mcp.json'),
        JSON.stringify({ mcpServers: { one: { command: 'x' } } })
      );
      writeFileSync(
        join(ws2, '.mcp.json'),
        JSON.stringify({ mcpServers: { two: { command: 'y' } } })
      );

      const spaceRepo = new SpaceRepository(bunDb);
      const workspaceRepo = new SpaceWorkspaceRepository(bunDb);
      const spaceA = spaceRepo.createSpace({
        workspacePath: ws1,
        name: 'Repo A',
        slug: 'repo-a',
      });
      workspaceRepo.create({
        spaceId: spaceA.id,
        path: ws1,
        label: 'repo-a',
        isPrimary: true,
      });
      const spaceB = spaceRepo.createSpace({
        workspacePath: ws2,
        name: 'Repo B',
        slug: 'repo-b',
      });
      workspaceRepo.create({
        spaceId: spaceB.id,
        path: ws2,
        label: 'repo-b',
        isPrimary: true,
      });

      const { hub, handlers } = createMockHub();
      const spaceManager = createSpaceManagerMock([fakeSpace('sA', ws1), fakeSpace('sB', ws2)]);
      setupSpaceMcpHandlers(hub, createMockInternalEventBus(), db, spaceManager, mcpImportService);

      const handler = handlers.get('mcp.imports.refresh')!;
      const result = (await handler({})) as McpImportsRefreshResponse;

      expect(result.imported).toBe(2);
      expect(appMcpRepo.getByName('repo-a:one')).toBeTruthy();
      expect(appMcpRepo.getByName('repo-b:two')).toBeTruthy();
    });

    test('does not emit when no import rows changed', async () => {
      const wsPath = join(tmpRoot, 'empty-ws');
      const fs = await import('node:fs');
      fs.mkdirSync(wsPath, { recursive: true });

      const { hub, handlers } = createMockHub();
      const internalEventBus = createMockInternalEventBus();
      const publish = internalEventBus.publish as ReturnType<typeof mock>;
      const spaceManager = createSpaceManagerMock([]);
      setupSpaceMcpHandlers(hub, internalEventBus, db, spaceManager, mcpImportService);

      const handler = handlers.get('mcp.imports.refresh')!;
      const result = (await handler({ workspacePath: wsPath })) as McpImportsRefreshResponse;

      expect(result.imported).toBe(0);
      expect(result.removed).toBe(0);
      expect(publish).not.toHaveBeenCalled();
    });

    test('surfaces parse-error notes from the scanner', async () => {
      const wsPath = join(tmpRoot, 'bad-ws');
      const fs = await import('node:fs');
      fs.mkdirSync(wsPath, { recursive: true });
      writeFileSync(join(wsPath, '.mcp.json'), '{ not valid json');

      const { hub, handlers } = createMockHub();
      const spaceManager = createSpaceManagerMock([]);
      setupSpaceMcpHandlers(hub, createMockInternalEventBus(), db, spaceManager, mcpImportService);

      const handler = handlers.get('mcp.imports.refresh')!;
      const result = (await handler({ workspacePath: wsPath })) as McpImportsRefreshResponse;

      expect(result.notes.some((n) => n.includes('parse error'))).toBe(true);
    });
  });
});
