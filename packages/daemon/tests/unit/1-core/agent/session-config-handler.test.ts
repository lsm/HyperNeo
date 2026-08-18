import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
  SessionConfigHandler,
  type SessionConfigHandlerContext,
} from '../../../../src/lib/agent/session-config-handler';
import type { Session } from '@hyperneo/shared';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';
import { SettingsManager } from '../../../../src/lib/settings-manager';
import { generateUUID } from '@hyperneo/shared';

describe('SessionConfigHandler', () => {
  let handler: SessionConfigHandler;
  let mockSession: Session;
  let mockDb: Database;
  let mockDaemonHub: DaemonHub;
  let updateSessionSpy: ReturnType<typeof mock>;
  let emitSpy: ReturnType<typeof mock>;
  const mockInternalEventBus = {
    get publish() {
      return emitSpy;
    },
    get publishAsync() {
      return emitSpy;
    },
    subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
  } as unknown as InternalEventBus<any>;
  let mockSettingsManager: SettingsManager;

  beforeEach(() => {
    const sessionId = generateUUID();

    mockSession = {
      id: sessionId,
      title: 'Test Session',
      workspacePath: '/test/workspace',
      status: 'active',
      createdAt: Date.now(),
      config: {
        model: 'default',
      },
      metadata: {
        someField: 'someValue',
      },
    } as Session;

    updateSessionSpy = mock(() => {});
    emitSpy = mock(async () => {});

    mockDb = {
      updateSession: updateSessionSpy,
    } as unknown as Database;

    mockDaemonHub = {
      emit: emitSpy,
    } as unknown as DaemonHub;

    mockSettingsManager = {} as SettingsManager;

    const ctx: SessionConfigHandlerContext = {
      session: mockSession,
      db: mockDb,
      daemonHub: mockDaemonHub,
      internalEventBus: mockInternalEventBus,
      settingsManager: mockSettingsManager,
    };

    handler = new SessionConfigHandler(ctx);
  });

  describe('updateConfig', () => {
    it('should merge config updates with existing config', async () => {
      await handler.updateConfig({ model: 'opus' });

      expect(mockSession.config.model).toBe('opus');
    });

    it('should preserve existing config fields not being updated', async () => {
      mockSession.config = { model: 'default', maxTokens: 4096 } as Session['config'];

      await handler.updateConfig({ model: 'haiku' });

      expect(mockSession.config.model).toBe('haiku');
      expect(mockSession.config.maxTokens).toBe(4096);
    });

    it('should persist config to database', async () => {
      await handler.updateConfig({ model: 'opus' });

      expect(updateSessionSpy).toHaveBeenCalledTimes(1);
      expect(updateSessionSpy).toHaveBeenCalledWith(mockSession.id, {
        config: mockSession.config,
      });
    });

    it('should emit session.updated event', async () => {
      await handler.updateConfig({ model: 'opus' });

      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenCalledWith('session.updated', {
        sessionId: mockSession.id,
        source: 'config-update',
        session: { config: mockSession.config },
      });
    });
  });

  describe('updateMetadata', () => {
    it('should update title', () => {
      handler.updateMetadata({ title: 'New Title' });

      expect(mockSession.title).toBe('New Title');
    });

    it('should update status', () => {
      handler.updateMetadata({ status: 'archived' });

      expect(mockSession.status).toBe('archived');
    });

    it('should update archivedAt', () => {
      const timestamp = Date.now();
      handler.updateMetadata({ archivedAt: timestamp });

      expect(mockSession.archivedAt).toBe(timestamp);
    });

    it('should update worktree', () => {
      const worktree = {
        enabled: true,
        path: '/worktree/path',
        branch: 'feature-branch',
      };
      handler.updateMetadata({ worktree });

      expect(mockSession.worktree).toEqual(worktree);
    });

    it('should merge metadata fields', () => {
      mockSession.metadata = { existingField: 'value', toUpdate: 'old' };

      handler.updateMetadata({ metadata: { toUpdate: 'new', newField: 'added' } });

      expect(mockSession.metadata).toEqual({
        existingField: 'value',
        toUpdate: 'new',
        newField: 'added',
      });
    });

    it('should delete metadata fields when value is null', () => {
      mockSession.metadata = { field1: 'value1', field2: 'value2' };

      handler.updateMetadata({ metadata: { field1: null } as unknown as Session['metadata'] });

      expect(mockSession.metadata.field1).toBeUndefined();
      expect(mockSession.metadata.field2).toBe('value2');
    });

    it('should delete metadata fields when value is undefined', () => {
      mockSession.metadata = { field1: 'value1', field2: 'value2' };

      handler.updateMetadata({
        metadata: { field1: undefined } as unknown as Session['metadata'],
      });

      expect(mockSession.metadata.field1).toBeUndefined();
      expect(mockSession.metadata.field2).toBe('value2');
    });

    it('should merge config updates', () => {
      mockSession.config = { model: 'default', maxTokens: 4096 } as Session['config'];

      handler.updateMetadata({ config: { model: 'opus' } as Session['config'] });

      expect(mockSession.config.model).toBe('opus');
      expect(mockSession.config.maxTokens).toBe(4096);
    });

    it('should persist updates to database', () => {
      const updates = { title: 'Updated Title' };
      handler.updateMetadata(updates);

      expect(updateSessionSpy).toHaveBeenCalledTimes(1);
      expect(updateSessionSpy).toHaveBeenCalledWith(mockSession.id, updates);
    });

    it('should update workspacePath and recreate settingsManager', () => {
      const ctx = handler as unknown as { ctx: SessionConfigHandlerContext };
      const originalSettingsManager = ctx.ctx.settingsManager;

      handler.updateMetadata({ workspacePath: '/new/workspace' });

      expect(mockSession.workspacePath).toBe('/new/workspace');
      expect(ctx.ctx.settingsManager).not.toBe(originalSettingsManager);
      expect(ctx.ctx.settingsManager).toBeInstanceOf(SettingsManager);
    });
  });

  describe('updateUserMcpServers', () => {
    it('should replace subprocess servers with new map', async () => {
      mockSession.config = {
        model: 'default',
        mcpServers: {
          'my-tool': { type: 'stdio', command: 'old', args: [] },
        },
      } as unknown as Session['config'];

      await handler.updateUserMcpServers({
        'my-tool': { type: 'stdio', command: 'new', args: [] },
      });

      expect((mockSession.config.mcpServers as Record<string, unknown>)['my-tool']).toMatchObject({
        command: 'new',
      });
    });

    it('should preserve in-process (SDK-type) servers from existing config', async () => {
      mockSession.config = {
        model: 'default',
        mcpServers: {
          'node-agent': { type: 'sdk' } as unknown,
          'space-agent-tools': { type: 'sdk' } as unknown,
          'my-user-tool': { type: 'stdio', command: 'some-cmd', args: [] },
        },
      } as unknown as Session['config'];

      await handler.updateUserMcpServers({
        'my-user-tool': { type: 'stdio', command: 'some-cmd', args: [] },
      });

      const servers = mockSession.config.mcpServers as Record<string, unknown>;
      expect(servers['node-agent']).toEqual({ type: 'sdk' });
      expect(servers['space-agent-tools']).toEqual({ type: 'sdk' });
      expect(servers['my-user-tool']).toMatchObject({ command: 'some-cmd' });
    });

    it('should not allow user-provided servers to overwrite SDK-type servers', async () => {
      mockSession.config = {
        model: 'default',
        mcpServers: {
          'node-agent': { type: 'sdk', secret: 'closure-value' } as unknown,
        },
      } as unknown as Session['config'];

      await handler.updateUserMcpServers({
        'node-agent': { type: 'stdio', command: 'evil', args: [] },
      });

      const servers = mockSession.config.mcpServers as Record<string, unknown>;
      expect((servers['node-agent'] as { type: string }).type).toBe('sdk');
    });

    it('should persist merged config to database', async () => {
      mockSession.config = {
        model: 'default',
        mcpServers: { 'sdk-server': { type: 'sdk' } as unknown },
      } as unknown as Session['config'];

      await handler.updateUserMcpServers({
        'user-server': { type: 'stdio', command: 'cmd', args: [] },
      });

      expect(updateSessionSpy).toHaveBeenCalledTimes(1);
      const [, patch] = updateSessionSpy.mock.calls[0] as [string, { config: unknown }];
      const servers = (patch.config as { mcpServers: Record<string, unknown> }).mcpServers;
      expect(servers['sdk-server']).toBeDefined();
      expect(servers['user-server']).toBeDefined();
    });

    it('should emit session.updated event after persisting', async () => {
      await handler.updateUserMcpServers({
        'user-server': { type: 'stdio', command: 'cmd', args: [] },
      });

      expect(emitSpy).toHaveBeenCalledTimes(1);
      const [event, payload] = emitSpy.mock.calls[0] as [string, { source: string }];
      expect(event).toBe('session.updated');
      expect(payload.source).toBe('config-update');
    });

    it('should work when session has no existing mcpServers', async () => {
      mockSession.config = { model: 'default' } as Session['config'];

      await handler.updateUserMcpServers({
        'my-tool': { type: 'stdio', command: 'cmd', args: [] },
      });

      const servers = mockSession.config.mcpServers as Record<string, unknown>;
      expect(servers['my-tool']).toBeDefined();
    });
  });
});
