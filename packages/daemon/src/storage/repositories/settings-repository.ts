/**
 * Settings Repository
 *
 * Responsibilities:
 * - Global tools configuration with backward compatibility
 * - Global settings management
 * - Partial update support
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { GlobalToolsConfig, GlobalSettings } from '@neokai/shared';
import { DEFAULT_GLOBAL_TOOLS_CONFIG, DEFAULT_GLOBAL_SETTINGS } from '@neokai/shared';

export class SettingsRepository {
  constructor(private db: BunDatabase) {}

  // ============================================================================
  // Global Tools Configuration operations
  // ============================================================================

  /**
   * Get the global tools configuration
   *
   * Deep merges stored config with defaults to ensure backward compatibility
   * when new fields are added to GlobalToolsConfig schema.
   */
  getGlobalToolsConfig(): GlobalToolsConfig {
    const stmt = this.db.prepare(`SELECT config FROM global_tools_config WHERE id = 1`);
    const row = stmt.get() as { config: string } | undefined;

    if (!row) {
      return DEFAULT_GLOBAL_TOOLS_CONFIG;
    }

    try {
      // Parse stored config - may be old format or new format
      const parsed = JSON.parse(row.config) as Record<string, unknown>;

      // Deep merge with defaults to ensure all fields exist
      // This handles:
      // 1. DB created before new fields were added
      // 2. Migration from old 'preset' structure to new 'systemPrompt'/'settingSources' structure

      // Handle backward compatibility: old 'preset.claudeCode' maps to new 'systemPrompt.claudeCodePreset'
      // and 'settingSources.project' (both default to same value for consistency)
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
            // New format takes precedence, fall back to old format, then default
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
            // New format takes precedence, fall back to old preset format, then default
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

  /**
   * Save the global tools configuration
   */
  saveGlobalToolsConfig(config: GlobalToolsConfig): void {
    const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO global_tools_config (id, config, updated_at)
			VALUES (1, ?, datetime('now'))
		`);
    stmt.run(JSON.stringify(config));
  }

  // ============================================================================
  // Global Settings operations
  // ============================================================================

  /**
   * Get the global settings
   *
   * Merges stored settings with defaults to ensure backward compatibility
   * when new fields are added to GlobalSettings schema.
   */
  getGlobalSettings(): GlobalSettings {
    const stmt = this.db.prepare(`SELECT settings FROM global_settings WHERE id = 1`);
    const row = stmt.get() as { settings: string } | undefined;

    if (!row) {
      return { ...DEFAULT_GLOBAL_SETTINGS };
    }

    try {
      const settings = JSON.parse(row.settings) as GlobalSettings;
      // Merge with defaults to ensure all required fields exist
      return { ...DEFAULT_GLOBAL_SETTINGS, ...settings };
    } catch {
      return { ...DEFAULT_GLOBAL_SETTINGS };
    }
  }

  /**
   * Save the global settings
   */
  saveGlobalSettings(settings: GlobalSettings): void {
    const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO global_settings (id, settings, updated_at)
			VALUES (1, ?, datetime('now'))
		`);
    stmt.run(JSON.stringify(settings));
  }

  /**
   * Update global settings (partial update)
   */
  updateGlobalSettings(updates: Partial<GlobalSettings>): GlobalSettings {
    const current = this.getGlobalSettings();
    const updated = { ...current, ...updates };
    this.saveGlobalSettings(updated);
    return updated;
  }
}
