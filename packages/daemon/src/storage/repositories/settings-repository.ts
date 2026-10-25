import type { SQLiteValue } from '../types.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { GlobalToolsConfig, GlobalSettings } from '@hyperneo/shared';
import { DEFAULT_GLOBAL_TOOLS_CONFIG, DEFAULT_GLOBAL_SETTINGS } from '@hyperneo/shared';

export class SettingsRepository {
  constructor(
    private db: BunDatabase,
    private reactiveDb?: ReactiveDatabase
  ) {}

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
    this.writeGlobalSettings(settings);
  }

  updateGlobalSettings(updates: Partial<GlobalSettings>): GlobalSettings {
    const persisted = this.writeGlobalSettings({ ...DEFAULT_GLOBAL_SETTINGS, ...updates }, updates);
    return { ...DEFAULT_GLOBAL_SETTINGS, ...persisted, ...updates };
  }

  private writeGlobalSettings(
    settings: GlobalSettings,
    updates?: Partial<GlobalSettings>
  ): GlobalSettings {
    const values: SQLiteValue[] = [JSON.stringify(settings)];
    let merged = 'excluded.settings';
    if (updates !== undefined) {
      merged = `CASE WHEN json_valid(global_settings.settings)
        THEN CASE WHEN json_type(global_settings.settings) = 'object'
          THEN global_settings.settings ELSE '{}' END ELSE '{}' END`;
      const removed: string[] = [];
      const assigned: string[] = [];
      const assignments: SQLiteValue[] = [];
      for (const [key, value] of Object.entries(updates)) {
        const path = `$.${JSON.stringify(key)}`;
        if (value === undefined) {
          removed.push('?');
          values.push(path);
        } else {
          assigned.push('?, json(?)');
          assignments.push(path, JSON.stringify(value));
        }
      }
      if (removed.length) merged = `json_remove(${merged}, ${removed.join(', ')})`;
      if (assigned.length) merged = `json_set(${merged}, ${assigned.join(', ')})`;
      values.push(...assignments);
    }
    const row = this.db
      .prepare(`
      INSERT INTO global_settings (id, settings, updated_at) VALUES (1, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET settings = ${merged}, updated_at = excluded.updated_at
      RETURNING settings
    `)
      .get(...values) as { settings: string };
    this.reactiveDb?.notifyChange('global_settings');
    return JSON.parse(row.settings) as GlobalSettings;
  }
}
