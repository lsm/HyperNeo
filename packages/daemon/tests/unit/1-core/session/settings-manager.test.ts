import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsManager } from '../../../../src/lib/settings-manager';
import type { Database } from '../../../../src/storage/database';
import type { GlobalSettings, SettingSource } from '@hyperneo/shared';
import { DEFAULT_GLOBAL_SETTINGS } from '@hyperneo/shared';

describe('SettingsManager', () => {
  let settingsManager: SettingsManager;
  let mockDb: Database;
  let tempDir: string;
  let workspacePath: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `settings-test-${Date.now()}`);
    workspacePath = join(tempDir, 'workspace');
    mkdirSync(workspacePath, { recursive: true });

    originalEnv = process.env.TEST_USER_SETTINGS_DIR;

    const userSettingsDir = join(tempDir, 'user-settings');
    mkdirSync(userSettingsDir, { recursive: true });
    process.env.TEST_USER_SETTINGS_DIR = userSettingsDir;

    mockDb = {
      getGlobalSettings: mock(() => ({ ...DEFAULT_GLOBAL_SETTINGS })),
      updateGlobalSettings: mock((updates: Partial<GlobalSettings>) => ({
        ...DEFAULT_GLOBAL_SETTINGS,
        ...updates,
      })),
      saveGlobalSettings: mock(() => {}),
    } as unknown as Database;

    settingsManager = new SettingsManager(mockDb, workspacePath);
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.TEST_USER_SETTINGS_DIR = originalEnv;
    } else {
      delete process.env.TEST_USER_SETTINGS_DIR;
    }

    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('getGlobalSettings', () => {
    it('should return global settings from database', () => {
      const settings = settingsManager.getGlobalSettings();

      expect(mockDb.getGlobalSettings).toHaveBeenCalled();
      expect(settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
    });
  });

  describe('updateGlobalSettings', () => {
    it('should update global settings partially', () => {
      const updates = { showArchived: true };
      const result = settingsManager.updateGlobalSettings(updates);

      expect(mockDb.updateGlobalSettings).toHaveBeenCalledWith(updates);
      expect(result.showArchived).toBe(true);
    });

    it('should merge with existing settings', () => {
      const updates = { model: 'claude-opus-4-20250514' };
      const result = settingsManager.updateGlobalSettings(updates);

      expect(result.model).toBe('claude-opus-4-20250514');
      expect(result.settingSources).toEqual(DEFAULT_GLOBAL_SETTINGS.settingSources);
    });
  });

  describe('saveGlobalSettings', () => {
    it('should save complete settings to database', () => {
      const newSettings: GlobalSettings = {
        ...DEFAULT_GLOBAL_SETTINGS,
        model: 'claude-opus-4-20250514',
      };

      settingsManager.saveGlobalSettings(newSettings);

      expect(mockDb.saveGlobalSettings).toHaveBeenCalledWith(newSettings);
    });
  });

  describe('prepareSDKOptions', () => {
    it('writes file-only settings without returning SDK options', async () => {
      const result = await settingsManager.prepareSDKOptions();
      expect(result).toBeUndefined();
    });

    it('creates .claude directory if it does not exist', async () => {
      await settingsManager.prepareSDKOptions();

      const settingsDir = join(workspacePath, '.claude');
      expect(existsSync(settingsDir)).toBe(true);
    });

    it('does NOT write legacy MCP enablement keys (M5)', async () => {
      (mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
        ...DEFAULT_GLOBAL_SETTINGS,
      } as GlobalSettings);

      await settingsManager.prepareSDKOptions();

      const settingsPath = join(workspacePath, '.claude/settings.local.json');
      const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));

      expect(content.disabledMcpjsonServers).toBeUndefined();
      expect(content.enabledMcpjsonServers).toBeUndefined();
      expect(content.enableAllProjectMcpServers).toBeUndefined();
    });
  });

  describe('readFileOnlySettings', () => {
    it('should return empty object when file does not exist', () => {
      const result = settingsManager.readFileOnlySettings();

      expect(result).toEqual({});
    });

    it('should read existing settings file', () => {
      const settingsDir = join(workspacePath, '.claude');
      mkdirSync(settingsDir, { recursive: true });
      const settingsPath = join(settingsDir, 'settings.local.json');
      writeFileSync(
        settingsPath,
        JSON.stringify({
          permissions: { ask: ['permission1'] },
          outputStyle: 'concise',
        })
      );

      const result = settingsManager.readFileOnlySettings();

      expect(result.askPermissions).toEqual(['permission1']);
      expect(result.outputStyle).toBe('concise');
    });

    it('should handle malformed JSON gracefully', () => {
      const settingsDir = join(workspacePath, '.claude');
      mkdirSync(settingsDir, { recursive: true });
      const settingsPath = join(settingsDir, 'settings.local.json');
      writeFileSync(settingsPath, 'not valid json');

      const result = settingsManager.readFileOnlySettings();

      expect(result).toEqual({});
    });
  });

  describe('listMcpServersFromSources', () => {
    it('should return empty lists when no settings files exist', () => {
      const result = settingsManager.listMcpServersFromSources();

      expect(result.user).toEqual([]);
      expect(result.project).toEqual([]);
      expect(result.local).toEqual([]);
    });

    it('should read MCP servers from user settings', () => {
      const userSettingsDir = process.env.TEST_USER_SETTINGS_DIR!;
      const userSettingsPath = join(userSettingsDir, 'settings.json');
      writeFileSync(
        userSettingsPath,
        JSON.stringify({
          mcpServers: {
            'user-server': {
              command: 'node',
              args: ['server.js'],
            },
          },
        })
      );

      (mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
        ...DEFAULT_GLOBAL_SETTINGS,
        settingSources: ['user', 'project', 'local'],
      });

      const result = settingsManager.listMcpServersFromSources();

      expect(result.user).toHaveLength(1);
      expect(result.user[0]).toEqual({
        name: 'user-server',
        source: 'user',
        command: 'node',
        args: ['server.js'],
      });
    });

    it('should read MCP servers from project settings', () => {
      const projectSettingsDir = join(workspacePath, '.claude');
      mkdirSync(projectSettingsDir, { recursive: true });
      const projectSettingsPath = join(projectSettingsDir, 'settings.json');
      writeFileSync(
        projectSettingsPath,
        JSON.stringify({
          mcpServers: {
            'project-server': {
              command: 'python',
              args: ['-m', 'server'],
            },
          },
        })
      );

      (mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
        ...DEFAULT_GLOBAL_SETTINGS,
        settingSources: ['user', 'project', 'local'],
      });

      const result = settingsManager.listMcpServersFromSources();

      expect(result.project).toHaveLength(1);
      expect(result.project[0].name).toBe('project-server');
    });

    it('should read MCP servers from local settings', () => {
      const localSettingsDir = join(workspacePath, '.claude');
      mkdirSync(localSettingsDir, { recursive: true });
      const localSettingsPath = join(localSettingsDir, 'settings.local.json');
      writeFileSync(
        localSettingsPath,
        JSON.stringify({
          mcpServers: {
            'local-server': {
              command: 'bash',
              args: ['run.sh'],
            },
          },
        })
      );

      (mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
        ...DEFAULT_GLOBAL_SETTINGS,
        settingSources: ['user', 'project', 'local'],
      });

      const result = settingsManager.listMcpServersFromSources();

      expect(result.local).toHaveLength(1);
      expect(result.local[0].name).toBe('local-server');
    });

    it('should filter sources based on settingSources', () => {
      const userSettingsDir = process.env.TEST_USER_SETTINGS_DIR!;
      writeFileSync(
        join(userSettingsDir, 'settings.json'),
        JSON.stringify({
          mcpServers: { 'user-server': { command: 'node' } },
        })
      );

      const projectSettingsDir = join(workspacePath, '.claude');
      mkdirSync(projectSettingsDir, { recursive: true });
      writeFileSync(
        join(projectSettingsDir, 'settings.json'),
        JSON.stringify({
          mcpServers: { 'project-server': { command: 'python' } },
        })
      );

      (mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
        ...DEFAULT_GLOBAL_SETTINGS,
        settingSources: ['project'] as SettingSource[],
      });

      const result = settingsManager.listMcpServersFromSources();

      expect(result.user).toEqual([]);
      expect(result.project).toHaveLength(1);
      expect(result.local).toEqual([]);
    });

    it('should read from .mcp.json files', () => {
      const projectMcpPath = join(workspacePath, '.mcp.json');
      writeFileSync(
        projectMcpPath,
        JSON.stringify({
          mcpServers: {
            'mcp-json-server': {
              command: 'npx',
              args: ['mcp-server'],
            },
          },
        })
      );

      (mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
        ...DEFAULT_GLOBAL_SETTINGS,
        settingSources: ['project'],
      });

      const result = settingsManager.listMcpServersFromSources();

      expect(result.project).toHaveLength(1);
      expect(result.project[0].name).toBe('mcp-json-server');
    });

    it('should handle malformed settings files gracefully', () => {
      const projectSettingsDir = join(workspacePath, '.claude');
      mkdirSync(projectSettingsDir, { recursive: true });
      writeFileSync(join(projectSettingsDir, 'settings.json'), 'not json');

      (mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
        ...DEFAULT_GLOBAL_SETTINGS,
        settingSources: ['project'],
      });

      const result = settingsManager.listMcpServersFromSources();
      expect(result.project).toEqual([]);
    });
  });

  describe('writeFileOnlySettings (via prepareSDKOptions)', () => {
    it('should write permission settings', async () => {
      (mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
        ...DEFAULT_GLOBAL_SETTINGS,
        askPermissions: ['ask1', 'ask2'],
      });

      await settingsManager.prepareSDKOptions();

      const settingsPath = join(workspacePath, '.claude/settings.local.json');
      const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));

      expect(content.permissions.ask).toEqual(['ask1', 'ask2']);
    });

    it('should write sandbox settings', async () => {
      (mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
        ...DEFAULT_GLOBAL_SETTINGS,
        excludedCommands: ['cmd1', 'cmd2'],
        allowUnsandboxedCommands: true,
      });

      await settingsManager.prepareSDKOptions();

      const settingsPath = join(workspacePath, '.claude/settings.local.json');
      const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));

      expect(content.sandbox.excludedCommands).toEqual(['cmd1', 'cmd2']);
      expect(content.sandbox.allowUnsandboxedCommands).toBe(true);
    });

    it('should write output style', async () => {
      (mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
        ...DEFAULT_GLOBAL_SETTINGS,
        outputStyle: 'concise',
      });

      await settingsManager.prepareSDKOptions();

      const settingsPath = join(workspacePath, '.claude/settings.local.json');
      const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));

      expect(content.outputStyle).toBe('concise');
    });

    it('should write attribution', async () => {
      (mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
        ...DEFAULT_GLOBAL_SETTINGS,
        attribution: { commit: 'abc123' },
      });

      await settingsManager.prepareSDKOptions();

      const settingsPath = join(workspacePath, '.claude/settings.local.json');
      const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));

      expect(content.attribution).toEqual({ commit: 'abc123' });
    });

    it('should preserve existing settings not managed by HyperNeo', async () => {
      const settingsDir = join(workspacePath, '.claude');
      mkdirSync(settingsDir, { recursive: true });
      const settingsPath = join(settingsDir, 'settings.local.json');
      writeFileSync(
        settingsPath,
        JSON.stringify({
          customSetting: 'preserved',
          anotherSetting: 123,
        })
      );

      await settingsManager.prepareSDKOptions();

      const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));

      expect(content.customSetting).toBe('preserved');
      expect(content.anotherSetting).toBe(123);
    });

    it('should create .claude directory if it does not exist', async () => {
      await settingsManager.prepareSDKOptions();

      const settingsDir = join(workspacePath, '.claude');
      expect(existsSync(settingsDir)).toBe(true);
    });
  });

  describe('getEnabledMcpServersConfig', () => {
    it('should return empty object when no settings files exist', () => {
      const result = settingsManager.getEnabledMcpServersConfig();
      expect(result).toEqual({});
    });

    it('should read MCP servers from project .claude/settings.json', () => {
      const settingsDir = join(workspacePath, '.claude');
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, 'settings.json'),
        JSON.stringify({
          mcpServers: {
            github: { command: 'npx', args: ['@github/mcp'] },
          },
        })
      );

      const result = settingsManager.getEnabledMcpServersConfig();
      expect(result).toHaveProperty('github');
      expect((result['github'] as { command: string }).command).toBe('npx');
    });

    it('should read MCP servers from project .mcp.json', () => {
      writeFileSync(
        join(workspacePath, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'my-tool': { command: 'my-cmd', args: ['--flag'] },
          },
        })
      );

      const result = settingsManager.getEnabledMcpServersConfig();
      expect(result).toHaveProperty('my-tool');
    });

    it('should merge project settings.json and .mcp.json', () => {
      const settingsDir = join(workspacePath, '.claude');
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, 'settings.json'),
        JSON.stringify({ mcpServers: { tool1: { command: 'cmd1' } } })
      );
      writeFileSync(
        join(workspacePath, '.mcp.json'),
        JSON.stringify({ mcpServers: { tool2: { command: 'cmd2' } } })
      );

      const result = settingsManager.getEnabledMcpServersConfig();
      expect(result).toHaveProperty('tool1');
      expect(result).toHaveProperty('tool2');
    });

    it('should skip sources excluded from global settingSources', () => {
      (mockDb.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
        ...DEFAULT_GLOBAL_SETTINGS,
        settingSources: ['user', 'local'],
      });

      const settingsDir = join(workspacePath, '.claude');
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, 'settings.json'),
        JSON.stringify({ mcpServers: { project_tool: { command: 'project-cmd' } } })
      );

      const result = settingsManager.getEnabledMcpServersConfig();
      expect(result).not.toHaveProperty('project_tool');
    });

    it('should return empty object when file has no mcpServers field', () => {
      const settingsDir = join(workspacePath, '.claude');
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, 'settings.json'),
        JSON.stringify({ someOtherConfig: 'value' })
      );

      const result = settingsManager.getEnabledMcpServersConfig();
      expect(result).toEqual({});
    });

    it('should handle malformed JSON gracefully', () => {
      const settingsDir = join(workspacePath, '.claude');
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(join(settingsDir, 'settings.json'), 'not valid json {{{');

      const result = settingsManager.getEnabledMcpServersConfig();
      expect(result).toEqual({});
    });

    it('should read MCP servers from user settings.json', () => {
      const userSettingsPath = join(process.env.TEST_USER_SETTINGS_DIR!, 'settings.json');
      writeFileSync(
        userSettingsPath,
        JSON.stringify({
          mcpServers: {
            user_tool: { command: 'user-cmd', args: ['--user'] },
          },
        })
      );

      const result = settingsManager.getEnabledMcpServersConfig();
      expect(result).toHaveProperty('user_tool');
      expect((result['user_tool'] as { command: string }).command).toBe('user-cmd');
    });

    it('should not include servers from settings.local.json (local source excluded)', () => {
      const settingsDir = join(workspacePath, '.claude');
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, 'settings.local.json'),
        JSON.stringify({
          mcpServers: {
            local_only_tool: { command: 'local-cmd' },
          },
        })
      );

      const result = settingsManager.getEnabledMcpServersConfig();
      expect(result).not.toHaveProperty('local_only_tool');
    });

    it('project source overrides user source for same server name', () => {
      const userSettingsPath = join(process.env.TEST_USER_SETTINGS_DIR!, 'settings.json');
      writeFileSync(
        userSettingsPath,
        JSON.stringify({
          mcpServers: {
            'shared-tool': { command: 'user-version' },
          },
        })
      );

      const settingsDir = join(workspacePath, '.claude');
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, 'settings.json'),
        JSON.stringify({
          mcpServers: {
            'shared-tool': { command: 'project-version' },
          },
        })
      );

      const result = settingsManager.getEnabledMcpServersConfig();
      expect(result).toHaveProperty('shared-tool');
      expect((result['shared-tool'] as { command: string }).command).toBe('project-version');
    });
  });
});
