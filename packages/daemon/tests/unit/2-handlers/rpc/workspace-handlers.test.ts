import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTables } from '../../../../src/storage/schema';
import { WorkspaceHistoryRepository } from '../../../../src/storage/repositories/workspace-history-repository';
import { setupWorkspaceHandlers } from '../../../../src/lib/rpc-handlers/workspace-handlers';
import type { MessageHub } from '@hyperneo/shared';
import type { McpImportService } from '../../../../src/lib/mcp/mcp-import-service';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';

type RequestHandler = (data: unknown) => unknown;

function createMockMessageHub(): {
  hub: MessageHub;
  handlers: Map<string, RequestHandler>;
} {
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

describe('workspace handlers', () => {
  let db: BunDatabase;
  let repo: WorkspaceHistoryRepository;
  let handlers: Map<string, RequestHandler>;
  let tempRoot: string;

  function makeWorkspace(name: string): string {
    const path = join(tempRoot, name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createTables(db);
    repo = new WorkspaceHistoryRepository(db);
    const { hub, handlers: h } = createMockMessageHub();
    handlers = h;
    setupWorkspaceHandlers(hub, repo);
    tempRoot = mkdtempSync(join(tmpdir(), 'hyperneo-workspace-handlers-'));
  });

  afterEach(() => {
    db.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe('workspace.history', () => {
    it('returns empty list when no workspaces have been added', async () => {
      const handler = handlers.get('workspace.history')!;
      const result = (await handler({})) as { entries: unknown[] };
      expect(result.entries).toEqual([]);
    });

    it('returns entries sorted by last_used_at descending', async () => {
      db.prepare(
        'INSERT INTO workspace_history (path, last_used_at, use_count) VALUES (?, ?, 1)'
      ).run('/workspace/older', 1000);
      db.prepare(
        'INSERT INTO workspace_history (path, last_used_at, use_count) VALUES (?, ?, 1)'
      ).run('/workspace/newer', 2000);

      const handler = handlers.get('workspace.history')!;
      const result = (await handler({})) as {
        entries: Array<{ path: string; lastUsedAt: number; useCount: number }>;
      };

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].path).toBe('/workspace/newer');
      expect(result.entries[1].path).toBe('/workspace/older');
    });

    it('breaks ties on identical last_used_at by insertion order (newest first)', async () => {
      const sameTs = 1234;
      db.prepare(
        'INSERT INTO workspace_history (path, last_used_at, use_count) VALUES (?, ?, 1)'
      ).run('/workspace/first', sameTs);
      db.prepare(
        'INSERT INTO workspace_history (path, last_used_at, use_count) VALUES (?, ?, 1)'
      ).run('/workspace/second', sameTs);

      const handler = handlers.get('workspace.history')!;
      const result = (await handler({})) as {
        entries: Array<{ path: string }>;
      };

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].path).toBe('/workspace/second');
      expect(result.entries[1].path).toBe('/workspace/first');
    });

    it('maps repository rows to WorkspaceHistoryEntry shape', async () => {
      repo.upsert('/my/project');

      const handler = handlers.get('workspace.history')!;
      const result = (await handler({})) as {
        entries: Array<{ path: string; lastUsedAt: number; useCount: number }>;
      };

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];
      expect(entry.path).toBe('/my/project');
      expect(typeof entry.lastUsedAt).toBe('number');
      expect(entry.useCount).toBe(1);
    });
  });

  describe('workspace.add', () => {
    it('adds a new workspace entry', async () => {
      const workspace = makeWorkspace('my-project');
      const handler = handlers.get('workspace.add')!;
      const result = (await handler({ path: workspace })) as {
        entry: { path: string; lastUsedAt: number; useCount: number };
      };

      expect(result.entry.path).toBe(workspace);
      expect(result.entry.useCount).toBe(1);
      expect(typeof result.entry.lastUsedAt).toBe('number');
    });

    it('increments use_count on duplicate add', async () => {
      const workspace = makeWorkspace('my-project');
      const handler = handlers.get('workspace.add')!;
      await handler({ path: workspace });
      const result = (await handler({ path: workspace })) as {
        entry: { path: string; useCount: number };
      };

      expect(result.entry.useCount).toBe(2);
    });

    it('persists entry so workspace.history returns it', async () => {
      const workspace = makeWorkspace('foo');
      const addHandler = handlers.get('workspace.add')!;
      const historyHandler = handlers.get('workspace.history')!;

      await addHandler({ path: workspace });
      const result = (await historyHandler({})) as {
        entries: Array<{ path: string }>;
      };

      expect(result.entries.some((e) => e.path === workspace)).toBe(true);
    });

    it('throws when path is missing', async () => {
      const handler = handlers.get('workspace.add')!;
      await expect(handler({})).rejects.toThrow('path is required');
    });

    it('throws when path is empty string', async () => {
      const handler = handlers.get('workspace.add')!;
      await expect(handler({ path: '' })).rejects.toThrow('path is required');
    });

    it('throws when path is not a string', async () => {
      const handler = handlers.get('workspace.add')!;
      await expect(handler({ path: 123 })).rejects.toThrow('path is required');
    });

    it('throws when path does not exist on the daemon machine', async () => {
      const handler = handlers.get('workspace.add')!;
      await expect(handler({ path: join(tempRoot, 'missing') })).rejects.toThrow(
        'Workspace path does not exist on the daemon machine'
      );
    });

    it('throws when path is not a directory', async () => {
      const filePath = join(tempRoot, 'file.txt');
      writeFileSync(filePath, 'not a directory');
      const handler = handlers.get('workspace.add')!;
      await expect(handler({ path: filePath })).rejects.toThrow(
        'Workspace path is not a directory on the daemon machine'
      );
    });

    it('uses the namespace-aware MCP refresh path when a service is provided', async () => {
      const workspace = makeWorkspace('with-mcp-service');
      const refreshAllForPath = mock(() => ({
        added: 1,
        updated: 0,
        removed: 0,
        status: 'ok',
        sourcePath: join(workspace, '.mcp.json'),
      }));
      const publishAsync = mock(() => Promise.resolve());
      const mcpImportService = { refreshAllForPath } as unknown as McpImportService;
      const bus = { publishAsync } as unknown as InternalEventBus<DaemonInternalEventMap>;

      const { hub, handlers: localHandlers } = createMockMessageHub();
      setupWorkspaceHandlers(hub, repo, mcpImportService, bus);

      const handler = localHandlers.get('workspace.add')!;
      await handler({ path: workspace });

      expect(refreshAllForPath).toHaveBeenCalledWith(workspace);
      expect(publishAsync).toHaveBeenCalledWith('mcp.registry.changed', { sessionId: 'global' });
    });
  });

  describe('workspace.remove', () => {
    it('removes an existing workspace and returns success=true', async () => {
      repo.upsert('/to/remove');

      const handler = handlers.get('workspace.remove')!;
      const result = (await handler({ path: '/to/remove' })) as { success: boolean };

      expect(result.success).toBe(true);
    });

    it('returns success=false for a non-existent path', async () => {
      const handler = handlers.get('workspace.remove')!;
      const result = (await handler({ path: '/does/not/exist' })) as { success: boolean };

      expect(result.success).toBe(false);
    });

    it('removes entry from history after removal', async () => {
      repo.upsert('/to/remove');

      const removeHandler = handlers.get('workspace.remove')!;
      const historyHandler = handlers.get('workspace.history')!;

      await removeHandler({ path: '/to/remove' });
      const result = (await historyHandler({})) as { entries: Array<{ path: string }> };

      expect(result.entries.some((e) => e.path === '/to/remove')).toBe(false);
    });

    it('throws when path is missing', async () => {
      const handler = handlers.get('workspace.remove')!;
      await expect(handler({})).rejects.toThrow('path is required');
    });

    it('throws when path is empty string', async () => {
      const handler = handlers.get('workspace.remove')!;
      await expect(handler({ path: '' })).rejects.toThrow('path is required');
    });
  });

  describe('WorkspaceHistoryRepository integration', () => {
    it('upsert increments use_count on conflict', () => {
      repo.upsert('/repo/path');
      repo.upsert('/repo/path');
      const row = repo.get('/repo/path');

      expect(row).not.toBeNull();
      expect(row!.use_count).toBe(2);
    });

    it('list respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        repo.upsert(`/workspace/${i}`);
      }

      const rows = repo.list(3);
      expect(rows).toHaveLength(3);
    });

    it('get returns null for unknown path', () => {
      expect(repo.get('/unknown/path')).toBeNull();
    });
  });
});
