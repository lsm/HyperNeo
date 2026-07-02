/**
 * Settings Manager
 *
 * Manages global and session-specific settings with a hybrid approach:
 * - SDK-supported settings are passed as query() options
 * - File-only settings are written to .claude/settings.local.json
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { GlobalSettings, SettingSource } from '@neokai/shared';
import type { McpServerConfig } from '@neokai/shared/types/sdk-config';

/**
 * MCP server info from a setting source
 */
export interface McpServerInfo {
  name: string;
  source: SettingSource;
  command?: string;
  args?: string[];
}
import type { Database } from '../storage/database';
import { Logger } from './logger';

export class SettingsManager {
  private logger = new Logger('SettingsManager');

  constructor(
    private db: Database,
    private workspacePath?: string
  ) {}

  /**
   * Get current global settings
   */
  getGlobalSettings(): GlobalSettings {
    return this.db.getGlobalSettings();
  }

  /**
   * Update global settings (partial update)
   */
  updateGlobalSettings(updates: Partial<GlobalSettings>): GlobalSettings {
    return this.db.updateGlobalSettings(updates);
  }

  /**
   * Save global settings (full replace)
   */
  saveGlobalSettings(settings: GlobalSettings): void {
    this.db.saveGlobalSettings(settings);
  }

  /**
   * Prepare file-only settings for a session.
   *
   * Writes settings to `.claude/settings.local.json` BEFORE the SDK starts.
   * The SDK reads this file only when `local` is included in the session's
   * `settingSources` (configurable per session/space/agent/global). These
   * settings are also written for tooling that inspects the file directly
   * (e.g. the Claude Code CLI when run by hand against the same workspace).
   *
   * No SDK options are derived here. `QueryOptionsBuilder` constructs the
   * full Options object on its own.
   */
  async prepareSDKOptions(): Promise<void> {
    await this.writeFileOnlySettings(this.getGlobalSettings());
  }

