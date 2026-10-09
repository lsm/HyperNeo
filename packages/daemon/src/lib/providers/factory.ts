import { AnthropicProvider } from './anthropic-provider.js';
import { GlmProvider } from './glm-provider.js';
import { KimiProvider } from './kimi-provider.js';
import { MinimaxProvider } from './minimax-provider.js';
import { DeepSeekProvider } from './deepseek-provider.js';
import { OpenRouterProvider } from './openrouter-provider.js';
import { OpencodeProvider } from './opencode-provider.js';
import { OllamaProvider } from './ollama-provider.js';
import { AnthropicToCodexBridgeProvider } from './anthropic-to-codex-bridge-provider.js';
import { AcpProvider } from './acp-provider.js';
import {
  CustomEndpointProvider,
  customProviderIdFor,
  isCustomEndpointProviderId,
} from './custom-endpoint-provider.js';
import type { CustomEndpointConfig, ProviderRecord } from '@hyperneo/shared';
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

const COPILOT_PROVIDER_ID = 'anthropic-copilot';

const BUILT_IN_PROVIDER_FACTORIES: Record<string, () => Provider> = {
  anthropic: () => new AnthropicProvider(),
  glm: () => new GlmProvider(),
  kimi: () => new KimiProvider(),
  minimax: () => new MinimaxProvider(),
  deepseek: () => new DeepSeekProvider(),
  openrouter: () => new OpenRouterProvider(),
  opencode: () => new OpencodeProvider(),
  ollama: () => new OllamaProvider({ kind: 'local' }),
  'ollama-cloud': () => new OllamaProvider({ kind: 'cloud' }),
  'anthropic-codex': () => new AnthropicToCodexBridgeProvider(),
  acp: () => new AcpProvider(),
};

const BUILT_IN_PROVIDER_IDS = [...Object.keys(BUILT_IN_PROVIDER_FACTORIES), COPILOT_PROVIDER_ID];

export function disableBuiltInProvidersWithoutEnabledRecord(records: ProviderRecord[]): void {
  const enabledIds = new Set(
    records
      .filter((record) => record.kind === 'built_in' && record.isEnabled !== false)
      .map((record) => record.providerId)
  );
  for (const providerId of BUILT_IN_PROVIDER_IDS) {
    if (!enabledIds.has(providerId)) markBuiltInProviderDisabled(providerId);
  }
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

  for (const [providerId, create] of Object.entries(BUILT_IN_PROVIDER_FACTORIES)) {
    if (!disabledBuiltInProviderIds.has(providerId)) registerIfMissing(registry, create());
  }

  if (!disabledBuiltInProviderIds.has(COPILOT_PROVIDER_ID)) {
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
  if (providerId === COPILOT_PROVIDER_ID) {
    markBuiltInProviderEnabled(providerId);
    await waitForOptionalProviderRegistration(registry, true);
    return;
  }
  const create = BUILT_IN_PROVIDER_FACTORIES[providerId];
  if (create) registry.register(create());
  else logger.warn(`Unknown built-in provider ID: ${providerId}`);
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
      const provider = new CustomEndpointProvider(config);
      if (!registry.has(provider.id)) {
        registry.register(provider);
        provider.prewarmBridges();
      }
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
  if (providerId === COPILOT_PROVIDER_ID) {
    registerCopilotProvider(registry, true);
    await waitForOptionalProviderRegistration(registry);
    return;
  }
  const create = BUILT_IN_PROVIDER_FACTORIES[providerId];
  if (create) registerIfMissing(registry, create());
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

const defaultCopilotModuleImporter = async (): Promise<CopilotProviderModule> => {
  return import('./anthropic-copilot/index.js');
};

let importCopilotProviderModule = defaultCopilotModuleImporter;

let copilotProviderModule: Promise<CopilotProviderModule | null> | null = null;

let copilotImportRetryNotBefore = 0;

function loadCopilotProviderModule(force: boolean): Promise<CopilotProviderModule | null> {
  if (!copilotProviderModule) {
    if (!force && Date.now() < copilotImportRetryNotBefore) {
      return Promise.resolve(null);
    }
    copilotProviderModule = importCopilotProviderModule().catch((err) => {
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
  importer: () => Promise<CopilotProviderModule>
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
