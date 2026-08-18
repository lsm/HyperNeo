import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';
import type { GlobalSettings } from '@hyperneo/shared';

describe('Settings RPC Handlers', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, 30_000);

  afterEach(async () => {
    if (!daemon) return;
    await daemon.waitForExit();
  }, 15_000);

  async function createSession(workspacePath: string): Promise<string> {
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath,
    })) as { sessionId: string };
    daemon.trackSession(sessionId);
    return sessionId;
  }

  async function getGlobalSettings(): Promise<GlobalSettings> {
    return (await daemon.messageHub.request('settings.global.get', {})) as GlobalSettings;
  }

  async function updateGlobalSettings(
    updates: Partial<GlobalSettings>
  ): Promise<{ success: boolean; settings: GlobalSettings }> {
    return (await daemon.messageHub.request('settings.global.update', {
      updates,
    })) as { success: boolean; settings: GlobalSettings };
  }

  describe('settings.global.get', () => {
    test('returns default settings', async () => {
      const result = await getGlobalSettings();

      expect(result).toMatchObject({
        settingSources: ['user', 'project', 'local'],
      });
    });

    test('returns saved settings after update', async () => {
      await updateGlobalSettings({
        model: 'claude-opus-4-5-20251101',
      });

      const result = await getGlobalSettings();

      expect(result.model).toBe('claude-opus-4-5-20251101');
    });
  });

  describe('settings.global.update', () => {
    test('updates global settings', async () => {
      const result = await updateGlobalSettings({
        model: 'claude-haiku-3-5-20241022',
      });

      expect(result.success).toBe(true);
      expect(result.settings.model).toBe('claude-haiku-3-5-20241022');
    });

    test('persists updates', async () => {
      await updateGlobalSettings({ model: 'claude-opus-4-5-20251101' });

      const loaded = await getGlobalSettings();
      expect(loaded.model).toBe('claude-opus-4-5-20251101');
    });

    test('performs partial update', async () => {
      await updateGlobalSettings({
        model: 'claude-sonnet-4-5-20250929',
        autoScroll: true,
      });

      const result = await updateGlobalSettings({
        autoScroll: false,
      });

      expect(result.settings.model).toBe('claude-sonnet-4-5-20250929');
      expect(result.settings.autoScroll).toBe(false);
    });
  });

  describe('settings.global.save', () => {
    test('saves complete settings', async () => {
      const completeSettings: GlobalSettings = {
        settingSources: ['project', 'local'],
        model: 'claude-opus-4-5-20251101',
        permissionMode: 'acceptEdits',
      };

      const result = (await daemon.messageHub.request('settings.global.save', {
        settings: completeSettings,
      })) as { success: boolean };

      expect(result.success).toBe(true);

      const loaded = await getGlobalSettings();
      expect(loaded.settingSources).toEqual(['project', 'local']);
      expect(loaded.model).toBe('claude-opus-4-5-20251101');
      expect(loaded.permissionMode).toBe('acceptEdits');
    });
  });

  describe('settings.fileOnly.read', () => {
    test('returns empty object if file does not exist', async () => {
      const result = await daemon.messageHub.request('settings.fileOnly.read', {});
      expect(result).toEqual({});
    });
  });

  describe('showArchived Setting', () => {
    test('defaults to false', async () => {
      const settings = await getGlobalSettings();
      expect(settings.showArchived).toBe(false);
    });

    test('can be updated', async () => {
      const result = await updateGlobalSettings({ showArchived: true });
      expect(result.success).toBe(true);
      expect(result.settings.showArchived).toBe(true);
    });

    test('persists after update', async () => {
      await updateGlobalSettings({ showArchived: true });
      const loaded = await getGlobalSettings();
      expect(loaded.showArchived).toBe(true);
    });

    test('can be toggled multiple times', async () => {
      await updateGlobalSettings({ showArchived: true });
      let settings = await getGlobalSettings();
      expect(settings.showArchived).toBe(true);

      await updateGlobalSettings({ showArchived: false });
      settings = await getGlobalSettings();
      expect(settings.showArchived).toBe(false);

      await updateGlobalSettings({ showArchived: true });
      settings = await getGlobalSettings();
      expect(settings.showArchived).toBe(true);
    });
  });

  describe('thinkingLevel Setting', () => {
    test('defaults to undefined', async () => {
      const settings = await getGlobalSettings();
      expect(settings.thinkingLevel).toBeUndefined();
    });

    test('can be set to think8k', async () => {
      const result = await updateGlobalSettings({ thinkingLevel: 'think8k' });
      expect(result.success).toBe(true);
      expect(result.settings.thinkingLevel).toBe('think8k');
    });

    test('can be set to think16k', async () => {
      const result = await updateGlobalSettings({ thinkingLevel: 'think16k' });
      expect(result.success).toBe(true);
      expect(result.settings.thinkingLevel).toBe('think16k');
    });

    test('can be set to think32k', async () => {
      const result = await updateGlobalSettings({ thinkingLevel: 'think32k' });
      expect(result.success).toBe(true);
      expect(result.settings.thinkingLevel).toBe('think32k');
    });

    test('can be reset to off', async () => {
      await updateGlobalSettings({ thinkingLevel: 'think16k' });
      const result = await updateGlobalSettings({ thinkingLevel: 'off' });
      expect(result.success).toBe(true);
      expect(result.settings.thinkingLevel).toBe('off');
    });

    test('persists after update', async () => {
      await updateGlobalSettings({ thinkingLevel: 'think32k' });
      const loaded = await getGlobalSettings();
      expect(loaded.thinkingLevel).toBe('think32k');
    });
  });

  describe('autoScroll Setting', () => {
    test('defaults to true', async () => {
      const settings = await getGlobalSettings();
      expect(settings.autoScroll).toBe(true);
    });

    test('can be set to false', async () => {
      const result = await updateGlobalSettings({ autoScroll: false });
      expect(result.success).toBe(true);
      expect(result.settings.autoScroll).toBe(false);
    });

    test('persists after update', async () => {
      await updateGlobalSettings({ autoScroll: false });
      const loaded = await getGlobalSettings();
      expect(loaded.autoScroll).toBe(false);
    });

    test('can be toggled', async () => {
      await updateGlobalSettings({ autoScroll: true });
      let settings = await getGlobalSettings();
      expect(settings.autoScroll).toBe(true);

      await updateGlobalSettings({ autoScroll: false });
      settings = await getGlobalSettings();
      expect(settings.autoScroll).toBe(false);
    });
  });

  describe('Global Settings Applied to New Sessions', () => {
    test('new session uses global model setting', async () => {
      await updateGlobalSettings({ model: 'opus' });

      const result = (await daemon.messageHub.request('session.create', {
        workspacePath: '/test/settings-model',
      })) as { sessionId: string; session: { config: { model: string } } };
      daemon.trackSession(result.sessionId);

      expect(result.session.config.model).toBe('opus');
    });

    test('new session uses global thinkingLevel setting', async () => {
      await updateGlobalSettings({ thinkingLevel: 'think16k' });

      const result = (await daemon.messageHub.request('session.create', {
        workspacePath: '/test/settings-thinking',
      })) as { sessionId: string; session: { config: { thinkingLevel?: string } } };
      daemon.trackSession(result.sessionId);

      expect(result.session.config.thinkingLevel).toBe('think16k');
    });

    test('new session uses global autoScroll setting', async () => {
      await updateGlobalSettings({ autoScroll: false });

      const result = (await daemon.messageHub.request('session.create', {
        workspacePath: '/test/settings-autoscroll',
      })) as { sessionId: string; session: { config: { autoScroll?: boolean } } };
      daemon.trackSession(result.sessionId);

      expect(result.session.config.autoScroll).toBe(false);
    });

    test('session-level config overrides global defaults', async () => {
      await updateGlobalSettings({
        model: 'opus',
        thinkingLevel: 'think32k',
        autoScroll: false,
      });

      const result = (await daemon.messageHub.request('session.create', {
        workspacePath: '/test/settings-override',
        config: {
          model: 'haiku',
          thinkingLevel: 'off',
          autoScroll: true,
        },
      })) as {
        sessionId: string;
        session: {
          config: { model: string; thinkingLevel?: string; autoScroll?: boolean };
        };
      };
      daemon.trackSession(result.sessionId);

      expect(result.session.config.model).toBe('haiku');
      expect(result.session.config.thinkingLevel).toBe('off');
      expect(result.session.config.autoScroll).toBe(true);
    });
  });

  describe('settings.mcp.listFromSources', () => {
    test('should list MCP servers without sessionId', async () => {
      const result = (await daemon.messageHub.request('settings.mcp.listFromSources', {})) as {
        servers: unknown;
      };

      expect(result).toHaveProperty('servers');
    });

    test('should list MCP servers with sessionId', async () => {
      const sessionId = await createSession('/test/mcp-list');

      const result = (await daemon.messageHub.request('settings.mcp.listFromSources', {
        sessionId,
      })) as { servers: unknown };

      expect(result).toHaveProperty('servers');
    });

    test('should error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('settings.mcp.listFromSources', {
          sessionId: 'non-existent-session',
        })
      ).rejects.toThrow();
    });
  });

  describe('settings.session.get', () => {
    test('should get session settings', async () => {
      const sessionId = await createSession('/test/session-settings-get');

      const result = (await daemon.messageHub.request('settings.session.get', {
        sessionId,
      })) as { sessionId: string; settings: Record<string, unknown> };

      expect(result.sessionId).toBe(sessionId);
      expect(result.settings).toBeDefined();
    });
  });

  describe('settings.session.update', () => {
    test('should update session settings', async () => {
      const sessionId = await createSession('/test/session-settings-update');

      const result = (await daemon.messageHub.request('settings.session.update', {
        sessionId,
        updates: { someKey: 'someValue' },
      })) as { success: boolean; sessionId: string };

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe(sessionId);
    });
  });

  describe('Concurrent operations', () => {
    test('multiple concurrent updates are handled correctly', async () => {
      await Promise.all([
        updateGlobalSettings({ model: 'claude-opus-4-5-20251101' }),
        updateGlobalSettings({ autoScroll: false }),
        updateGlobalSettings({ showArchived: true }),
      ]);

      const settings = await getGlobalSettings();
      expect(['claude-opus-4-5-20251101', undefined]).toContain(
        settings.model as string | undefined
      );
    });

    test('does NOT register removed legacy MCP RPCs (settings.mcp.toggle, getDisabled, setDisabled, updateServerSettings)', async () => {
      await expect(
        daemon.messageHub.request('settings.mcp.toggle', {
          serverName: 'x',
          enabled: false,
        })
      ).rejects.toThrow();

      await expect(daemon.messageHub.request('settings.mcp.getDisabled', {})).rejects.toThrow();

      await expect(
        daemon.messageHub.request('settings.mcp.setDisabled', {
          disabledServers: [],
        })
      ).rejects.toThrow();

      await expect(
        daemon.messageHub.request('settings.mcp.updateServerSettings', {
          serverName: 'x',
          settings: { allowed: true },
        })
      ).rejects.toThrow();
    });
  });
});