  /**
   * Read attribution from user settings (~/.claude/settings.json)
   * Returns undefined if not found or if there's an error reading the file
   */
  private readUserAttribution(): { commit?: string; pr?: string } | undefined {
    // Support TEST_USER_SETTINGS_DIR for isolated testing
    const baseDir = process.env.TEST_USER_SETTINGS_DIR || join(homedir(), '.claude');
    const userSettingsPath = join(baseDir, 'settings.json');

    try {
      if (!existsSync(userSettingsPath)) {
        return undefined;
      }
      const content = readFileSync(userSettingsPath, 'utf-8');
      const userSettings = JSON.parse(content) as Record<string, unknown>;
      return userSettings.attribution as { commit?: string; pr?: string } | undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Write file-only settings to .claude/settings.local.json
   *
   * These settings have no SDK option equivalent and must be written
   * to the settings file for the SDK to pick them up.
   */
  private async writeFileOnlySettings(settings: GlobalSettings): Promise<void> {
    if (!this.workspacePath) {
      return;
    }

    const settingsLocalPath = join(this.workspacePath, '.claude/settings.local.json');

    // Read existing settings (preserve non-HyperNeo settings)
    let localSettings: Record<string, unknown> = {};
    try {
      if (existsSync(settingsLocalPath)) {
        const content = readFileSync(settingsLocalPath, 'utf-8');
        localSettings = JSON.parse(content) as Record<string, unknown>;
      }
    } catch {
      // Continue with empty object
    }

    // Update HyperNeo-managed settings.
    //
    // NOTE: Legacy MCP toggles (disabledMcpjsonServers, enabledMcpjsonServers,
    // enableAllProjectMcpServers) are intentionally not written here anymore.
    // MCP enablement now flows through the `app_mcp_servers` registry +
    // `mcp_enablement` overrides table; QueryOptionsBuilder always emits
    // `settingSources: []`, so the SDK never reads these keys back from
    // settings.local.json.

    // Permissions (file-only features)
    if (settings.askPermissions !== undefined) {
      localSettings.permissions = {
        ...(localSettings.permissions as Record<string, unknown>),
        ask: settings.askPermissions,
      };
    }

    // Sandbox (file-only features)
    if (
      settings.excludedCommands !== undefined ||
      settings.allowUnsandboxedCommands !== undefined
    ) {
      localSettings.sandbox = {
        ...(localSettings.sandbox as Record<string, unknown>),
      };
      if (settings.excludedCommands !== undefined) {
        (localSettings.sandbox as Record<string, unknown>).excludedCommands =
          settings.excludedCommands;
      }
      if (settings.allowUnsandboxedCommands !== undefined) {
        (localSettings.sandbox as Record<string, unknown>).allowUnsandboxedCommands =
          settings.allowUnsandboxedCommands;
      }
    }

    // UI/Display
    if (settings.outputStyle !== undefined) {
      localSettings.outputStyle = settings.outputStyle;
    }

    // Attribution
    // WORKAROUND: SDK has a bug where attribution settings don't properly cascade
    // from user settings to local settings. To ensure user-level attribution preferences
    // are respected, we explicitly read from user settings and write to local settings.
    // See: https://github.com/anthropics/claude-code/issues/11135
    if (settings.attribution !== undefined) {
      // User has configured attribution in HyperNeo's database, use it
      localSettings.attribution = settings.attribution;
    } else if (localSettings.attribution === undefined) {
      // No attribution in database AND no existing attribution in local file,
      // fall back to user settings to work around SDK bug
      const userAttribution = this.readUserAttribution();
      if (userAttribution !== undefined) {
        localSettings.attribution = userAttribution;
      }
    }
    // If localSettings.attribution is already set, preserve it

    // Ensure directory exists
    mkdirSync(dirname(settingsLocalPath), { recursive: true });

    // Write back
    writeFileSync(settingsLocalPath, JSON.stringify(localSettings, null, 2));
  }

  /**
   * Read current file-only settings from .claude/settings.local.json
   *
   * This is useful for syncing UI state with file state.
   */
  readFileOnlySettings(): Partial<GlobalSettings> {
    if (!this.workspacePath) {
      return {};
    }

    const settingsLocalPath = join(this.workspacePath, '.claude/settings.local.json');

    try {
      if (!existsSync(settingsLocalPath)) {
        return {};
      }

      const content = readFileSync(settingsLocalPath, 'utf-8');
      const localSettings = JSON.parse(content) as Record<string, unknown>;

      return {
        askPermissions:
          ((localSettings.permissions as Record<string, unknown>)?.ask as string[]) || undefined,
        excludedCommands:
          ((localSettings.sandbox as Record<string, unknown>)?.excludedCommands as string[]) ||
          undefined,
        outputStyle: (localSettings.outputStyle as string) || undefined,
        attribution: (localSettings.attribution as { commit?: string; pr?: string }) || undefined,
      };
    } catch {
      return {};
    }
  }

  /**
   * List MCP servers from all enabled setting sources
   *
   * Reads MCP server configurations from:
   * - User: ~/.claude/settings.json
   * - Project: .claude/settings.json in workspace
   * - Local: .claude/settings.local.json in workspace
   *
   * Only returns servers from sources that are enabled in global settings.
   */
  listMcpServersFromSources(): Record<SettingSource, McpServerInfo[]> {
    const globalSettings = this.getGlobalSettings();
    const enabledSources = globalSettings.settingSources || ['user', 'project', 'local'];

    const result: Record<SettingSource, McpServerInfo[]> = {
      user: [],
      project: [],
      local: [],
    };

    // Helper to read MCP servers from a settings file
    const readMcpServers = (filePath: string, source: SettingSource): McpServerInfo[] => {
      try {
        if (!existsSync(filePath)) {
          return [];
        }
        const content = readFileSync(filePath, 'utf-8');
        const settings = JSON.parse(content) as Record<string, unknown>;

        // MCP servers can be in mcpServers object
        const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
        if (!mcpServers || typeof mcpServers !== 'object') {
          return [];
        }

        return Object.entries(mcpServers).map(([name, config]) => {
          const serverConfig = config as Record<string, unknown> | undefined;
          return {
            name,
            source,
            command: serverConfig?.command as string | undefined,
            args: serverConfig?.args as string[] | undefined,
          };
        });
      } catch {
        return [];
      }
    };

    // Read from each enabled source
    if (enabledSources.includes('user')) {
      // Support TEST_USER_SETTINGS_DIR for isolated testing
      const userBaseDir = process.env.TEST_USER_SETTINGS_DIR || join(homedir(), '.claude');
      const userSettingsPath = join(userBaseDir, 'settings.json');
      result.user = readMcpServers(userSettingsPath, 'user');
      // Also check user-level .mcp.json
      const userMcpDir = process.env.TEST_USER_SETTINGS_DIR || homedir();
      const userMcpPath = join(userMcpDir, '.mcp.json');
      result.user.push(...readMcpServers(userMcpPath, 'user'));
    }

    if (enabledSources.includes('project') && this.workspacePath) {
      const projectSettingsPath = join(this.workspacePath, '.claude', 'settings.json');
      result.project = readMcpServers(projectSettingsPath, 'project');
      // Also check project-level .mcp.json (Claude Code standard location)
      const projectMcpPath = join(this.workspacePath, '.mcp.json');
      result.project.push(...readMcpServers(projectMcpPath, 'project'));
    }

    if (enabledSources.includes('local') && this.workspacePath) {
      const localSettingsPath = join(this.workspacePath, '.claude', 'settings.local.json');
      result.local = readMcpServers(localSettingsPath, 'local');
    }

    return result;
  }

  /**
   * Get full MCP server configs from user and project settings files.
   *
   * Reads raw MCP server config objects (command, args, env, type, url, etc.) from:
   * - User: ~/.claude/settings.json and ~/.mcp.json
   * - Project: .claude/settings.json and .mcp.json in workspace
   *
   * The `local` source (.claude/settings.local.json) is intentionally excluded because
   * the daemon itself writes to that file via writeFileOnlySettings. Including it would
   * create a bypass vector where the daemon could inject servers into room agent sessions.
   *
   * Only includes servers from enabled sources. Returns a merged map where
   * project servers override user servers with the same name.
   */
  getEnabledMcpServersConfig(): Record<string, McpServerConfig> {
    const globalSettings = this.getGlobalSettings();
    const enabledSources = globalSettings.settingSources || ['user', 'project', 'local'];

    const readRawMcpServers = (filePath: string): Record<string, McpServerConfig> => {
      try {
        if (!existsSync(filePath)) return {};
        const content = readFileSync(filePath, 'utf-8');
        const settings = JSON.parse(content) as Record<string, unknown>;
        const mcpServers = settings.mcpServers;
        if (!mcpServers || typeof mcpServers !== 'object') return {};
        return mcpServers as Record<string, McpServerConfig>;
      } catch {
        return {};
      }
    };

    const result: Record<string, McpServerConfig> = {};

    if (enabledSources.includes('user')) {
      const userBaseDir = process.env.TEST_USER_SETTINGS_DIR || join(homedir(), '.claude');
      Object.assign(result, readRawMcpServers(join(userBaseDir, 'settings.json')));
      const userMcpDir = process.env.TEST_USER_SETTINGS_DIR || homedir();
      Object.assign(result, readRawMcpServers(join(userMcpDir, '.mcp.json')));
    }

    if (enabledSources.includes('project') && this.workspacePath) {
      Object.assign(
        result,
        readRawMcpServers(join(this.workspacePath, '.claude', 'settings.json'))
      );
      Object.assign(result, readRawMcpServers(join(this.workspacePath, '.mcp.json')));
    }

    // NOTE: 'local' source (.claude/settings.local.json) is excluded — see doc comment above.

    return result;
  }
}
