import type { ModelInfo } from '@hyperneo/shared';
import type {
  CuratedModel,
  ListRemoteModelsOptions,
  ModelTier,
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderSdkConfig,
  ProviderSessionConfig,
} from '@hyperneo/shared/provider';
import { applyRecordedFailureToAuthStatus } from './provider-failure-store.js';
import { probeAnthropicCompatCredentials } from './shared/credential-probe.js';
import { buildModelListUrl, fetchRemoteModelList } from './shared/model-list.js';
import {
  mergeDiscoveredModels,
  ProviderDiscoveryCache,
  providerDiscoveryFingerprint,
} from './shared/discovery-cache.js';

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export type KimiRegion = 'china' | 'global';

const VALID_REGIONS: ReadonlySet<KimiRegion> = new Set<KimiRegion>(['china', 'global']);

export const KIMI_REGION_ENDPOINTS: Record<
  KimiRegion,
  { anthropicBaseUrl: string; openAiBaseUrl: string; modelId: string }
> = {
  china: {
    anthropicBaseUrl: 'https://api.kimi.com/coding',
    openAiBaseUrl: 'https://api.kimi.com/coding/v1',
    modelId: 'kimi-for-coding',
  },
  global: {
    anthropicBaseUrl: 'https://api.moonshot.ai/anthropic',
    openAiBaseUrl: 'https://api.moonshot.ai/v1',
    modelId: 'kimi-k2.7-code',
  },
};

export function resolveKimiRegion(region: unknown): KimiRegion {
  if (typeof region === 'string') {
    const normalised = region.toLowerCase() as KimiRegion;
    if (VALID_REGIONS.has(normalised)) {
      return normalised;
    }
  }
  return 'china';
}

