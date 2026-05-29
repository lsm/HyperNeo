import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import type { Database } from '../storage/database';
import type { ProviderCredentialManager } from './credentials/provider-credential-manager';
import type { GlobalSettings } from '@neokai/shared';
import { customProviderIdFor } from './providers/custom-endpoint-provider.js';

export interface DiscoveryResult {
  credentialSource: 'env' | 'credentials-file' | 'keychain' | 'settings-json' | 'none';
  settingsEnvApplied: number; // count of env vars injected from settings.json
  errors: string[]; // non-fatal issues encountered
}

export interface DiscoveryOptions {
  keychainReader?: () => string; // Returns raw JSON string from keychain, throws on failure
  platformName?: string; // Override platform detection (for testing)
}

/**
 * Discover Claude Code credentials and inject them into process.env.
 * Runs once at daemon startup to enrich the environment before any other code reads it.
 * Never overwrites existing env vars - explicit config always wins.
 */
export function discoverCredentials(
  claudeDir?: string,
  options?: DiscoveryOptions
): DiscoveryResult {
  const errors: string[] = [];
  let credentialSource: DiscoveryResult['credentialSource'] = 'none';
  let settingsEnvApplied = 0;

  const claudeBase = claudeDir || join(homedir(), '.claude');

  try {
    // Step 1: Check if credentials already exist in process.env
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
    const hasOAuthToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const hasAuthToken = !!process.env.ANTHROPIC_AUTH_TOKEN;

    if (hasApiKey && hasOAuthToken && hasAuthToken) {
      // All credentials already present, skip discovery
      credentialSource = 'env';
    } else {
      // Step 2: Try reading ~/.claude/.credentials.json
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

      // Step 3: If still no OAuth token AND on macOS, try keychain
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
                stdio: ['ignore', 'pipe', 'ignore'], // suppress stderr
              });

          const keychainData = JSON.parse(
            typeof keychainOutput === 'string' ? keychainOutput.trim() : keychainOutput
          );
          if (keychainData?.claudeAiOauth?.accessToken) {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = keychainData.claudeAiOauth.accessToken;
            credentialSource = 'keychain';
          }
        } catch {
          // Keychain access denied or command failed - silently continue
          // This is expected if the user hasn't granted keychain access
        }
      }
    }

    // Step 4: ALWAYS read ~/.claude/settings.json and apply env vars
    try {
      const settingsPath = join(claudeBase, 'settings.json');
      if (existsSync(settingsPath)) {
        const settingsContent = readFileSync(settingsPath, 'utf8');
        const settings = JSON.parse(settingsContent);

        if (settings?.env && typeof settings.env === 'object') {
          for (const [key, value] of Object.entries(settings.env)) {
            // Only set if not already present
            if (!process.env[key]) {
              process.env[key] = String(value);
              settingsEnvApplied++;
            }
          }

          // If we discovered credentials from settings.json and no other source was found
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
    // Catch-all for unexpected errors
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

// ---------------------------------------------------------------------------
// Provider migration — one-time import from env vars / auth files / settings
// ---------------------------------------------------------------------------

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
    displayName: 'GLM',
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

function readNeokaiAuthJson(): Record<string, unknown> {
  try {
    const path = join(homedir(), '.neokai', 'auth.json');
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * One-time migration of provider configuration into the providers table.
 * Idempotent: skips if the table already has rows.
 */
export async function migrateProvidersIfNeeded(
  db: Database,
  credentialManager: ProviderCredentialManager
): Promise<void> {
  if (db.providers.countProviders() > 0) {
    return; // Already migrated.
  }

  let sortOrder = 0;

  // 1. Env var providers.
  for (const mapping of BUILT_IN_PROVIDER_ENV_MAP) {
    const apiKey =
      process.env[mapping.envVar] ||
      (mapping.altEnvVar ? process.env[mapping.altEnvVar] : undefined);
    if (!apiKey) continue;

    db.providers.createProvider({
      providerId: mapping.providerId,
      displayName: mapping.displayName,
      kind: 'built_in',
      authType: mapping.authType,
      isEnabled: true,
      isDefault: mapping.providerId === 'anthropic',
      sortOrder: sortOrder++,
    });

    try {
      await credentialManager.storeApiKey(mapping.providerId, apiKey);
    } catch {
      // Non-fatal: the provider record exists; credentials can be re-entered.
    }
  }

  // 2. OAuth tokens from ~/.neokai/auth.json
  const neokaiAuth = readNeokaiAuthJson();
  if (neokaiAuth['openai']) {
    const openaiCreds = neokaiAuth['openai'] as {
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
      await credentialManager.storeOAuthTokens('anthropic-codex', {
        accessToken: openaiCreds.access,
        refreshToken: openaiCreds.refresh,
        expiresAt: openaiCreds.expires,
      });
    }
  }

  if (neokaiAuth['copilot']) {
    const copilotCreds = neokaiAuth['copilot'] as { refresh?: string };
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
      await credentialManager.storeOAuthTokens('anthropic-copilot', {
        accessToken: copilotCreds.refresh,
      });
    }
  }

  // 3. Custom endpoints from global_settings.
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
