import { globalSettingsWrites } from '../storage/repositories/global-settings-writes.ts';
import { readFileSync, existsSync } from 'node:fs';
import { readFile, mkdir, realpath, readlink, stat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, dirname, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { GlobalSettings } from '@hyperneo/shared';
import type { McpServerConfig } from '@hyperneo/shared/types/sdk-config';

import type { Database } from '../storage/database.ts';
import { Logger } from './logger.ts';
import { runLagPhase } from './event-loop-activity.ts';

const settingsWrites = new Map<string, Promise<void>>();

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

  updateGlobalSettingsAsync(updates: Partial<GlobalSettings>): Promise<GlobalSettings> {
    return this.db.gateway.call(globalSettingsWrites, 'updateGlobalSettings', updates);
  }

  async saveGlobalSettingsAsync(settings: GlobalSettings): Promise<void> {
    await this.db.gateway.call(globalSettingsWrites, 'saveGlobalSettings', settings);
  }

  async prepareSDKOptions(): Promise<void> {
    await runLagPhase('sdk:settings_prepare', async () => {
      if (!this.workspacePath) return;
      const directory = join(this.workspacePath, '.claude');
      await mkdir(directory, { recursive: true });
      const path = await this.resolveSettingsTarget(join(directory, 'settings.local.json'));
      const write = (settingsWrites.get(path) ?? Promise.resolve())
        .catch(() => {})
        .then(() => this.writeFileOnlySettings(path, this.getGlobalSettings()));
      settingsWrites.set(path, write);
      try {
        await write;
      } finally {
        if (settingsWrites.get(path) === write) settingsWrites.delete(path);
      }
    });
  }

  private async resolveSettingsTarget(candidate: string): Promise<string> {
    const directory = await realpath(dirname(candidate));
    const path = join(directory, basename(candidate));
    try {
      return await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let target: string;
    try {
      target = await readlink(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EINVAL') return path;
      throw error;
    }
    return this.resolveSettingsTarget(resolve(directory, target));
  }

  private async readUserAttribution(): Promise<{ commit?: string; pr?: string } | undefined> {
    const baseDir = process.env.TEST_USER_SETTINGS_DIR || join(homedir(), '.claude');
    const userSettingsPath = join(baseDir, 'settings.json');

    try {
      const content = await readFile(userSettingsPath, 'utf-8');
      const userSettings = JSON.parse(content) as Record<string, unknown>;
      return userSettings.attribution as { commit?: string; pr?: string } | undefined;
    } catch {
      return undefined;
    }
  }

  private async readLocalSettings(path: string): Promise<Record<string, unknown>> {
    let content: string;
    try {
      content = await readFile(path, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      const message = `Invalid SDK settings JSON; left untouched: ${path}`;
      this.logger.error(message);
      throw new Error(message);
    }
  }

  private async writeFileOnlySettings(path: string, settings: GlobalSettings): Promise<void> {
    let localSettings = await this.readLocalSettings(path);
    let userAttribution: { commit?: string; pr?: string } | undefined;
    if (settings.attribution === undefined && localSettings.attribution === undefined) {
      userAttribution = await this.readUserAttribution();
      localSettings = await this.readLocalSettings(path);
    }

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
    } else if (localSettings.attribution === undefined && userAttribution !== undefined) {
      localSettings.attribution = userAttribution;
    }

    const existing = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    const temporary = join(dirname(path), `.settings-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', existing?.mode);
    try {
      await file.writeFile(JSON.stringify(localSettings, null, 2));
      if (existing) await file.chmod(existing.mode);
      await file.close();
      await rename(temporary, path);
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
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
