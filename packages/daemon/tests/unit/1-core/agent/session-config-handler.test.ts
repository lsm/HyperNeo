import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
  SessionConfigHandler,
  type SessionConfigHandlerContext,
} from '../../../../src/lib/agent/session-config-handler';
import type { Session } from '@hyperneo/shared';
import type { DaemonHub } from '../../../helpers/daemon-hub';
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
      getProcessingState: () => ({ status: 'idle' }),
      restartQuery: mock(async () => {}),
    };

    handler = new SessionConfigHandler(ctx);
  });

  it.each(['ordinary', 'neo:fixture'])(
    'applies the same percentage only at idle for %s',
    async (id) => {
      mockSession.id = id;
      let status = 'processing';
      const restart = mock(async () => {});
      const shared = new SessionConfigHandler({
        session: mockSession,
        db: mockDb,
        internalEventBus: mockInternalEventBus,
        settingsManager: mockSettingsManager,
        getProcessingState: () => ({ status }),
        restartQuery: restart,
      });
      await shared.updateConfig({ autoCompactPercent: 70 });
      expect(mockSession.config.autoCompactPercent).toBeUndefined();
      expect(mockSession.metadata.pendingAutoCompactPercent).toBe(70);
      expect(restart).not.toHaveBeenCalled();
      status = 'idle';
      await shared.applyPendingAutoCompactPercent();
      expect(mockSession.config.autoCompactPercent).toBe(70);
      expect(mockSession.metadata.pendingAutoCompactPercent).toBeUndefined();
      expect(restart).toHaveBeenCalledTimes(1);
      await shared.updateConfig({ autoCompactPercent: undefined });
      expect(mockSession.config.autoCompactPercent).toBeUndefined();
    }
  );

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
    it('should update title', async () => {
      await handler.updateMetadata({ title: 'New Title' });

      expect(mockSession.title).toBe('New Title');
    });

    it('should update status', async () => {
      await handler.updateMetadata({ status: 'archived' });

      expect(mockSession.status).toBe('archived');
    });

    it('should update archivedAt', async () => {
      const timestamp = Date.now();
      await handler.updateMetadata({ archivedAt: timestamp });

      expect(mockSession.archivedAt).toBe(timestamp);
    });

    it('should update worktree', async () => {
      const worktree = {
        enabled: true,
        path: '/worktree/path',
        branch: 'feature-branch',
      };
      await handler.updateMetadata({ worktree });

      expect(mockSession.worktree).toEqual(worktree);
    });

    it('should clear the cached ACP session id', async () => {
      mockSession.acpSessionId = 'remote-session';

      await handler.updateMetadata({ acpSessionId: undefined });

      expect(mockSession.acpSessionId).toBeUndefined();
      expect(updateSessionSpy).toHaveBeenCalledWith(mockSession.id, {
        acpSessionId: undefined,
      });
    });

    it('should merge metadata fields', async () => {
      mockSession.metadata = { existingField: 'value', toUpdate: 'old' };

      await handler.updateMetadata({ metadata: { toUpdate: 'new', newField: 'added' } });

      expect(mockSession.metadata).toEqual({
        existingField: 'value',
        toUpdate: 'new',
        newField: 'added',
      });
    });

    it('should delete metadata fields when value is null', async () => {
      mockSession.metadata = { field1: 'value1', field2: 'value2' };

      await handler.updateMetadata({
        metadata: { field1: null } as unknown as Session['metadata'],
      });

      expect(mockSession.metadata.field1).toBeUndefined();
      expect(mockSession.metadata.field2).toBe('value2');
    });

    it('should delete metadata fields when value is undefined', async () => {
      mockSession.metadata = { field1: 'value1', field2: 'value2' };

      await handler.updateMetadata({
        metadata: { field1: undefined } as unknown as Session['metadata'],
      });

      expect(mockSession.metadata.field1).toBeUndefined();
      expect(mockSession.metadata.field2).toBe('value2');
    });

    it('should merge config updates', async () => {
      mockSession.config = { model: 'default', maxTokens: 4096 } as Session['config'];

      await handler.updateMetadata({ config: { model: 'opus' } as Session['config'] });

      expect(mockSession.config.model).toBe('opus');
      expect(mockSession.config.maxTokens).toBe(4096);
    });

    it('should persist updates to database', async () => {
      const updates = { title: 'Updated Title' };
      await handler.updateMetadata(updates);

      expect(updateSessionSpy).toHaveBeenCalledTimes(1);
      expect(updateSessionSpy).toHaveBeenCalledWith(mockSession.id, updates);
    });

    it('should update workspacePath and recreate settingsManager', async () => {
      const ctx = handler as unknown as { ctx: SessionConfigHandlerContext };
      const originalSettingsManager = ctx.ctx.settingsManager;

      await handler.updateMetadata({ workspacePath: '/new/workspace' });

      expect(mockSession.workspacePath).toBe('/new/workspace');
      expect(ctx.ctx.settingsManager).not.toBe(originalSettingsManager);
      expect(ctx.ctx.settingsManager).toBeInstanceOf(SettingsManager);
    });
  });
});
