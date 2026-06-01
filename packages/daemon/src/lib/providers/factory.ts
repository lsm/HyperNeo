/**
 * Provider Factory - Initialization and registration of built-in providers
 *
 * This module handles:
 * - Creating instances of built-in providers
 * - Registering them with the global registry
 * - Providing a single initialization point for the provider system
 */

import { AnthropicProvider } from './anthropic-provider.js';
import { GlmProvider } from './glm-provider.js';
import { KimiProvider } from './kimi-provider.js';
import { MinimaxProvider } from './minimax-provider.js';
import { OpenRouterProvider } from './openrouter-provider.js';
import { OllamaProvider } from './ollama-provider.js';
import { AnthropicToCodexBridgeProvider } from './anthropic-to-codex-bridge-provider.js';
import {
  CustomEndpointProvider,
  customProviderIdFor,
  isCustomEndpointProviderId,
} from './custom-endpoint-provider.js';
import type { CustomEndpointConfig } from '@neokai/shared';
import type { Provider } from '@neokai/shared/provider';
import { getProviderRegistry, type ProviderRegistry } from './registry.js';
export { getProviderRegistry };
import { ProviderContextManager } from './context-manager.js';
import { Logger } from '../logger.js';

const logger = new Logger('providers:factory');

/**
 * Initialization state
 */
let initialized = false;

/**
 * Initialize the provider system
 *
 * Registers all built-in providers with the global registry.
 * This should be called once at application startup.
 *
 * @returns The global provider registry
 */
export function initializeProviders(): ProviderRegistry {
  const registry = getProviderRegistry();

  // If already initialized and the core providers are still present, return the
  // existing registry. This handles the case where getProviderRegistry() was
  // called but no providers were registered, and the case where the registry was
  // reset without resetting the factory.
  if (initialized && hasCoreProviders(registry)) {
    return registry;
  }

  // Register Anthropic provider (always available)
  registerIfMissing(registry, new AnthropicProvider());

  // Register GLM provider (will be available if API key is set)
  registerIfMissing(registry, new GlmProvider());

  // Register Kimi provider (will be available if KIMI_API_KEY or MOONSHOT_API_KEY is set)
  registerIfMissing(registry, new KimiProvider());

  // Register MiniMax provider (will be available if MINIMAX_API_KEY is set)
  registerIfMissing(registry, new MinimaxProvider());

  // Register OpenRouter provider (will be available if OPENROUTER_API_KEY is set)
  registerIfMissing(registry, new OpenRouterProvider());

  // Register Ollama providers. Local Ollama is available by default at localhost:11434;
  // Ollama Cloud requires OLLAMA_CLOUD_API_KEY.
  registerIfMissing(registry, new OllamaProvider({ kind: 'local' }));
  registerIfMissing(registry, new OllamaProvider({ kind: 'cloud' }));

  // Register Anthropic-to-Codex bridge provider for OpenAI/Codex-backed models.
  // Discovers credentials from env (OPENAI_API_KEY), ~/.neokai/auth.json,
  // and one-time import from ~/.codex/auth.json.
  registerIfMissing(registry, new AnthropicToCodexBridgeProvider());

  // Register Anthropic Copilot provider (embedded Anthropic-compatible server).
  // process.cwd() is the fallback cwd; per-session workspace is threaded via
  // ANTHROPIC_AUTH_TOKEN (encoded by buildSdkConfig) and parsed per-request in server.ts.
  // Lazy registration keeps @github/copilot-sdk out of the startup import graph so
  // bun build --compile can tree-shake and bundle the SDK without crashing startup.
  registerCopilotProvider(registry);

  // Additional built-in providers can be registered here
  // Example:
  // registerIfMissing(registry, new DeepSeekProvider());

  initialized = true;

  return registry;
}

/**
 * Register a single built-in provider by ID if it is not already in the registry.
 *
 * Use this when a built-in provider was unregistered (e.g., user deleted it)
 * and needs to be restored without re-creating every other built-in provider.
 *
 * Copilot is async because its module is loaded lazily.
 */
export async function registerBuiltInProvider(
  registry: ProviderRegistry,
  providerId: string
): Promise<void> {
  if (registry.has(providerId)) return;
  switch (providerId) {
    case 'anthropic':
      registry.register(new AnthropicProvider());
      break;
    case 'glm':
      registry.register(new GlmProvider());
      break;
    case 'kimi':
      registry.register(new KimiProvider());
      break;
    case 'minimax':
      registry.register(new MinimaxProvider());
      break;
    case 'openrouter':
      registry.register(new OpenRouterProvider());
      break;
    case 'ollama':
      registry.register(new OllamaProvider({ kind: 'local' }));
      break;
    case 'ollama-cloud':
      registry.register(new OllamaProvider({ kind: 'cloud' }));
      break;
    case 'anthropic-codex':
      registry.register(new AnthropicToCodexBridgeProvider());
      break;
    case 'anthropic-copilot':
      await waitForOptionalProviderRegistration(registry);
      break;
    default:
      logger.warn(`Unknown built-in provider ID: ${providerId}`);
  }
}

/**
 * Synchronise registered custom-endpoint providers with the given config list.
 *
 * Re-entrant: safe to call after `initializeProviders()` whenever the user
 * adds/removes/updates a custom endpoint via the RPC handlers. Existing
 * `CustomEndpointProvider` instances whose config is no longer present are
 * shut down and unregistered.
 *
 * Providers whose **effective config is unchanged** are left in place. Only
 * removed or modified endpoints trigger a tear-down. This matters because
 * `CustomEndpointProvider.shutdown()` stops embedded bridge servers with
 * forced-close semantics, which would otherwise drop in-flight streams for
 * unrelated endpoints whenever any one endpoint is edited.
 */
