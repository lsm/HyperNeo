import type { Database as BunDatabase } from '../sqlite-compat';
import type { GlobalToolsConfig, GlobalSettings } from '@hyperneo/shared';
import { DEFAULT_GLOBAL_TOOLS_CONFIG, DEFAULT_GLOBAL_SETTINGS } from '@hyperneo/shared';

export class SettingsRepository {
  constructor(private db: BunDatabase) {}

  getGlobalToolsConfig(): GlobalToolsConfig {
    const stmt = this.db.prepare(`SELECT config FROM global_tools_config WHERE id = 1`);
    const row = stmt.get() as { config: string } | undefined;

    if (!row) {
      return DEFAULT_GLOBAL_TOOLS_CONFIG;
    }

    try {
      const parsed = JSON.parse(row.config) as Record<string, unknown>;

      const oldPreset = parsed.preset as
        | { claudeCode?: { allowed?: boolean; defaultEnabled?: boolean } }
        | undefined;
      const newSystemPrompt = parsed.systemPrompt as
        | { claudeCodePreset?: { allowed?: boolean; defaultEnabled?: boolean } }
        | undefined;
      const newSettingSources = parsed.settingSources as
        | { project?: { allowed?: boolean; defaultEnabled?: boolean } }
        | undefined;
      const newMcp = parsed.mcp as
        | { allowProjectMcp?: boolean; defaultProjectMcp?: boolean }
        | undefined;
      return {
        systemPrompt: {
          claudeCodePreset: {
            allowed:
              newSystemPrompt?.claudeCodePreset?.allowed ??
              oldPreset?.claudeCode?.allowed ??
              DEFAULT_GLOBAL_TOOLS_CONFIG.systemPrompt.claudeCodePreset.allowed,
            defaultEnabled:
              newSystemPrompt?.claudeCodePreset?.defaultEnabled ??
              oldPreset?.claudeCode?.defaultEnabled ??
              DEFAULT_GLOBAL_TOOLS_CONFIG.systemPrompt.claudeCodePreset.defaultEnabled,
          },
        },
        settingSources: {
          project: {
            allowed:
              newSettingSources?.project?.allowed ??
              oldPreset?.claudeCode?.allowed ??
              DEFAULT_GLOBAL_TOOLS_CONFIG.settingSources.project.allowed,
            defaultEnabled:
              newSettingSources?.project?.defaultEnabled ??
              oldPreset?.claudeCode?.defaultEnabled ??
              DEFAULT_GLOBAL_TOOLS_CONFIG.settingSources.project.defaultEnabled,
          },
        },
        mcp: {
          allowProjectMcp:
            newMcp?.allowProjectMcp ?? DEFAULT_GLOBAL_TOOLS_CONFIG.mcp.allowProjectMcp,
          defaultProjectMcp:
            newMcp?.defaultProjectMcp ?? DEFAULT_GLOBAL_TOOLS_CONFIG.mcp.defaultProjectMcp,
        },
      };
    } catch {
      return DEFAULT_GLOBAL_TOOLS_CONFIG;
    }
  }

  saveGlobalToolsConfig(config: GlobalToolsConfig): void {
    const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO global_tools_config (id, config, updated_at)
			VALUES (1, ?, datetime('now'))
		`);
    stmt.run(JSON.stringify(config));
  }

  getGlobalSettings(): GlobalSettings {
    const stmt = this.db.prepare(`SELECT settings FROM global_settings WHERE id = 1`);
    const row = stmt.get() as { settings: string } | undefined;

    if (!row) {
      return { ...DEFAULT_GLOBAL_SETTINGS };
    }

    try {
      const settings = JSON.parse(row.settings) as GlobalSettings;
      return { ...DEFAULT_GLOBAL_SETTINGS, ...settings };
    } catch {
      return { ...DEFAULT_GLOBAL_SETTINGS };
    }
  }

  saveGlobalSettings(settings: GlobalSettings): void {
    const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO global_settings (id, settings, updated_at)
			VALUES (1, ?, datetime('now'))
		`);
    stmt.run(JSON.stringify(settings));
  }

  updateGlobalSettings(updates: Partial<GlobalSettings>): GlobalSettings {
    const current = this.getGlobalSettings();
    const updated = { ...current, ...updates };
    this.saveGlobalSettings(updated);
    return updated;
  }
}
