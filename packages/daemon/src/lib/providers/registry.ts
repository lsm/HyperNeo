import { createLogger } from '@hyperneo/shared/logger';
import type { CuratedModel, Provider, ProviderId, ProviderInfo } from '@hyperneo/shared/provider';
import type { Provider as ProviderIdStr } from '@hyperneo/shared';

const log = createLogger('hyperneo:providers:registry');

export class ProviderRegistry {
  private providers = new Map<ProviderId, Provider>();
  private curatedModels = new Map<ProviderId, CuratedModel[]>();

  register(provider: Provider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider ${provider.id} is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  unregister(providerId: ProviderId): void {
    this.providers.delete(providerId);
    this.curatedModels.delete(providerId);
  }

  setCuratedModels(providerId: ProviderId, models: CuratedModel[] | undefined): void {
    if (models === undefined) {
      this.curatedModels.delete(providerId);
      return;
    }
    this.curatedModels.set(
      providerId,
      models.map((model) => ({ ...model }))
    );
  }

  getCuratedModels(providerId: ProviderId): CuratedModel[] | undefined {
    return this.curatedModels.get(providerId)?.map((model) => ({ ...model }));
  }

  get(providerId: ProviderId): Provider | undefined {
    return this.providers.get(providerId);
  }

  has(providerId: ProviderId): boolean {
    return this.providers.has(providerId);
  }

  getAll(): Provider[] {
    return Array.from(this.providers.values());
  }

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

  findProviderForModel(modelId: string): Provider | undefined {
    for (const provider of this.providers.values()) {
      if (typeof provider.ownsModel === 'function' && provider.ownsModel(modelId)) {
        return provider;
      }
    }
    return undefined;
  }

  detectProviderForModel(modelId: string, providerId: string): Provider | undefined {
    const provider = this.providers.get(providerId);
    if (!provider) {
      log.error(`[routing] Unknown provider '${providerId}' for model '${modelId}'`);
    }
    return provider;
  }

  async getProviderInfo(): Promise<ProviderInfo[]> {
    const providers = this.getAll();

    const results = await Promise.allSettled(
      providers.map(async (provider) => {
        const available = await Promise.resolve(provider.isAvailable()).catch(() => false);
        const models = await Promise.resolve(provider.getModels()).catch(() => []);

        return {
          id: provider.id,
          name: provider.displayName,
          available,
          capabilities: provider.capabilities,
          models: models.map((m) => m.id),
        } satisfies ProviderInfo;
      })
    );

    return results.map((result, index) =>
      result.status === 'fulfilled'
        ? result.value
        : {
            id: providers[index].id,
            name: providers[index].displayName,
            available: false,
            capabilities: providers[index].capabilities,
            models: [],
          }
    );
  }

  async getDefaultProvider(): Promise<Provider> {
    const envProvider = process.env.DEFAULT_PROVIDER;
    if (envProvider && this.has(envProvider)) {
      return this.get(envProvider)!;
    }

    const available = await this.getAvailable();
    if (available.length > 0) {
      return available[0];
    }

    if (this.has('anthropic')) {
      return this.get('anthropic')!;
    }

    const all = this.getAll();
    if (all.length > 0) {
      return all[0];
    }

    throw new Error('No providers registered');
  }

  async validateProviderSwitch(
    providerId: ProviderId,
    apiKey?: string
  ): Promise<{ valid: boolean; error?: string }> {
    const provider = this.get(providerId);
    if (!provider) {
      return { valid: false, error: `Unknown provider: ${providerId}` };
    }

    if (apiKey) {
      return { valid: true };
    }

    const available = await provider.isAvailable();
    if (!available) {
      return {
        valid: false,
        error: `Provider ${providerId} is not available. Configure API key.`,
      };
    }

    return { valid: true };
  }

  clear(): void {
    this.providers.clear();
    this.curatedModels.clear();
  }

  get size(): number {
    return this.providers.size;
  }
}

let registryInstance: ProviderRegistry | null = null;

export function getProviderRegistry(): ProviderRegistry {
  if (!registryInstance) {
    registryInstance = new ProviderRegistry();
  }
  return registryInstance;
}

/** @public */
export function resetProviderRegistry(): void {
  registryInstance = null;
}

export function inferProviderForModel(modelId: string): ProviderIdStr {
  const normalizedModelId = modelId.toLowerCase();

  if (normalizedModelId.startsWith('acp-') || normalizedModelId === 'acp') return 'acp';

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

  if (normalizedModelId === 'glm') return 'glm';
  if (normalizedModelId === 'minimax') return 'minimax';

  if (normalizedModelId === 'ollama') return 'ollama';
  if (normalizedModelId === 'ollama-cloud') return 'ollama-cloud';
  if (normalizedModelId === 'openrouter/auto') return 'openrouter';

  if (normalizedModelId.includes('/') && !normalizedModelId.startsWith('claude-')) {
    return 'openrouter';
  }

  const fromRegistry = getProviderRegistry().findProviderForModel(modelId)?.id;
  if (fromRegistry) return fromRegistry as ProviderIdStr;
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