export class KimiProvider implements Provider {
  readonly id = 'kimi';
  readonly displayName = 'Kimi (Moonshot AI)';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    extendedThinking: true,
    thinkingModes: 'on',
    maxContextWindow: 1_048_576,
    functionCalling: true,
    vision: true,
  };

  static readonly BASE_URL = KIMI_REGION_ENDPOINTS.china.anthropicBaseUrl;
  static readonly OPENAI_BASE_URL = KIMI_REGION_ENDPOINTS.china.openAiBaseUrl;
  static readonly DEFAULT_MODEL = KIMI_REGION_ENDPOINTS.china.modelId;
  static readonly GLOBAL_MODEL = KIMI_REGION_ENDPOINTS.global.modelId;

  static readonly MODELS: ModelInfo[] = [
    {
      id: 'kimi-k3[1m]',
      name: 'Kimi K3',
      alias: 'k3',
      family: 'kimi',
      provider: 'kimi',
      contextWindow: 1_048_576,
      providerAliases: ['k3', 'kimi-k3', 'K3', 'Kimi-K3', 'k3[1m]', 'kimi-k3[1m]'],
      providerAliasPrefixes: ['moonshot-k3'],
      preferContextWindowMetadata: true,
      thinkingModes: 'granular',
      description: 'Kimi K3 · 1M context window reasoning model',
      releaseDate: '',
      available: true,
    },
    {
      id: 'k3-256k',
      name: 'Kimi K3 (256K)',
      alias: 'k3-256k',
      family: 'kimi',
      provider: 'kimi',
      contextWindow: 262_144,
      providerAliases: ['kimi-k3-256k'],
      providerAliasPrefixes: ['moonshot-k3-256k'],
      sdkModelIds: ['kimi-k3-256k'],
      preferContextWindowMetadata: true,
      thinkingModes: 'granular',
      description: 'Kimi K3 · 256K context (image only, no video)',
      releaseDate: '',
      available: true,
    },
    {
      id: 'kimi-k2.7-code-highspeed',
      name: 'Kimi K2.7 Code Highspeed',
      alias: 'kimi-k2.7-code-highspeed',
      family: 'kimi',
      provider: 'kimi',
      contextWindow: 262_144,
      providerAliases: ['kimi-k2.7-code-highspeed', 'kimi-for-coding-highspeed'],
      preferContextWindowMetadata: true,
      thinkingModes: 'on',
      description: 'Kimi K2.7 Code Highspeed · fast coding model',
      releaseDate: '',
      available: true,
    },
    {
      id: 'kimi-for-coding',
      name: 'Kimi K2.7',
      alias: 'kimi',
      family: 'kimi',
      provider: 'kimi',
      contextWindow: 262_144,
      providerAliases: ['KIMI', 'Kimi', 'kimi-k2.7-code', 'Kimi-K2.7-Code'],
      preferContextWindowMetadata: true,
      thinkingModes: 'on',
      description: 'Kimi Code model from Moonshot Claude Code integration docs.',
      releaseDate: '',
      available: true,
    },
  ];

  private readonly env: NodeJS.ProcessEnv;
  private credentials: ProviderCredentials | null = null;
  private defaultRegion: KimiRegion = 'china';
  private curatedModels: CuratedModel[] | undefined;

  private readonly probeCache = new Map<string, { at: number; result: Promise<void> }>();
  private readonly discoveryCache = new ProviderDiscoveryCache();
  private static readonly PROBE_TTL_MS = 30_000;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    _legacyBridgeFactory?: unknown,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.env = env;
  }

  setCredentials(credentials: ProviderCredentials): void {
    this.credentials = credentials;
    this.probeCache.clear();
    this.discoveryCache.clear();
  }

  getCredentials(): ProviderCredentials | null {
    return this.credentials;
  }

  setDefaultRegion(region: KimiRegion): void {
    if (region !== this.defaultRegion) {
      this.discoveryCache.clear();
    }
    this.defaultRegion = region;
  }

  clearModelCache(): void {
    this.discoveryCache.clear();
  }

  getDefaultRegion(): KimiRegion {
    return this.defaultRegion;
  }

  static getBaseUrlForRegion(region: KimiRegion = 'china'): string {
    return KIMI_REGION_ENDPOINTS[region].anthropicBaseUrl;
  }

  static getOpenAiBaseUrlForRegion(region: KimiRegion = 'china'): string {
    return KIMI_REGION_ENDPOINTS[region].openAiBaseUrl;
  }

  static getModelIdForRegion(region: KimiRegion = 'china'): string {
    return KIMI_REGION_ENDPOINTS[region].modelId;
  }

  private static normalizeKimiModelId(modelId: string): string {
    return modelId
      .replace(/\[1m\]$/i, '')
      .trim()
      .toLowerCase();
  }

  private static hasOneMContextSuffix(modelId: string): boolean {
    return /\[1m\]$/i.test(modelId.trim());
  }

  static isKimiK3Model(modelId: string): boolean {
    const id = KimiProvider.normalizeKimiModelId(modelId);
    return (
      id === 'k3' ||
      id === 'kimi-k3' ||
      id === 'moonshot-k3' ||
      id.startsWith('k3-') ||
      id.startsWith('kimi-k3-') ||
      id.startsWith('moonshot-k3-')
    );
  }

  static isKimiK3OneMModel(modelId: string): boolean {
    const id = KimiProvider.normalizeKimiModelId(modelId);
    return (
      KimiProvider.isKimiK3Model(modelId) &&
      id !== 'k3-256k' &&
      id !== 'kimi-k3-256k' &&
      !id.startsWith('moonshot-k3-256k')
    );
  }

  static isKimiK2Point7Model(modelId: string): boolean {
    const id = KimiProvider.normalizeKimiModelId(modelId);
    if (KimiProvider.isKimiK3Model(modelId)) return false;
    return (
      id === 'kimi' ||
      id === 'kimi-for-coding' ||
      id === 'kimi-k2.7-code' ||
      id === 'kimi-k2.7-code-highspeed' ||
      id === 'kimi-for-coding-highspeed'
    );
  }

  private static isDiscoveredKimiModelId(modelId: string): boolean {
    const id = KimiProvider.normalizeKimiModelId(modelId);
    if (id.includes(':')) return false;
    return (
      id === 'kimi' ||
      id === 'k3' ||
      id.startsWith('kimi-') ||
      id.startsWith('moonshot-') ||
      id.startsWith('k3-')
    );
  }

  static isCapacityTaggedModelId(modelId: string): boolean {
    return /-(8|32|128)k$/i.test(KimiProvider.normalizeKimiModelId(modelId));
  }

  private static discoveredThinkingModesFor(modelId: string): 'granular' | 'on' | 'off' {
    if (KimiProvider.isKimiK3Model(modelId)) return 'granular';
    if (KimiProvider.resolveContextWindow(modelId) < 65_536) return 'off';
    return 'on';
  }

  static resolveKimiTitleThinkingConfig(
    modelId: string
  ): { type: 'enabled'; budgetTokens: 16000 } | { type: 'disabled' } | undefined {
    if (KimiProvider.isKimiK3Model(modelId)) return undefined;
    if (KimiProvider.isKimiK2Point7Model(modelId)) {
      return { type: 'enabled', budgetTokens: 16_000 };
    }
    return { type: 'disabled' };
  }

  static resolveRegionFromBaseUrl(baseUrl: string): KimiRegion | undefined {
    const normalized = normalizeBaseUrl(baseUrl).toLowerCase();
    try {
      const host = new URL(normalized).host;
      if (host === 'api.moonshot.ai') {
        return 'global';
      }
      if (host === 'api.moonshot.cn' || host === 'api.kimi.com') {
        return 'china';
      }
    } catch {}
    if (
      normalized === KIMI_REGION_ENDPOINTS.global.anthropicBaseUrl.toLowerCase() ||
      normalized === KIMI_REGION_ENDPOINTS.global.openAiBaseUrl.toLowerCase()
    ) {
      return 'global';
    }
    if (
      normalized === KIMI_REGION_ENDPOINTS.china.anthropicBaseUrl.toLowerCase() ||
      normalized === KIMI_REGION_ENDPOINTS.china.openAiBaseUrl.toLowerCase()
    ) {
      return 'china';
    }
    return undefined;
  }

  private static isLegacyKimiCodeEndpoint(baseUrl: string): boolean {
    const normalized = normalizeBaseUrl(baseUrl).toLowerCase();
    try {
      const url = new URL(normalized);
      return url.host === 'api.kimi.com' && url.pathname.startsWith('/coding');
    } catch {
      return false;
    }
  }

  private static isModernMoonshotOpenPlatformEndpoint(baseUrl: string): boolean {
    const normalized = normalizeBaseUrl(baseUrl).toLowerCase();
    try {
      const host = new URL(normalized).host;
      return host === 'api.moonshot.ai' || host === 'api.moonshot.cn';
    } catch {
      return false;
    }
  }

  isAvailable(): boolean {
    return !!this.getApiKey();
  }

  getApiKey(): string | undefined {
    return (
      this.env.KIMI_API_KEY?.trim() ||
      this.env.MOONSHOT_API_KEY?.trim() ||
      (this.credentials?.type === 'api_key' ? this.credentials.apiKey : undefined)
    );
  }

  private async verifyCredentials(
    baseUrl: string,
    apiKey: string,
    modelId: string,
    thinking?: { type: 'enabled'; budget_tokens: number }
  ): Promise<void> {
    const cacheKey = `${baseUrl}::${modelId}::${apiKey}`;
    const cached = this.probeCache.get(cacheKey);
    if (cached && Date.now() - cached.at < KimiProvider.PROBE_TTL_MS) {
      await cached.result;
      return;
    }
    const result = probeAnthropicCompatCredentials({
      baseUrl,
      apiKey,
      model: modelId,
      providerName: 'Kimi',
      fetchImpl: this.fetchImpl,
      thinking,
    })
      .then(() => undefined)
      .catch((err) => {
        this.probeCache.delete(cacheKey);
        throw err;
      });
    this.probeCache.set(cacheKey, { at: Date.now(), result });
    await result;
  }

  async getModels(): Promise<ModelInfo[]> {
    const apiKey = this.getApiKey();
    if (!apiKey) return [];
    const explicitRegion = this.env.KIMI_REGION;
    const regionBaseUrl = KimiProvider.getBaseUrlForRegion(
      explicitRegion ? resolveKimiRegion(explicitRegion) : this.defaultRegion
    );
    const baseUrl = normalizeBaseUrl(this.env.KIMI_BASE_URL || regionBaseUrl);
    const region = explicitRegion
      ? resolveKimiRegion(explicitRegion)
      : (KimiProvider.resolveRegionFromBaseUrl(baseUrl) ?? this.defaultRegion);
    const probeModelId = KimiProvider.resolveUpstreamModelId(
      KimiProvider.getModelIdForRegion(region),
      baseUrl,
      region
    );
    await this.verifyCredentials(baseUrl, apiKey, probeModelId, {
      type: 'enabled',
      budget_tokens: 16_000,
    });
    let models: ModelInfo[];
    try {
      const discovered = await this.listRemoteModels();
      models = mergeDiscoveredModels(KimiProvider.MODELS, discovered);
    } catch {
      models = KimiProvider.MODELS;
    }
    return this.mergeCuratedModels(models);
  }

  setCuratedModels(models: CuratedModel[] | undefined): void {
    this.curatedModels = models;
  }

  getCachedModels(): ModelInfo[] | null {
    if (!this.curatedModels?.length) return null;
    return this.mergeCuratedModels(KimiProvider.MODELS);
  }

  private mergeCuratedModels(models: ModelInfo[]): ModelInfo[] {
    if (!this.curatedModels?.length) return models;
    const merged = [...models];
    const present = new Set(merged.map((model) => model.id));
    for (const curated of this.curatedModels) {
      if (!this.ownsModel(curated.id)) continue;
      const info = this.toRemoteModelInfo({ id: curated.id, name: curated.name });
      if (info && !present.has(info.id)) {
        merged.push(info);
        present.add(info.id);
      }
    }
    return merged;
  }

  getDiscoveryEndpointFingerprint(discoveryBaseUrl?: string): string {
    return providerDiscoveryFingerprint({
      region: this.env.KIMI_REGION ?? this.defaultRegion,
      baseUrl: this.resolveModelListBaseUrl(discoveryBaseUrl),
    });
  }

  private discoveryFingerprint(): string {
    return providerDiscoveryFingerprint({
      region: this.env.KIMI_REGION ?? this.defaultRegion,
      baseUrl: this.resolveModelListBaseUrl(),
      credentialKey: this.getApiKey(),
    });
  }

  async listRemoteModels(options: ListRemoteModelsOptions = {}): Promise<ModelInfo[]> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('Kimi API key not configured. Set KIMI_API_KEY or MOONSHOT_API_KEY.');
    }
    const cacheable = options.baseUrl === undefined;
    const fingerprint = this.discoveryFingerprint();
    if (!options.force && cacheable) {
      const cached = this.discoveryCache.get(fingerprint);
      if (cached) return cached;
    }
    const baseUrl = this.resolveModelListBaseUrl(options.baseUrl);
    const models = await fetchRemoteModelList({
      url: buildModelListUrl(baseUrl, 'openai-chat'),
      headers: { Authorization: `Bearer ${apiKey}` },
      fetchImpl: this.fetchImpl,
    });
    const knownModels = models
      .map((model) => this.toRemoteModelInfo(model))
      .filter((model): model is ModelInfo => model !== null);
    const discovered = Array.from(new Map(knownModels.map((model) => [model.id, model])).values());
    if (cacheable) {
      this.discoveryCache.set(fingerprint, discovered);
    }
    return this.mergeCuratedModels(discovered);
  }

  ownsModel(modelId: string): boolean {
    const id = KimiProvider.normalizeKimiModelId(modelId);
    if (id.includes(':')) return false;
    return (
      id === 'kimi' ||
      id === 'k3' ||
      id === 'kimi-k3' ||
      id === 'k3-256k' ||
      id === 'kimi-k3-256k' ||
      id === 'kimi-for-coding' ||
      id === 'kimi-k2.7-code' ||
      id === 'kimi-k2.7-code-highspeed' ||
      id === 'kimi-for-coding-highspeed' ||
      id.startsWith('moonshot-') ||
      KimiProvider.isDiscoveredKimiModelId(modelId)
    );
  }

  getModelForTier(_tier: ModelTier): string | undefined {
    return KimiProvider.DEFAULT_MODEL;
  }

  getModelThinkingMode(modelId: string): 'off' | 'on' | 'granular' | undefined {
    if (KimiProvider.isKimiK3Model(modelId)) return 'granular';
    if (KimiProvider.isKimiK2Point7Model(modelId)) return 'on';
    if (
      this.ownsModel(modelId) &&
      !KimiProvider.hasOneMContextSuffix(modelId) &&
      KimiProvider.resolveContextWindow(modelId) < 65_536
    ) {
      return 'off';
    }
    return undefined;
  }

  private static canonicalizeModelId(modelId: string): string {
    const id = KimiProvider.normalizeKimiModelId(modelId);
    if (
      id === 'k3-256k' ||
      id === 'kimi-k3-256k' ||
      id === 'moonshot-k3-256k' ||
      id.startsWith('moonshot-k3-256k-')
    ) {
      return 'k3-256k';
    }
    if (
      id === 'k3' ||
      id === 'kimi-k3' ||
      id === 'moonshot-k3' ||
      (id.startsWith('moonshot-k3-') && !KimiProvider.isCapacityTaggedModelId(modelId))
    ) {
      return 'kimi-k3[1m]';
    }
    if (KimiProvider.hasOneMContextSuffix(modelId)) return modelId;
    if (id === 'kimi-k2.7-code-highspeed' || id === 'kimi-for-coding-highspeed')
      return 'kimi-k2.7-code-highspeed';
    if (id === 'kimi-k2.7-code') return 'kimi-k2.7-code';
    if (id === 'kimi' || id === 'kimi-for-coding') return 'kimi-for-coding';
    return modelId;
  }

  private static resolveUpstreamModelId(
    modelId: string,
    baseUrl?: string,
    region?: KimiRegion
  ): string {
    const id = KimiProvider.normalizeKimiModelId(modelId);
    const oneM = KimiProvider.hasOneMContextSuffix(modelId);
    let useLegacy = false;
    if (baseUrl) {
      if (KimiProvider.isModernMoonshotOpenPlatformEndpoint(baseUrl)) {
        useLegacy = false;
      } else if (KimiProvider.isLegacyKimiCodeEndpoint(baseUrl)) {
        useLegacy = true;
      } else {
        useLegacy = region !== 'global';
      }
    } else {
      useLegacy = region !== 'global';
    }
    if (
      id === 'k3-256k' ||
      id === 'kimi-k3-256k' ||
      id === 'moonshot-k3-256k' ||
      id.startsWith('moonshot-k3-256k-')
    ) {
      return useLegacy ? 'k3-256k' : 'kimi-k3-256k';
    }
    if (
      id === 'k3' ||
      id === 'kimi-k3' ||
      id === 'moonshot-k3' ||
      (id.startsWith('moonshot-k3-') && !KimiProvider.isCapacityTaggedModelId(modelId))
    ) {
      return (useLegacy ? 'k3' : 'kimi-k3') + (oneM ? '[1m]' : '');
    }
    if (oneM && KimiProvider.isDiscoveredKimiModelId(modelId)) {
      return modelId;
    }
    if (id === 'kimi-k2.7-code-highspeed' || id === 'kimi-for-coding-highspeed') {
      return useLegacy ? 'kimi-for-coding-highspeed' : 'kimi-k2.7-code-highspeed';
    }
    if (id === 'kimi-k2.7-code' || id === 'kimi' || id === 'kimi-for-coding') {
      return useLegacy ? 'kimi-for-coding' : 'kimi-k2.7-code';
    }
    if (KimiProvider.isDiscoveredKimiModelId(modelId)) {
      return modelId;
    }
    return useLegacy ? 'kimi-for-coding' : 'kimi-k2.7-code';
  }

  static resolveContextWindow(modelId: string): number {
    const canonical = KimiProvider.canonicalizeModelId(modelId);
    const normalized = KimiProvider.normalizeKimiModelId(canonical);
    if (normalized === 'k3-256k' || normalized === 'kimi-k3-256k') return 262_144;
    if (
      normalized === 'kimi-k3' ||
      (KimiProvider.hasOneMContextSuffix(modelId) && KimiProvider.isDiscoveredKimiModelId(modelId))
    ) {
      return 1_048_576;
    }
    const capacityMatch = /-(8|32|128)k$/.exec(normalized);
    if (capacityMatch) return parseInt(capacityMatch[1], 10) * 1024;
    return 262_144;
  }

  buildSdkConfig(_modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    const apiKey = sessionConfig?.apiKey || this.getApiKey();
    if (!apiKey) {
      throw new Error('Kimi API key not configured. Set KIMI_API_KEY or MOONSHOT_API_KEY.');
    }

    const explicitRegion = sessionConfig?.region ?? this.env.KIMI_REGION;
    const regionBaseUrl = KimiProvider.getBaseUrlForRegion(
      explicitRegion ? resolveKimiRegion(explicitRegion) : this.defaultRegion
    );
    const baseUrl = normalizeBaseUrl(
      sessionConfig?.baseUrl || this.env.KIMI_BASE_URL || regionBaseUrl
    );

    if (baseUrl.endsWith('/v1')) {
      throw new Error(
        `Kimi base URL ${baseUrl} appears to be a Moonshot OpenAI-compatible /v1 endpoint. ` +
          'Use the Kimi Code Anthropic-compatible endpoint (e.g. https://api.moonshot.ai/anthropic) instead.'
      );
    }

    const effectiveRegion = explicitRegion
      ? resolveKimiRegion(explicitRegion)
      : (KimiProvider.resolveRegionFromBaseUrl(baseUrl) ?? this.defaultRegion);

    const contextWindow = KimiProvider.resolveContextWindow(_modelId);
    const routingModelId = KimiProvider.resolveUpstreamModelId(_modelId, baseUrl, effectiveRegion);

    return {
      envVars: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_MODEL: routingModelId,
        ANTHROPIC_DEFAULT_OPUS_MODEL: routingModelId,
        ANTHROPIC_DEFAULT_SONNET_MODEL: routingModelId,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: routingModelId,
        CLAUDE_CODE_SUBAGENT_MODEL: routingModelId,
        ENABLE_TOOL_SEARCH: 'false',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow),
        API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  translateModelIdForSdk(modelId: string): string {
    return KimiProvider.canonicalizeModelId(modelId);
  }

  getTitleGenerationModel(): string {
    return KimiProvider.DEFAULT_MODEL;
  }

  private resolveModelListBaseUrl(baseUrl?: string): string {
    const configuredBaseUrl = baseUrl ?? this.env.KIMI_BASE_URL;
    if (configuredBaseUrl) {
      const normalizedBaseUrl = normalizeBaseUrl(configuredBaseUrl).toLowerCase();
      if (normalizedBaseUrl === 'https://api.moonshot.cn/anthropic') {
        return 'https://api.moonshot.cn/v1';
      }
      for (const region of VALID_REGIONS) {
        if (
          normalizedBaseUrl === KimiProvider.getBaseUrlForRegion(region).toLowerCase() ||
          normalizedBaseUrl === KimiProvider.getOpenAiBaseUrlForRegion(region).toLowerCase()
        ) {
          return KimiProvider.getOpenAiBaseUrlForRegion(region);
        }
      }
      return configuredBaseUrl;
    }
    const explicitRegion = this.env.KIMI_REGION;
    const region = explicitRegion ? resolveKimiRegion(explicitRegion) : this.defaultRegion;
    return KimiProvider.getOpenAiBaseUrlForRegion(region);
  }

  private toRemoteModelInfo(model: { id: string; name?: string }): ModelInfo | null {
    const normalized = KimiProvider.normalizeKimiModelId(model.id);
    const exactMatch = KimiProvider.MODELS.find((candidate) => {
      const identifiers = [
        candidate.id,
        ...(candidate.sdkModelIds ?? []),
        ...(candidate.providerAliases ?? []),
      ];
      return identifiers.some(
        (identifier) => KimiProvider.normalizeKimiModelId(identifier) === normalized
      );
    });
    const exactMatchLosesSuffix =
      exactMatch !== undefined &&
      KimiProvider.hasOneMContextSuffix(model.id) &&
      !KimiProvider.hasOneMContextSuffix(exactMatch.id);
    if (exactMatch && !exactMatchLosesSuffix) return exactMatch;
    let prefixMatch: { model: ModelInfo; length: number } | undefined;
    for (const candidate of KimiProvider.MODELS) {
      for (const rawPrefix of candidate.providerAliasPrefixes ?? []) {
        const prefix = KimiProvider.normalizeKimiModelId(rawPrefix);
        if (
          (normalized === prefix || normalized.startsWith(`${prefix}-`)) &&
          (!prefixMatch || prefix.length > prefixMatch.length)
        ) {
          prefixMatch = { model: candidate, length: prefix.length };
        }
      }
    }
    if (
      prefixMatch &&
      KimiProvider.isKimiK3Model(model.id) &&
      !KimiProvider.isCapacityTaggedModelId(model.id)
    ) {
      return prefixMatch.model;
    }
    if (KimiProvider.isDiscoveredKimiModelId(model.id)) {
      return {
        id: model.id,
        name: model.name ?? model.id,
        alias: model.id,
        family: 'kimi',
        provider: this.id,
        contextWindow: KimiProvider.resolveContextWindow(model.id),
        preferContextWindowMetadata: true,
        thinkingModes: KimiProvider.discoveredThinkingModesFor(model.id),
        description: `${model.name ?? model.id} via Kimi`,
        releaseDate: '',
        available: true,
      };
    }
    return null;
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    const apiKey = this.getApiKey();
    return applyRecordedFailureToAuthStatus(this.id, {
      isAuthenticated: !!apiKey,
      method: 'api_key',
      error: apiKey ? undefined : 'Set KIMI_API_KEY or MOONSHOT_API_KEY to enable Kimi models.',
    });
  }

  async shutdown(): Promise<void> {}
}
