import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import { getDataDir } from './data-dir.ts';
import type { Database } from '../storage/database.ts';
import type { ProviderCredentialManager } from './credentials/provider-credential-manager.ts';
import type { GlobalSettings } from '@hyperneo/shared';
import { customProviderIdFor } from './providers/custom-endpoint-provider.js';

export interface DiscoveryResult {
  credentialSource: 'env' | 'credentials-file' | 'keychain' | 'settings-json' | 'none';
  settingsEnvApplied: number;
  errors: string[];
}

export interface DiscoveryOptions {
  keychainReader?: () => string;
  platformName?: string;
}

export function discoverCredentials(
  claudeDir?: string,
  options?: DiscoveryOptions
): DiscoveryResult {
  const errors: string[] = [];
  let credentialSource: DiscoveryResult['credentialSource'] = 'none';
  let settingsEnvApplied = 0;

  const claudeBase = claudeDir || join(homedir(), '.claude');

  try {
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
    const hasOAuthToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const hasAuthToken = !!process.env.ANTHROPIC_AUTH_TOKEN;

    if (hasApiKey && hasOAuthToken && hasAuthToken) {
      credentialSource = 'env';
    } else {
      if (!hasOAuthToken) {
        try {
          const credentialsPath = join(claudeBase, '.credentials.json');
          if (existsSync(credentialsPath)) {
            const credentialsContent = readFileSync(credentialsPath, 'utf8');
            const credentials = JSON.parse(credentialsContent);

            if (credentials?.claudeAiOauth?.accessToken) {
              process.env.CLAUDE_CODE_OAUTH_TOKEN = credentials.claudeAiOauth.accessToken;
              credentialSource = 'credentials-file';
            }
          }
        } catch (err) {
          errors.push(
            `Failed to read ~/.claude/.credentials.json: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      if (
        !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
        (options?.platformName ?? platform()) === 'darwin'
      ) {
        try {
          const keychainOutput = options?.keychainReader
            ? options.keychainReader()
            : execSync('security find-generic-password -s "Claude Code-credentials" -w', {
                timeout: 5000,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
              });

          const keychainData = JSON.parse(
            typeof keychainOutput === 'string' ? keychainOutput.trim() : keychainOutput
          );
          if (keychainData?.claudeAiOauth?.accessToken) {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = keychainData.claudeAiOauth.accessToken;
            credentialSource = 'keychain';
          }
        } catch {}
      }
    }

    try {
      const settingsPath = join(claudeBase, 'settings.json');
      if (existsSync(settingsPath)) {
        const settingsContent = readFileSync(settingsPath, 'utf8');
        const settings = JSON.parse(settingsContent);

        if (settings?.env && typeof settings.env === 'object') {
          for (const [key, value] of Object.entries(settings.env)) {
            if (!process.env[key]) {
              process.env[key] = String(value);
              settingsEnvApplied++;
            }
          }

          if (settingsEnvApplied > 0 && credentialSource === 'none') {
            credentialSource = 'settings-json';
          }
        }
      }
    } catch (err) {
      errors.push(
        `Failed to read ~/.claude/settings.json: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } catch (err) {
    errors.push(
      `Unexpected error during credential discovery: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return {
    credentialSource,
    settingsEnvApplied,
    errors,
  };
}

interface BuiltInProviderEnvMapping {
  providerId: string;
  displayName: string;
  envVar: string;
  altEnvVar?: string;
  authType: 'api_key' | 'oauth' | 'none';
}

const BUILT_IN_PROVIDER_ENV_MAP: BuiltInProviderEnvMapping[] = [
  {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    authType: 'api_key',
  },
  {
    providerId: 'glm',
    displayName: 'Z.ai',
    envVar: 'GLM_API_KEY',
    altEnvVar: 'ZHIPU_API_KEY',
    authType: 'api_key',
  },
  {
    providerId: 'kimi',
    displayName: 'Kimi',
    envVar: 'KIMI_API_KEY',
    altEnvVar: 'MOONSHOT_API_KEY',
    authType: 'api_key',
  },
  { providerId: 'minimax', displayName: 'MiniMax', envVar: 'MINIMAX_API_KEY', authType: 'api_key' },
  {
    providerId: 'deepseek',
    displayName: 'DeepSeek',
    envVar: 'DEEPSEEK_API_KEY',
    authType: 'api_key',
  },
  {
    providerId: 'openrouter',
    displayName: 'OpenRouter',
    envVar: 'OPENROUTER_API_KEY',
    authType: 'api_key',
  },
  { providerId: 'ollama', displayName: 'Ollama', envVar: 'OLLAMA_API_KEY', authType: 'api_key' },
  {
    providerId: 'ollama-cloud',
    displayName: 'Ollama Cloud',
    envVar: 'OLLAMA_CLOUD_API_KEY',
    authType: 'api_key',
  },
  {
    providerId: 'anthropic-codex',
    displayName: 'OpenAI (Codex)',
    envVar: 'OPENAI_API_KEY',
    authType: 'api_key',
  },
];

function readHyperNeoAuthJson(): Record<string, unknown> {
  try {
    const path = join(getDataDir(), 'auth.json');
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function migrateProvidersIfNeeded(
  db: Database,
  credentialManager: ProviderCredentialManager
): Promise<void> {
  if (db.providers.countProviders() > 0) {
    return;
  }

  let sortOrder = 0;

  for (const mapping of BUILT_IN_PROVIDER_ENV_MAP) {
    const apiKey =
      process.env[mapping.envVar] ||
      (mapping.altEnvVar ? process.env[mapping.altEnvVar] : undefined);
    if (!apiKey) continue;

    const configJson =
      mapping.providerId === 'kimi' ? JSON.stringify({ region: 'china' }) : undefined;

    db.providers.createProvider({
      providerId: mapping.providerId,
      displayName: mapping.displayName,
      kind: 'built_in',
      authType: mapping.authType,
      isEnabled: true,
      isDefault: mapping.providerId === 'anthropic',
      sortOrder: sortOrder++,
      configJson,
    });

    try {
      await credentialManager.storeApiKey(mapping.providerId, apiKey);
    } catch {}
  }

  const hyperneoAuth = readHyperNeoAuthJson();
  if (hyperneoAuth['openai']) {
    const openaiCreds = hyperneoAuth['openai'] as {
      access?: string;
      refresh?: string;
      expires?: number;
    };
    if (openaiCreds.access) {
      const existing = db.providers.getProviderByProviderId('anthropic-codex');
      if (!existing) {
        db.providers.createProvider({
          providerId: 'anthropic-codex',
          displayName: 'OpenAI (Codex)',
          kind: 'built_in',
          authType: 'oauth',
          isEnabled: true,
          isDefault: false,
          sortOrder: sortOrder++,
        });
      }
      try {
        await credentialManager.storeOAuthTokens('anthropic-codex', {
          accessToken: openaiCreds.access,
          refreshToken: openaiCreds.refresh,
          expiresAt: openaiCreds.expires,
        });
      } catch {}
    }
  }

  if (hyperneoAuth['copilot']) {
    const copilotCreds = hyperneoAuth['copilot'] as { refresh?: string };
    if (copilotCreds.refresh) {
      const existing = db.providers.getProviderByProviderId('anthropic-copilot');
      if (!existing) {
        db.providers.createProvider({
          providerId: 'anthropic-copilot',
          displayName: 'GitHub Copilot',
          kind: 'built_in',
          authType: 'oauth',
          isEnabled: true,
          isDefault: false,
          sortOrder: sortOrder++,
        });
      }
      try {
        await credentialManager.storeOAuthTokens('anthropic-copilot', {
          accessToken: copilotCreds.refresh,
        });
      } catch {}
    }
  }

  const globalSettings: GlobalSettings = db.getGlobalSettings();
  if (globalSettings.customEndpoints) {
    for (const endpoint of globalSettings.customEndpoints) {
      db.providers.createProvider({
        providerId: customProviderIdFor(endpoint.id),
        displayName: endpoint.name,
        kind: 'custom_endpoint',
        authType: 'none',
        isEnabled: true,
        isDefault: false,
        sortOrder: sortOrder++,
        baseUrl: endpoint.baseUrl,
        customEndpointConfigJson: JSON.stringify(endpoint),
      });
    }
  }
}

export async function backfillDeepSeekProvider(
  db: Database,
  credentialManager: Pick<ProviderCredentialManager, 'getCredentials' | 'storeApiKey'>
): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return;

  if (!db.providers.getProviderByProviderId('deepseek')) {
    db.providers.createProvider({
      providerId: 'deepseek',
      displayName: 'DeepSeek',
      kind: 'built_in',
      authType: 'api_key',
      isEnabled: true,
      isDefault: false,
      sortOrder: db.providers.countProviders(),
    });
  }

  try {
    const existingCredentials = await credentialManager.getCredentials('deepseek');
    if (!existingCredentials) {
      await credentialManager.storeApiKey('deepseek', apiKey);
    }
  } catch {}
}

const STALE_GLM_DISPLAY_NAMES = new Set(['GLM', 'GLM (智谱AI)']);

export function refreshGlmDisplayName(db: Database): void {
  const rec = db.providers.getProviderByProviderId('glm');
  if (rec && STALE_GLM_DISPLAY_NAMES.has(rec.displayName)) {
    db.providers.updateProvider(rec.id, { displayName: 'Z.ai' });
  }
}
