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
import { bumpProviderCatalogEpoch } from './catalog-epoch.js';
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
    registerCopilotProvider(registry, false);
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
      await waitForOptionalProviderRegistration(registry, true);
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
    bumpProviderCatalogEpoch(id);
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
      bumpProviderCatalogEpoch(providerId);
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

function registerCopilotProvider(registry: ProviderRegistry, force: boolean): void {
  void registerLoadedCopilotProvider(registry, force);
}

export async function waitForOptionalProviderRegistration(
  registry?: ProviderRegistry,
  force = false
): Promise<void> {
  await registerLoadedCopilotProvider(registry ?? initializeProviders(), force);
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
      registerCopilotProvider(registry, true);
      await waitForOptionalProviderRegistration(registry);
      break;
    case 'acp':
      registerIfMissing(registry, new AcpProvider());
      break;
    default:
      break;
  }
}

async function registerLoadedCopilotProvider(
  registry: ProviderRegistry,
  force = false
): Promise<void> {
  if (registry.has('anthropic-copilot')) return;
  if (disabledBuiltInProviderIds.has('anthropic-copilot')) return;

  const providerModule = await loadCopilotProviderModule(force);
  if (
    providerModule &&
    !registry.has('anthropic-copilot') &&
    !disabledBuiltInProviderIds.has('anthropic-copilot')
  ) {
    registerIfMissing(registry, new providerModule.AnthropicToCopilotBridgeProvider(process.cwd()));
  }
}

type CopilotProviderModule = typeof import('./anthropic-copilot/index.js');

const COPILOT_IMPORT_RETRY_BACKOFF_MS = 60_000;

const defaultCopilotModuleImporter = async (attempt: number): Promise<CopilotProviderModule> => {
  if (attempt === 0) {
    return import('./anthropic-copilot/index.js');
  }
  try {
    return (await import(`./anthropic-copilot/index.js?retry=${attempt}`)) as CopilotProviderModule;
  } catch {
    return import('./anthropic-copilot/index.js');
  }
};

let importCopilotProviderModule = defaultCopilotModuleImporter;

let copilotProviderModule: Promise<CopilotProviderModule | null> | null = null;

let copilotImportAttempts = 0;

let copilotImportRetryNotBefore = 0;

function loadCopilotProviderModule(force: boolean): Promise<CopilotProviderModule | null> {
  if (!copilotProviderModule) {
    if (!force && Date.now() < copilotImportRetryNotBefore) {
      return Promise.resolve(null);
    }
    const attempt = copilotImportAttempts;
    copilotImportAttempts += 1;
    copilotProviderModule = importCopilotProviderModule(attempt).catch((err) => {
      logger.warn(`Anthropic Copilot provider import failed; retry on next registration: ${err}`);
      copilotProviderModule = null;
      copilotImportRetryNotBefore = Date.now() + COPILOT_IMPORT_RETRY_BACKOFF_MS;
      return null;
    });
  }
  return copilotProviderModule;
}

/** @public */
export function setCopilotProviderModuleImporter(
  importer: (attempt: number) => Promise<CopilotProviderModule>
): void {
  importCopilotProviderModule = importer;
}

const lastSyncedConfigByProviderId = new Map<string, string>();

export function getProviderContextManager(): ProviderContextManager {
  const registry = initializeProviders();
  if (!registry.has('anthropic-copilot')) {
    logger.warn('Anthropic Copilot provider registration is still pending.');
  }
  return new ProviderContextManager(registry);
}

/** @public */
export function resetProviderFactory(): void {
  initialized = false;
  copilotProviderModule = null;
  importCopilotProviderModule = defaultCopilotModuleImporter;
  copilotImportAttempts = 0;
  copilotImportRetryNotBefore = 0;
  lastSyncedConfigByProviderId.clear();
  disabledBuiltInProviderIds.clear();
}

export type {
  ModelTier,
  Provider,
  ProviderCapabilities,
  ProviderContext,
  ProviderId,
  ProviderInfo,
  ProviderSdkConfig,
  ProviderSessionConfig,
} from '@hyperneo/shared/provider';
