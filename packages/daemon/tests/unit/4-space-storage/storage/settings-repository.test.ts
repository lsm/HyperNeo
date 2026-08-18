import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SettingsRepository } from '../../../../src/storage/repositories/settings-repository';
import type { GlobalToolsConfig, GlobalSettings } from '@hyperneo/shared';
import { DEFAULT_GLOBAL_TOOLS_CONFIG, DEFAULT_GLOBAL_SETTINGS } from '@hyperneo/shared';

describe('SettingsRepository', () => {
  let db: Database;
  let repository: SettingsRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
			CREATE TABLE global_tools_config (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				config TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			CREATE TABLE global_settings (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				settings TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);
    repository = new SettingsRepository(db as any);
  });

  afterEach(() => {
    db.close();
  });

  describe('global GitHub polling setting', () => {
    it('should include the default GitHub polling interval', () => {
      const settings = repository.getGlobalSettings();

      expect(settings.githubPollingInterval).toBe(120);
    });

    it('should backfill GitHub polling interval for legacy stored settings', () => {
      const legacySettings = { ...DEFAULT_GLOBAL_SETTINGS };
      delete (legacySettings as Partial<GlobalSettings>).githubPollingInterval;
      db.prepare(
        `INSERT INTO global_settings (id, settings, updated_at) VALUES (1, ?, datetime('now'))`
      ).run(JSON.stringify(legacySettings));

      const settings = repository.getGlobalSettings();

      expect(settings.githubPollingInterval).toBe(120);
    });
  });

  describe('getGlobalToolsConfig', () => {
    it('should return default config when no config exists', () => {
      const config = repository.getGlobalToolsConfig();

      expect(config).toEqual(DEFAULT_GLOBAL_TOOLS_CONFIG);
    });

    it('should return stored config', () => {
      const customConfig: GlobalToolsConfig = {
        systemPrompt: {
          claudeCodePreset: {
            allowed: true,
            defaultEnabled: false,
          },
        },
        settingSources: {
          project: {
            allowed: true,
            defaultEnabled: false,
          },
        },
        mcp: {
          allowProjectMcp: false,
          defaultProjectMcp: false,
        },
      };
      repository.saveGlobalToolsConfig(customConfig);

      const config = repository.getGlobalToolsConfig();

      expect(config.systemPrompt.claudeCodePreset.defaultEnabled).toBe(false);
      expect(config.settingSources.project.defaultEnabled).toBe(false);
      expect(config.mcp.allowProjectMcp).toBe(false);
    });

    it('should merge with defaults for partial config', () => {
      const partialConfig = {
        systemPrompt: {
          claudeCodePreset: {
            allowed: false,
            defaultEnabled: false,
          },
        },
      };
      db.prepare(
        `INSERT INTO global_tools_config (id, config, updated_at) VALUES (1, ?, datetime('now'))`
      ).run(JSON.stringify(partialConfig));

      const config = repository.getGlobalToolsConfig();

      expect(config.systemPrompt.claudeCodePreset.allowed).toBe(false);
      expect(config.settingSources.project.allowed).toBe(
        DEFAULT_GLOBAL_TOOLS_CONFIG.settingSources.project.allowed
      );
      expect(config.mcp.allowProjectMcp).toBe(DEFAULT_GLOBAL_TOOLS_CONFIG.mcp.allowProjectMcp);
    });

    it('should handle backward compatibility from old preset format', () => {
      const oldFormat = {
        preset: {
          claudeCode: {
            allowed: false,
            defaultEnabled: false,
          },
        },
      };
      db.prepare(
        `INSERT INTO global_tools_config (id, config, updated_at) VALUES (1, ?, datetime('now'))`
      ).run(JSON.stringify(oldFormat));

      const config = repository.getGlobalToolsConfig();

      expect(config.systemPrompt.claudeCodePreset.allowed).toBe(false);
      expect(config.systemPrompt.claudeCodePreset.defaultEnabled).toBe(false);
      expect(config.settingSources.project.allowed).toBe(false);
      expect(config.settingSources.project.defaultEnabled).toBe(false);
    });

    it('should prefer new format over old format', () => {
      const mixedFormat = {
        preset: {
          claudeCode: {
            allowed: false,
            defaultEnabled: false,
          },
        },
        systemPrompt: {
          claudeCodePreset: {
            allowed: true,
            defaultEnabled: true,
          },
        },
      };
      db.prepare(
        `INSERT INTO global_tools_config (id, config, updated_at) VALUES (1, ?, datetime('now'))`
      ).run(JSON.stringify(mixedFormat));

      const config = repository.getGlobalToolsConfig();

      expect(config.systemPrompt.claudeCodePreset.allowed).toBe(true);
      expect(config.systemPrompt.claudeCodePreset.defaultEnabled).toBe(true);
    });

    it('should return default config on invalid JSON', () => {
      db.prepare(
        `INSERT INTO global_tools_config (id, config, updated_at) VALUES (1, ?, datetime('now'))`
      ).run('invalid json');

      const config = repository.getGlobalToolsConfig();

      expect(config).toEqual(DEFAULT_GLOBAL_TOOLS_CONFIG);
    });
  });

  describe('saveGlobalToolsConfig', () => {
    it('should save a new config', () => {
      const config: GlobalToolsConfig = {
        systemPrompt: {
          claudeCodePreset: {
            allowed: false,
            defaultEnabled: false,
          },
        },
        settingSources: {
          project: {
            allowed: true,
            defaultEnabled: true,
          },
        },
        mcp: {
          allowProjectMcp: true,
          defaultProjectMcp: true,
        },
      };

      repository.saveGlobalToolsConfig(config);

      const saved = repository.getGlobalToolsConfig();
      expect(saved.systemPrompt.claudeCodePreset.allowed).toBe(false);
    });

    it('should update existing config (upsert)', () => {
      repository.saveGlobalToolsConfig(DEFAULT_GLOBAL_TOOLS_CONFIG);

      const updatedConfig: GlobalToolsConfig = {
        ...DEFAULT_GLOBAL_TOOLS_CONFIG,
        mcp: {
          allowProjectMcp: false,
          defaultProjectMcp: false,
        },
      };
      repository.saveGlobalToolsConfig(updatedConfig);

      const config = repository.getGlobalToolsConfig();
      expect(config.mcp.allowProjectMcp).toBe(false);
    });
  });

  describe('getGlobalSettings', () => {
    it('should return default settings when no settings exist', () => {
      const settings = repository.getGlobalSettings();

      expect(settings.settingSources).toEqual(DEFAULT_GLOBAL_SETTINGS.settingSources);
      expect(settings.permissionMode).toBe(DEFAULT_GLOBAL_SETTINGS.permissionMode);
    });

    it('should return stored settings', () => {
      const customSettings: GlobalSettings = {
        ...DEFAULT_GLOBAL_SETTINGS,
        model: 'opus',
        permissionMode: 'bypassPermissions',
        showArchived: true,
      };
      repository.saveGlobalSettings(customSettings);

      const settings = repository.getGlobalSettings();

      expect(settings.model).toBe('opus');
      expect(settings.permissionMode).toBe('bypassPermissions');
      expect(settings.showArchived).toBe(true);
    });

    it('should merge with defaults for partial settings', () => {
      const partialSettings = {
        model: 'haiku',
      };
      db.prepare(
        `INSERT INTO global_settings (id, settings, updated_at) VALUES (1, ?, datetime('now'))`
      ).run(JSON.stringify(partialSettings));

      const settings = repository.getGlobalSettings();

      expect(settings.model).toBe('haiku');
      expect(settings.permissionMode).toBe(DEFAULT_GLOBAL_SETTINGS.permissionMode);
      expect(settings.showArchived).toBe(DEFAULT_GLOBAL_SETTINGS.showArchived);
    });

    it('should return default settings on invalid JSON', () => {
      db.prepare(
        `INSERT INTO global_settings (id, settings, updated_at) VALUES (1, ?, datetime('now'))`
      ).run('invalid json');

      const settings = repository.getGlobalSettings();

      expect(settings.settingSources).toEqual(DEFAULT_GLOBAL_SETTINGS.settingSources);
    });
  });

  describe('saveGlobalSettings', () => {
    it('should save new settings', () => {
      const settings: GlobalSettings = {
        ...DEFAULT_GLOBAL_SETTINGS,
        model: 'opus',
        autoScroll: false,
        coordinatorMode: true,
      };

      repository.saveGlobalSettings(settings);

      const saved = repository.getGlobalSettings();
      expect(saved.model).toBe('opus');
      expect(saved.autoScroll).toBe(false);
      expect(saved.coordinatorMode).toBe(true);
    });

    it('should update existing settings (upsert)', () => {
      repository.saveGlobalSettings(DEFAULT_GLOBAL_SETTINGS);

      const updatedSettings: GlobalSettings = {
        ...DEFAULT_GLOBAL_SETTINGS,
        permissionMode: 'acceptEdits',
      };
      repository.saveGlobalSettings(updatedSettings);

      const settings = repository.getGlobalSettings();
      expect(settings.permissionMode).toBe('acceptEdits');
    });
  });

  describe('updateGlobalSettings', () => {
    it('should update specific settings', () => {
      repository.saveGlobalSettings(DEFAULT_GLOBAL_SETTINGS);

      const updated = repository.updateGlobalSettings({ model: 'opus' });

      expect(updated.model).toBe('opus');
      expect(updated.permissionMode).toBe(DEFAULT_GLOBAL_SETTINGS.permissionMode);
    });

    it('should preserve existing settings', () => {
      repository.saveGlobalSettings({
        ...DEFAULT_GLOBAL_SETTINGS,
        model: 'opus',
        permissionMode: 'acceptEdits',
      });

      const updated = repository.updateGlobalSettings({ showArchived: true });

      expect(updated.model).toBe('opus');
      expect(updated.permissionMode).toBe('acceptEdits');
      expect(updated.showArchived).toBe(true);
    });

    it('should create settings if they do not exist', () => {
      const updated = repository.updateGlobalSettings({ model: 'sonnet' });

      expect(updated.model).toBe('sonnet');
    });

    it('should update multiple settings at once', () => {
      repository.saveGlobalSettings(DEFAULT_GLOBAL_SETTINGS);

      const updated = repository.updateGlobalSettings({
        model: 'opus',
        permissionMode: 'bypassPermissions',
        showArchived: true,
        autoScroll: false,
      });

      expect(updated.model).toBe('opus');
      expect(updated.permissionMode).toBe('bypassPermissions');
      expect(updated.showArchived).toBe(true);
      expect(updated.autoScroll).toBe(false);
    });

    it('should update nested sandbox settings', () => {
      repository.saveGlobalSettings(DEFAULT_GLOBAL_SETTINGS);

      const updated = repository.updateGlobalSettings({
        sandbox: {
          enabled: false,
        },
      });

      expect(updated.sandbox?.enabled).toBe(false);
    });

    it('should update outputLimiter settings', () => {
      repository.saveGlobalSettings(DEFAULT_GLOBAL_SETTINGS);

      const updated = repository.updateGlobalSettings({
        outputLimiter: {
          enabled: false,
          bash: {
            headLines: 50,
            tailLines: 100,
          },
        },
      });

      expect(updated.outputLimiter?.enabled).toBe(false);
      expect(updated.outputLimiter?.bash?.headLines).toBe(50);
    });
  });

  describe('settings persistence', () => {
    it('should persist settings across repository instances', () => {
      repository.saveGlobalSettings({
        ...DEFAULT_GLOBAL_SETTINGS,
        model: 'custom-model',
      });
      repository.saveGlobalToolsConfig({
        ...DEFAULT_GLOBAL_TOOLS_CONFIG,
        mcp: {
          allowProjectMcp: false,
          defaultProjectMcp: false,
        },
      });

      const newRepository = new SettingsRepository(db as any);

      expect(newRepository.getGlobalSettings().model).toBe('custom-model');
      expect(newRepository.getGlobalToolsConfig().mcp.allowProjectMcp).toBe(false);
    });
  });

  describe('default values verification', () => {
    it('should have correct default tools config', () => {
      const config = repository.getGlobalToolsConfig();

      expect(config.systemPrompt.claudeCodePreset.allowed).toBe(true);
      expect(config.systemPrompt.claudeCodePreset.defaultEnabled).toBe(true);

      expect(config.settingSources.project.allowed).toBe(true);
      expect(config.settingSources.project.defaultEnabled).toBe(true);

      expect(config.mcp.allowProjectMcp).toBe(true);
      expect(config.mcp.defaultProjectMcp).toBe(false);
    });

    it('should have correct default global settings', () => {
      const settings = repository.getGlobalSettings();

      expect(settings.settingSources).toEqual(['user', 'project', 'local']);
      expect(settings.permissionMode).toBe('default');
      expect(settings.model).toBe('sonnet');
      expect(settings.autoScroll).toBe(true);
      expect(settings.coordinatorMode).toBe(false);
      expect(settings.showArchived).toBe(false);
    });
  });
});
