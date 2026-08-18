import { AnthropicProvider } from './anthropic-provider.js';
import { GlmProvider } from './glm-provider.js';
import { KimiProvider } from './kimi-provider.js';
import { MinimaxProvider } from './minimax-provider.js';
import { DeepSeekProvider } from './deepseek-provider.js';
import { OpenRouterProvider } from './openrouter-provider.js';
import { OllamaProvider } from './ollama-provider.js';
import { AnthropicToCodexBridgeProvider } from './anthropic-to-codex-bridge-provider.js';
import { AcpProvider } from './acp-provider.js';
import {
  CustomEndpointProvider,
  customProviderIdFor,
  isCustomEndpointProviderId,
} from './custom-endpoint-provider.js';
import type { CustomEndpointConfig } from '@hyperneo/shared';
import type { Provider } from '@hyperneo/shared/provider';
import { getProviderRegistry, type ProviderRegistry } from './registry.js';
export { getProviderRegistry };
import { ProviderContextManager } from './context-manager.js';
import { Logger } from '../logger.js';

const logger = new Logger('providers:factory');

let initialized = false;

const disabledBuiltInProviderIds = new Set<string>();

export function markBuiltInProviderDisabled(providerId: string): void {
  disabledBuiltInProviderIds.add(providerId);
}

export function markBuiltInProviderEnabled(providerId: string): void {
  disabledBuiltInProviderIds.delete(providerId);
}

const CORE_PROVIDER_IDS = ['anthropic'];

function hasCoreProviders(registry: ProviderRegistry): boolean {
  return CORE_PROVIDER_IDS.every((id) => registry.has(id));
}

export function initializeProviders(): ProviderRegistry {
  const registry = getProviderRegistry();

  if (initialized && hasCoreProviders(registry)) {
    return registry;
  }

  if (!disabledBuiltInProviderIds.has('anthropic')) {
    registerIfMissing(registry, new AnthropicProvider());
  }

  if (!disabledBuiltInProviderIds.has('glm')) {
    registerIfMissing(registry, new GlmProvider());
  }

  if (!disabledBuiltInProviderIds.has('kimi')) {
    registerIfMissing(registry, new KimiProvider());
  }

  if (!disabledBuiltInProviderIds.has('minimax')) {
    registerIfMissing(registry, new MinimaxProvider());
  }

  if (!disabledBuiltInProviderIds.has('deepseek')) {
    registerIfMissing(registry, new DeepSeekProvider());
  }

  if (!disabledBuiltInProviderIds.has('openrouter')) {
    registerIfMissing(registry, new OpenRouterProvider());
  }

  if (!disabledBuiltInProviderIds.has('ollama')) {
    registerIfMissing(registry, new OllamaProvider({ kind: 'local' }));
  }
  if (!disabledBuiltInProviderIds.has('ollama-cloud')) {
    registerIfMissing(registry, new OllamaProvider({ kind: 'cloud' }));
  }

  if (!disabledBuiltInProviderIds.has('anthropic-codex')) {
    registerIfMissing(registry, new AnthropicToCodexBridgeProvider());
  }

  if (!disabledBuiltInProviderIds.has('acp')) {
    registerIfMissing(registry, new AcpProvider());
  }

  if (!disabledBuiltInProviderIds.has('anthropic-copilot')) {
    registerCopilotProvider(registry);
  }

  initialized = true;

  return registry;
}

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
    case 'deepseek':
      registry.register(new DeepSeekProvider());
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
    case 'acp':
      registry.register(new AcpProvider());
      break;
    default:
      logger.warn(`Unknown built-in provider ID: ${providerId}`);
  }
}

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

export async function ensureBuiltInProviderRegistered(providerId: string): Promise<void> {
  const registry = getProviderRegistry();
  if (registry.has(providerId)) return;
  markBuiltInProviderEnabled(providerId);

  switch (providerId) {
    case 'anthropic':
      registerIfMissing(registry, new AnthropicProvider());
      break;
    case 'glm':
      registerIfMissing(registry, new GlmProvider());
      break;
    case 'kimi':
      registerIfMissing(registry, new KimiProvider());
      break;
    case 'minimax':
      registerIfMissing(registry, new MinimaxProvider());
      break;
    case 'openrouter':
      registerIfMissing(registry, new OpenRouterProvider());
      break;
    case 'ollama':
      registerIfMissing(registry, new OllamaProvider({ kind: 'local' }));
      break;
    case 'ollama-cloud':
      registerIfMissing(registry, new OllamaProvider({ kind: 'cloud' }));
      break;
    case 'anthropic-codex':
      registerIfMissing(registry, new AnthropicToCodexBridgeProvider());
      break;
    case 'anthropic-copilot':
      registerCopilotProvider(registry);
      await waitForOptionalProviderRegistration(registry);
      break;
    case 'acp':
      registerIfMissing(registry, new AcpProvider());
      break;
    default:
      break;
  }
}

async function registerLoadedCopilotProvider(registry: ProviderRegistry): Promise<void> {
  if (registry.has('anthropic-copilot')) return;
  if (disabledBuiltInProviderIds.has('anthropic-copilot')) return;

  const providerModule = await copilotProviderModule;
  if (providerModule && !registry.has('anthropic-copilot')) {
    registerIfMissing(registry, new providerModule.AnthropicToCopilotBridgeProvider(process.cwd()));
  }
}

let copilotProviderModule: Promise<typeof import('./anthropic-copilot/index.js') | null> | null =
  null;

const lastSyncedConfigByProviderId = new Map<string, string>();

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
  disabledBuiltInProviderIds.clear();
}

export type {
  Provider,
  ProviderCapabilities,
  ProviderContext,
  ProviderId,
  ProviderInfo,
  ProviderSdkConfig,
  ProviderSessionConfig,
  ModelTier,
} from '@hyperneo/shared/provider';
