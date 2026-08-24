import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { GlobalSettings, SettingSource } from '@hyperneo/shared';
import type { McpServerConfig } from '@hyperneo/shared/types/sdk-config';

export interface McpServerInfo {
  name: string;
  source: SettingSource;
  command?: string;
  args?: string[];
}
import type { Database } from '../storage/database.ts';
import { Logger } from './logger.ts';

export class SettingsManager {
  private logger = new Logger('SettingsManager');

  constructor(
    private db: Database,
    private workspacePath?: string
  ) {}

  getGlobalSettings(): GlobalSettings {
    return this.db.getGlobalSettings();
  }

  updateGlobalSettings(updates: Partial<GlobalSettings>): GlobalSettings {
    return this.db.updateGlobalSettings(updates);
  }

  saveGlobalSettings(settings: GlobalSettings): void {
    this.db.saveGlobalSettings(settings);
  }

  async prepareSDKOptions(): Promise<void> {
    await this.writeFileOnlySettings(this.getGlobalSettings());
  }

  private readUserAttribution(): { commit?: string; pr?: string } | undefined {
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

  private async writeFileOnlySettings(settings: GlobalSettings): Promise<void> {
    if (!this.workspacePath) {
      return;
    }

    const settingsLocalPath = join(this.workspacePath, '.claude/settings.local.json');

    let localSettings: Record<string, unknown> = {};
    try {
      if (existsSync(settingsLocalPath)) {
        const content = readFileSync(settingsLocalPath, 'utf-8');
        localSettings = JSON.parse(content) as Record<string, unknown>;
      }
    } catch {}

    if (settings.askPermissions !== undefined) {
      localSettings.permissions = {
        ...(localSettings.permissions as Record<string, unknown>),
        ask: settings.askPermissions,
      };
    }

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

    if (settings.outputStyle !== undefined) {
      localSettings.outputStyle = settings.outputStyle;
    }

    if (settings.attribution !== undefined) {
      localSettings.attribution = settings.attribution;
    } else if (localSettings.attribution === undefined) {
      const userAttribution = this.readUserAttribution();
      if (userAttribution !== undefined) {
        localSettings.attribution = userAttribution;
      }
    }

    mkdirSync(dirname(settingsLocalPath), { recursive: true });

    writeFileSync(settingsLocalPath, JSON.stringify(localSettings, null, 2));
  }

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

  listMcpServersFromSources(): Record<SettingSource, McpServerInfo[]> {
    const globalSettings = this.getGlobalSettings();
    const enabledSources = globalSettings.settingSources || ['user', 'project', 'local'];

    const result: Record<SettingSource, McpServerInfo[]> = {
      user: [],
      project: [],
      local: [],
    };

    const readMcpServers = (filePath: string, source: SettingSource): McpServerInfo[] => {
      try {
        if (!existsSync(filePath)) {
          return [];
        }
        const content = readFileSync(filePath, 'utf-8');
        const settings = JSON.parse(content) as Record<string, unknown>;

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

    if (enabledSources.includes('user')) {
      const userBaseDir = process.env.TEST_USER_SETTINGS_DIR || join(homedir(), '.claude');
      const userSettingsPath = join(userBaseDir, 'settings.json');
      result.user = readMcpServers(userSettingsPath, 'user');
      const userMcpDir = process.env.TEST_USER_SETTINGS_DIR || homedir();
      const userMcpPath = join(userMcpDir, '.mcp.json');
      result.user.push(...readMcpServers(userMcpPath, 'user'));
    }

    if (enabledSources.includes('project') && this.workspacePath) {
      const projectSettingsPath = join(this.workspacePath, '.claude', 'settings.json');
      result.project = readMcpServers(projectSettingsPath, 'project');
      const projectMcpPath = join(this.workspacePath, '.mcp.json');
      result.project.push(...readMcpServers(projectMcpPath, 'project'));
    }

    if (enabledSources.includes('local') && this.workspacePath) {
      const localSettingsPath = join(this.workspacePath, '.claude', 'settings.local.json');
      result.local = readMcpServers(localSettingsPath, 'local');
    }

    return result;
  }

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

    return result;
  }
}