export async function syncCustomEndpointProviders(
  configs: CustomEndpointConfig[] | undefined
): Promise<void> {
  const registry = initializeProviders();
  const wanted = new Map<string, CustomEndpointConfig>();
  for (const config of configs ?? []) {
    if (!config?.id || !config.baseUrl || !config.models?.length) continue;
    wanted.set(customProviderIdFor(config.id), config);
  }

  const toRemove: string[] = [];
  for (const provider of registry.getAll()) {
    if (!isCustomEndpointProviderId(provider.id)) continue;
    if (!wanted.has(provider.id)) toRemove.push(provider.id);
  }
  for (const id of toRemove) {
    const provider = registry.get(id);
    if (provider?.shutdown) {
      try {
        await provider.shutdown();
      } catch (err) {
        logger.warn(`Failed to shut down custom endpoint provider ${id}: ${err}`);
      }
    }
    registry.unregister(id);
    lastSyncedConfigByProviderId.delete(id);
  }

  for (const [providerId, config] of wanted) {
    const existing = registry.get(providerId);
    const fingerprint = fingerprintCustomEndpointConfig(config);
    if (existing && lastSyncedConfigByProviderId.get(providerId) === fingerprint) {
      // Unchanged — leave the live provider (and its bridges) alone.
      continue;
    }
    if (existing) {
      if (existing.shutdown) {
        try {
          await existing.shutdown();
        } catch (err) {
          logger.warn(`Failed to shut down custom endpoint provider ${providerId}: ${err}`);
        }
      }
      registry.unregister(providerId);
    }
    try {
      registerIfMissing(registry, new CustomEndpointProvider(config));
      lastSyncedConfigByProviderId.set(providerId, fingerprint);
    } catch (err) {
      logger.warn(`Skipping invalid custom endpoint '${config.id}': ${err}`);
      lastSyncedConfigByProviderId.delete(providerId);
    }
  }
}

/**
 * Stable, deterministic fingerprint of a custom endpoint config for change
 * detection. Recursively sorts object keys at every depth so nested fields
 * (e.g. `models[].capabilities`, `models[].providerModelId`, `headers.*`)
 * are included in the fingerprint. Naively passing a sorted key list to
 * `JSON.stringify` only whitelists top-level keys and silently drops nested
 * ones, which would treat semantically different configs as identical.
 */
function fingerprintCustomEndpointConfig(config: CustomEndpointConfig): string {
  return JSON.stringify(canonicalise(config));
}

function canonicalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = canonicalise(obj[key]);
  }
  return out;
}

function hasCoreProviders(registry: ProviderRegistry): boolean {
  return CORE_PROVIDER_IDS.every((id) => registry.has(id));
}

function registerIfMissing(registry: ProviderRegistry, provider: Provider): void {
  if (!registry.has(provider.id)) {
    registry.register(provider);
  }
}

function registerCopilotProvider(registry: ProviderRegistry): void {
  copilotProviderModule ??= import('./anthropic-copilot/index.js').catch((err) => {
    logger.warn(`Skipping Anthropic Copilot provider registration: ${err}`);
    return null;
  });
  void registerLoadedCopilotProvider(registry);
}

export async function waitForOptionalProviderRegistration(
  registry?: ProviderRegistry
): Promise<void> {
  await registerLoadedCopilotProvider(registry ?? initializeProviders());
}

async function registerLoadedCopilotProvider(registry: ProviderRegistry): Promise<void> {
  if (registry.has('anthropic-copilot')) return;

  // This dynamic import must remain a literal string: bun build --compile
  // discovers and embeds @github/copilot-sdk and vscode-jsonrpc through it.
  const providerModule = await copilotProviderModule;
  if (providerModule && !registry.has('anthropic-copilot')) {
    registerIfMissing(registry, new providerModule.AnthropicToCopilotBridgeProvider(process.cwd()));
  }
}

let copilotProviderModule: Promise<typeof import('./anthropic-copilot/index.js') | null> | null =
  null;

const CORE_PROVIDER_IDS = [
  'anthropic',
  'glm',
  'kimi',
  'minimax',
  'openrouter',
  'ollama',
  'ollama-cloud',
  'anthropic-codex',
];

/** Tracks the last fingerprint we synced per provider so we can skip no-op rebuilds. */
const lastSyncedConfigByProviderId = new Map<string, string>();

/**
 * Get the provider context manager
 *
 * Creates a context manager instance backed by the global provider registry.
 *
 * @returns ProviderContextManager instance
 */
export function getProviderContextManager(): ProviderContextManager {
  const registry = initializeProviders();
  if (!registry.has('anthropic-copilot')) {
    logger.warn('Anthropic Copilot provider registration is still pending.');
  }
  return new ProviderContextManager(registry);
}

/**
 * Reset the provider factory initialization state
 *
 * MUST be called alongside resetProviderRegistry() to fully reset
 * the provider system. This is typically only needed in tests.
 *
 * @public Exported for testing purposes
 */
export function resetProviderFactory(): void {
  initialized = false;
  copilotProviderModule = null;
  lastSyncedConfigByProviderId.clear();
}

// Re-export types from shared package
export type {
  Provider,
  ProviderCapabilities,
  ProviderContext,
  ProviderId,
  ProviderInfo,
  ProviderSdkConfig,
  ProviderSessionConfig,
  ModelTier,
} from '@neokai/shared/provider';
