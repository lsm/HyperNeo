import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import { getDataDir } from './data-dir';
import type { Database } from '../storage/database';
import type { ProviderCredentialManager } from './credentials/provider-credential-manager';
import type { GlobalSettings } from '@hyperneo/shared';
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

    // Kimi supports two regions (china / global). Existing credentials without
    // an explicit region default to 'china' so legacy users keep hitting the
    // api.kimi.com endpoint they always have.
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
    } catch {
      // Non-fatal: the provider record exists; credentials can be re-entered.
    }
  }

  // 2. OAuth tokens from ~/.hyperneo/auth.json
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
      } catch {
        // Non-fatal: the provider record exists; credentials can be re-entered.
      }
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
      } catch {
        // Non-fatal: the provider record exists; credentials can be re-entered.
      }
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

/**
 * Seed DeepSeek on upgraded databases that predate the built-in provider.
 * The general migration intentionally runs only for an empty providers table,
 * so new built-ins need an idempotent startup backfill of their own.
 */
export async function backfillDeepSeekProvider(
  db: Database,
  credentialManager: Pick<ProviderCredentialManager, 'storeApiKey'>
): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || db.providers.getProviderByProviderId('deepseek')) return;

  db.providers.createProvider({
    providerId: 'deepseek',
    displayName: 'DeepSeek',
    kind: 'built_in',
    authType: 'api_key',
    isEnabled: true,
    isDefault: false,
    sortOrder: db.providers.countProviders(),
  });

  try {
    await credentialManager.storeApiKey('deepseek', apiKey);
  } catch {
    // Non-fatal: the provider row is visible and the key can be re-entered.
  }
}

/**
 * Prior default display names persisted for the `glm` provider before it was
 * relabelled to "Z.ai". Used by {@link refreshGlmDisplayName} to recognise rows
 * that still carry a stale built-in label (and only those — any user custom
 * rename is left untouched).
 */
const STALE_GLM_DISPLAY_NAMES = new Set(['GLM', 'GLM (智谱AI)']);

/**
 * Refresh the persisted GLM provider display name to the current "Z.ai" label.
 *
 * `migrateProvidersIfNeeded` seeds `display_name` only on an empty table, so an
 * existing install that already has a `glm` row keeps whatever label it was
 * first seeded with (historically "GLM (智谱AI)"). The Providers settings panel
 * renders that persisted value, so without this refresh those users would keep
 * seeing "GLM" in Settings while the model picker shows "Z.ai".
 *
 * Runs every startup — independent of the seeding early-return — so it also
 * heals rows created by older builds. Idempotent and display-name-only: it
 * rewrites only rows whose `display_name` is a known prior default, preserving
 * any user custom rename, and touches nothing but `display_name` (not
 * provider_id, model ids, routing, credentials, or settings.json).
 */
export function refreshGlmDisplayName(db: Database): void {
  const rec = db.providers.getProviderByProviderId('glm');
  if (rec && STALE_GLM_DISPLAY_NAMES.has(rec.displayName)) {
    db.providers.updateProvider(rec.id, { displayName: 'Z.ai' });
  }
}
