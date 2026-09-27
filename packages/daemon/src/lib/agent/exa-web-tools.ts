import type { McpServerConfig as SdkMcpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { GlobalSettings } from '@hyperneo/shared';
import type { Database as SqliteDatabase } from '../../storage/sqlite-compat.ts';
import { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';
import { Logger } from '../logger.ts';

const log = new Logger('ExaWebTools');

export interface ExaCredentialDatabase {
  getDatabase(): SqliteDatabase;
}

export const EXA_CREDENTIAL_PROVIDER_ID = 'exa';
export const EXA_MCP_SERVER_NAME = 'exa';
export const EXA_MCP_SERVER_URL = 'https://mcp.exa.ai/mcp';

export const BUILTIN_WEB_TOOL_NAMES = ['WebSearch', 'WebFetch'] as const;

export async function resolveExaApiKey(db?: ExaCredentialDatabase): Promise<string | null> {
  if (db) {
    try {
      const credentialManager = ProviderCredentialManager.create(db.getDatabase());
      const credentials = await credentialManager.getCredentials(EXA_CREDENTIAL_PROVIDER_ID);
      if (credentials?.type === 'api_key' && credentials.apiKey?.trim()) {
        return credentials.apiKey.trim();
      }
    } catch (error) {
      log.warn(
        `Failed to read stored Exa API key (falling back to EXA_API_KEY env): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  const envKey = process.env.EXA_API_KEY?.trim();
  return envKey ? envKey : null;
}

export interface ExaWebToolsActivation {
  serverName: string;
  serverConfig: SdkMcpServerConfig;
  disallowedTools: string[];
}

export async function resolveExaWebToolsActivation(options: {
  settings: GlobalSettings;
  db?: ExaCredentialDatabase;
  nativeWebTools: boolean;
}): Promise<ExaWebToolsActivation | undefined> {
  if (options.nativeWebTools) return undefined;
  if (options.settings.exa?.enabled !== true) return undefined;

  const apiKey = await resolveExaApiKey(options.db);
  if (!apiKey) return undefined;

  return {
    serverName: EXA_MCP_SERVER_NAME,
    serverConfig: {
      type: 'http',
      url: `${EXA_MCP_SERVER_URL}?exaApiKey=${encodeURIComponent(apiKey)}`,
    },
    disallowedTools: [...BUILTIN_WEB_TOOL_NAMES],
  };
}
