import type { Database } from '../../storage/database.ts';
import type {
  AppMcpServer,
  McpServerConfig,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
  ValidationResult,
} from '@hyperneo/shared';
import {
  resolveMcpServers,
  scopeChainForSession,
  type ResolveMcpServersSession,
} from './resolve-mcp-servers.ts';

export type { ValidationResult } from '@hyperneo/shared';

export interface McpStartupError {
  serverId: string;
  name: string;
  error: string;
}

export class AppMcpLifecycleManager {
  constructor(private readonly db: Database) {}

  getEnabledMcpConfigs(): Record<string, McpServerConfig> {
    const entries = this.db.appMcpServers.listEnabled();
    const result: Record<string, McpServerConfig> = {};

    for (const entry of entries) {
      const validation = this.validateEntry(entry);
      if (!validation.valid) {
        continue;
      }

      result[entry.name] = this.convertEntry(entry);
    }

    return result;
  }

  getEnabledMcpConfigsForSession(
    session: ResolveMcpServersSession
  ): Record<string, McpServerConfig> {
    const registry = this.db.appMcpServers.list();
    const chain = scopeChainForSession(session);
    const overrides = this.db.mcpEnablement.listForScopes(chain);
    const effective = resolveMcpServers(session, registry, overrides);

    const result: Record<string, McpServerConfig> = {};
    for (const entry of effective) {
      const validation = this.validateEntry(entry);
      if (!validation.valid) continue;
      result[entry.name] = this.convertEntry(entry);
    }
    return result;
  }

  validateEntry(entry: AppMcpServer): ValidationResult {
    switch (entry.sourceType) {
      case 'stdio':
        if (!entry.command || entry.command.trim() === '') {
          return {
            valid: false,
            error: `stdio server "${entry.name}" is missing required field: command`,
          };
        }
        return { valid: true };

      case 'sse':
        if (!entry.url || entry.url.trim() === '') {
          return {
            valid: false,
            error: `sse server "${entry.name}" is missing required field: url`,
          };
        }
        return { valid: true };

      case 'http':
        if (!entry.url || entry.url.trim() === '') {
          return {
            valid: false,
            error: `http server "${entry.name}" is missing required field: url`,
          };
        }
        return { valid: true };

      default: {
        const exhaustive: never = entry.sourceType;
        return {
          valid: false,
          error: `server "${entry.name}" has unknown sourceType: ${exhaustive}`,
        };
      }
    }
  }

  getStartupErrors(): McpStartupError[] {
    const allEntries = this.db.appMcpServers.list();
    const errors: McpStartupError[] = [];

    for (const entry of allEntries) {
      const validation = this.validateEntry(entry);
      if (!validation.valid) {
        errors.push({
          serverId: entry.id,
          name: entry.name,
          error: validation.error ?? 'Unknown validation error',
        });
      }
    }

    return errors;
  }

  private convertEntry(entry: AppMcpServer): McpServerConfig {
    switch (entry.sourceType) {
      case 'stdio': {
        const config: McpStdioServerConfig = {
          type: 'stdio',
          command: entry.command!,
          ...(entry.args && entry.args.length > 0 ? { args: entry.args } : {}),
          ...(entry.env && Object.keys(entry.env).length > 0 ? { env: entry.env } : {}),
        };
        return config;
      }

      case 'sse': {
        const config: McpSSEServerConfig = {
          type: 'sse',
          url: entry.url!,
          ...(entry.headers && Object.keys(entry.headers).length > 0
            ? { headers: entry.headers }
            : {}),
        };
        return config;
      }

      case 'http': {
        const config: McpHttpServerConfig = {
          type: 'http',
          url: entry.url!,
          ...(entry.headers && Object.keys(entry.headers).length > 0
            ? { headers: entry.headers }
            : {}),
        };
        return config;
      }

      default: {
        const exhaustive: never = entry.sourceType;
        throw new Error(`convertEntry: unhandled sourceType "${exhaustive}"`);
      }
    }
  }
}
