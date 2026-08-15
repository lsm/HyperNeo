/**
 * Provider Registry - Dynamic provider registration and lookup
 *
 * The registry is the central point for managing providers at runtime.
 * Providers can be registered, unregistered, and queried dynamically.
 *
 * This enables:
 * - Adding new providers without modifying core code
 * - Plugin-style provider architecture
 */

import { createLogger } from '@hyperneo/shared/logger';
import type { Provider, ProviderId, ProviderInfo } from '@hyperneo/shared/provider';
import type { Provider as ProviderIdStr } from '@hyperneo/shared';

const log = createLogger('hyperneo:providers:registry');

/**
 * Provider Registry class
 *
 * Singleton pattern - use getProviderRegistry() to get the instance.
 */
export class ProviderRegistry {
  private providers = new Map<ProviderId, Provider>();

  /**
   * Register a provider
   * @throws if provider ID already exists
   */
  register(provider: Provider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider ${provider.id} is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  /**
   * Unregister a provider
   */
  unregister(providerId: ProviderId): void {
    this.providers.delete(providerId);
  }

  /**
   * Get a provider by ID
   */
  get(providerId: ProviderId): Provider | undefined {
    return this.providers.get(providerId);
  }

  /**
   * Check if a provider is registered
   */
  has(providerId: ProviderId): boolean {
    return this.providers.has(providerId);
  }

  /**
   * Get all registered providers
   */
  getAll(): Provider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get available providers (those with valid credentials)
   */
  async getAvailable(): Promise<Provider[]> {
    const all = this.getAll();
    const results = await Promise.all(
      all.map(async (provider) => {
        const available = await provider.isAvailable();
        return available ? provider : null;
      })
    );
    return results.filter((p): p is Provider => p !== null);
  }

  /**
   * Find the first registered provider that owns this model ID.
   * Uses each provider's ownsModel() heuristic for auto-detection.
   * Returns undefined if no provider claims the model.
   */
  findProviderForModel(modelId: string): Provider | undefined {
    for (const provider of this.providers.values()) {
      if (typeof provider.ownsModel === 'function' && provider.ownsModel(modelId)) {
        return provider;
      }
    }
    return undefined;
  }

  /**
   * Resolve provider by explicit (modelId, providerId) pair — fully deterministic.
   *
   * Both the model ID and provider ID must be known at the call site. This is the
   * preferred routing method: when the UI selects a model it always has the associated
   * provider ID, so there is never any ambiguity.
   *
   * Logs an error and returns `undefined` if the provider is not registered.
   */
  detectProviderForModel(modelId: string, providerId: string): Provider | undefined {
    const provider = this.providers.get(providerId);
    if (!provider) {
      log.error(`[routing] Unknown provider '${providerId}' for model '${modelId}'`);
    }
    return provider;
  }

  /**
   * Get provider information for all registered providers
   * Useful for UI display
   */
  async getProviderInfo(): Promise<ProviderInfo[]> {
    const providers = this.getAll();

    const results = await Promise.all(
      providers.map(async (provider) => {
        const available = await provider.isAvailable();
        const models = await provider.getModels();

        return {
          id: provider.id,
          name: provider.displayName,
          available,
          capabilities: provider.capabilities,
          models: models.map((m) => m.id),
        } satisfies ProviderInfo;
      })
    );

    return results;
  }

  /**
   * Get the default provider
   * Priority:
   * 1. DEFAULT_PROVIDER env var (if matches a registered provider)
   * 2. First available provider
   * 3. Anthropic (if registered)
   * 4. First registered provider
   */
  async getDefaultProvider(): Promise<Provider> {
    const envProvider = process.env.DEFAULT_PROVIDER;
    if (envProvider && this.has(envProvider)) {
      return this.get(envProvider)!;
    }

    // Try first available provider
    const available = await this.getAvailable();
    if (available.length > 0) {
      return available[0];
    }

    // Fall back to Anthropic
    if (this.has('anthropic')) {
      return this.get('anthropic')!;
    }

    // Fall back to first registered provider
    const all = this.getAll();
    if (all.length > 0) {
      return all[0];
    }

    throw new Error('No providers registered');
  }

  /**
   * Validate a provider switch
   * Checks if the provider exists and is available (or can be made available with API key)
   */
  async validateProviderSwitch(
    providerId: ProviderId,
    apiKey?: string
  ): Promise<{ valid: boolean; error?: string }> {
    // Check if provider is known
    const provider = this.get(providerId);
    if (!provider) {
      return { valid: false, error: `Unknown provider: ${providerId}` };
    }

    // If API key is provided, assume it will work
    if (apiKey) {
      return { valid: true };
    }

    // Check if provider is available
    const available = await provider.isAvailable();
    if (!available) {
      return {
        valid: false,
        error: `Provider ${providerId} is not available. Configure API key.`,
      };
    }

    return { valid: true };
  }

  /**
   * Clear all registered providers
   * Useful for testing
   */
  clear(): void {
    this.providers.clear();
  }

  /**
   * Get the count of registered providers
   */
  get size(): number {
    return this.providers.size;
  }
}

/**
 * Global registry instance
 */
let registryInstance: ProviderRegistry | null = null;

/**
 * Get the global provider registry instance
 */
export function getProviderRegistry(): ProviderRegistry {
  if (!registryInstance) {
    registryInstance = new ProviderRegistry();
  }
  return registryInstance;
}

/**
 * Reset the global registry instance
 * Useful for testing
 *
 * @public Exported for testing purposes
 */
export function resetProviderRegistry(): void {
  registryInstance = null;
}

/**
 * Infer the provider for a given model ID.
 *
 * Strategy (two-pass):
 * 1. Try the live registry via `findProviderForModel()` — covers all registered providers
 *    including `anthropic-copilot` and `anthropic-codex`, which have dynamic model lists.
 *    Returns the correct provider whenever the daemon has finished initializing.
 * 2. Fall back to a static naming heuristic when the registry is empty (e.g., unit tests
 *    or early-startup callers where providers are not yet registered):
 *    - `glm-*` → 'glm'
 *    - `minimax-*` → 'minimax'
 *    - `gpt-oss:*`, `*:*-cloud`, or bare `ollama` → Ollama providers
 *    - OpenRouter provider/model refs (`provider/model`) → 'openrouter'
 *    - `gpt-*` → 'anthropic-codex'
 *    - everything else → 'anthropic'
 *
 * Callers should NOT call `initializeProviders()` just for this function — the registry
 * is populated at daemon startup; calling it lazily at spawn-time is safe and avoids
 * test-interference from re-registering providers.
 */
export function inferProviderForModel(modelId: string): ProviderIdStr {
  const normalizedModelId = modelId.toLowerCase();

  // Route canonical ACP and Kimi/Moonshot IDs before live registry lookup because the
  // Anthropic provider intentionally claims unknown model IDs as a fallback.
  if (normalizedModelId.startsWith('acp-') || normalizedModelId === 'acp') return 'acp';

  // Exclude IDs containing ':' so Ollama tags like kimi-k2:latest or
  // moonshot-v1:latest fall through to Ollama routing.
  // Strip the documented `[1m]` context-window suffix first so `k3[1m]` and
  // `kimi-k3[1m]` route to Kimi just like the plain IDs.
  const kimiCheckId = normalizedModelId.replace(/\[1m\]$/, '');
  if (
    !kimiCheckId.includes(':') &&
    (kimiCheckId.startsWith('moonshot-') ||
      kimiCheckId.startsWith('kimi-') ||
      kimiCheckId === 'kimi' ||
      kimiCheckId === 'k3' ||
      kimiCheckId === 'k3-256k')
  ) {
    return 'kimi';
  }

  // Route bare GLM/MiniMax aliases before the live registry lookup for the same
  // reason as Kimi above: Anthropic claims unknown model IDs, and the GLM/MiniMax
  // providers only own the dashed prefixes (`glm-`/`minimax-`), so the bare
  // aliases would otherwise mis-route to Anthropic whenever the registry is
  // populated. Dashed IDs are excluded from Anthropic's ownsModel and resolve
  // via the registry (or the static fallback below when it is empty).
  if (normalizedModelId === 'glm') return 'glm';
  if (normalizedModelId === 'minimax') return 'minimax';

  // Bare Ollama/OpenRouter shorthands need pre-routing too: Anthropic is
  // registered first and its catch-all claims these exact IDs before the
  // Ollama/OpenRouter providers are ever consulted.
  if (normalizedModelId === 'ollama') return 'ollama';
  if (normalizedModelId === 'ollama-cloud') return 'ollama-cloud';
  if (normalizedModelId === 'openrouter/auto') return 'openrouter';

  // OpenRouter provider/model refs (`provider/model`, e.g. `openai/gpt-5.4`)
  // pre-route for the same reason — Anthropic's catch-all claims slash IDs
  // before the OpenRouter provider is consulted. claude-* refs stay Anthropic.
  if (normalizedModelId.includes('/') && !normalizedModelId.startsWith('claude-')) {
    return 'openrouter';
  }

  // Live registry lookup (populated at daemon startup, empty in unit tests)
  const fromRegistry = getProviderRegistry().findProviderForModel(modelId)?.id;
  if (fromRegistry) return fromRegistry as ProviderIdStr;
  // Static fallback when registry is empty
  if (modelId.startsWith('glm-')) return 'glm';
  if (modelId.startsWith('minimax-')) return 'minimax';
  if (modelId.startsWith('deepseek-') || modelId === 'deepseek') return 'deepseek';
  if (modelId.endsWith(':cloud')) return 'ollama-cloud';
  if (/^qwen[\w.-]*:[1-9]\d{2,}b$/i.test(modelId)) return 'ollama-cloud';
  if (/^qwen[\w.-]*:/i.test(modelId)) return 'ollama';
  if (/^gpt-oss:[1-9]\d{2,}b$/i.test(modelId)) return 'ollama-cloud';
  if (modelId.startsWith('gpt-oss:')) return modelId.endsWith('-cloud') ? 'ollama-cloud' : 'ollama';
  if (modelId.startsWith('gpt-')) return 'anthropic-codex';
  return 'anthropic';
}

/**
 * Infer a provider that is safe to PERSIST into a session config.
 *
 * Unlike `inferProviderForModel`, contested results are returned as `undefined`:
 * - `'anthropic'` is the catch-all for unknown IDs — the model may actually be
 *   cached under anthropic-copilot or a custom endpoint (e.g. Copilot's bare
 *   `gemini-3.1-pro-preview`).
 * - `'anthropic-codex'` is suppressed only when ANOTHER provider actually claims
 *   the ID AND is available (e.g. Copilot with GitHub auth offers `gpt-5.4`).
 *   Copilot is registered unconditionally, so without the availability gate a
 *   no-auth deployment would suppress the codex routing and, on a model-cache
 *   miss, silently fall to the Anthropic default model instead of the
 *   configured codex model. Codex-only IDs (e.g. `gpt-5.6-sol`) are always
 *   unambiguous and persist.
 *
 * Persisting a contested result makes session-lifecycle treat it as an explicit
 * provider and reject the cached match, launching the session against the wrong
 * API. `undefined` lets cached model metadata resolve the authoritative
 * provider. Positive identifications (pre-routed kimi/glm/minimax/acp, and
 * provider-specific Ollama/OpenRouter ID formats) are returned as-is.
 */
export async function inferPersistableProviderForModel(
  modelId: string
): Promise<ProviderIdStr | undefined> {
  const inferred = inferProviderForModel(modelId);
  if (inferred === 'anthropic') return undefined;
  if (inferred === 'anthropic-codex') {
    const otherOwners = getProviderRegistry()
      .getAll()
      .filter(
        (provider) =>
          provider.id !== 'anthropic-codex' &&
          typeof provider.ownsModel === 'function' &&
          provider.ownsModel(modelId)
      );
    for (const owner of otherOwners) {
      if (await owner.isAvailable()) return undefined;
    }
  }
  return inferred;
}
