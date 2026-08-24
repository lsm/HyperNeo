import { useState, useEffect, useCallback, useMemo } from 'preact/hooks';
import type { ModelInfo } from '@hyperneo/shared';
import type { ProviderAuthStatus } from '@hyperneo/shared/provider';
import { connectionManager } from '../lib/connection-manager';
import { connectionState } from '../lib/state';
import { toast } from '../lib/toast';

export interface UseModelSwitcherResult {
  currentModel: string;
  currentModelInfo: ModelInfo | null;
  availableModels: ModelInfo[];
  switching: boolean;
  loading: boolean;
  switchModel: (model: ModelInfo) => Promise<void>;
  reload: () => Promise<void>;
}

export const MODEL_FAMILY_ICONS: Record<string, string> = {
  opus: '🧠',
  sonnet: '💎',
  haiku: '⚡',
  glm: '🌐',
  kimi: '🌙',
  minimax: '🔥',
  openrouter: '🧭',
  gpt: '🔮',
  __default__: '💎',
};

export function getModelFamilyIcon(family: string): string {
  return MODEL_FAMILY_ICONS[family] || MODEL_FAMILY_ICONS.__default__;
}

export const PROVIDER_ORDER: Record<string, number> = {
  anthropic: 0,
  'anthropic-copilot': 1,
  'anthropic-codex': 2,
  openrouter: 3,
  glm: 4,
  kimi: 5,
  minimax: 6,
  deepseek: 7,
};

export const FAMILY_ORDER: Record<string, number> = {
  opus: 0,
  sonnet: 1,
  haiku: 2,
  glm: 3,
  kimi: 4,
  minimax: 5,
  deepseek: 6,
  openrouter: 6,
  gpt: 7,
};

export interface RawModelEntry {
  id: string;
  display_name: string;
  description: string;
  alias?: string;
  provider?: string;
  contextWindow?: number;
  context_window?: number;
  thinkingModes?: 'off' | 'on' | 'granular';
}

export function mapRawModelsToModelInfos(models: RawModelEntry[]): ModelInfo[] {
  const modelInfos = models.map((m) => {
    let family = 'sonnet';
    const mid = m.id.toLowerCase();
    if (mid.includes('opus')) {
      family = 'opus';
    } else if (mid.includes('haiku')) {
      family = 'haiku';
    } else if (mid.startsWith('glm-')) {
      family = 'glm';
    } else if (mid.startsWith('moonshot-') || mid.startsWith('kimi-') || mid === 'kimi') {
      family = 'kimi';
    } else if (mid.startsWith('minimax-')) {
      family = 'minimax';
    } else if (mid.startsWith('deepseek-')) {
      family = 'deepseek';
    } else if (mid === 'openrouter/auto') {
      family = 'openrouter';
    } else if (mid.startsWith('gpt-') || mid.includes('/gpt')) {
      family = 'gpt';
    } else if (mid.includes('/')) {
      family = 'openrouter';
    }
    const contextWindow = m.contextWindow ?? m.context_window;
    const inferredProvider =
      m.provider || inferProviderFromModelId(mid) || PROVIDER_FROM_FAMILY[family] || 'anthropic';
    return {
      id: m.id,
      name: m.display_name,
      alias: m.alias || m.id,
      family,
      provider: inferredProvider,
      contextWindow: typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : 0,
      description: m.description || '',
      releaseDate: '',
      available: true,
      thinkingModes: m.thinkingModes,
    };
  });

  modelInfos.sort((a, b) => {
    const providerA = PROVIDER_ORDER[a.provider || 'anthropic'] ?? 99;
    const providerB = PROVIDER_ORDER[b.provider || 'anthropic'] ?? 99;
    if (providerA !== providerB) return providerA - providerB;
    const familyA = FAMILY_ORDER[a.family] ?? 99;
    const familyB = FAMILY_ORDER[b.family] ?? 99;
    return familyA - familyB;
  });

  return modelInfos;
}

const PROVIDER_FROM_FAMILY: Record<string, string> = {
  glm: 'glm',
  kimi: 'kimi',
  minimax: 'minimax',
  gpt: 'anthropic-codex',
  openrouter: 'openrouter',
};

export function inferProviderFromModelId(modelId: string): string | undefined {
  const id = modelId.toLowerCase();

  if (id.startsWith('claude-')) return 'anthropic';

  if (id === 'ollama-cloud' || id.endsWith(':cloud')) return 'ollama-cloud';

  if (/^qwen[\w.-]*:[1-9]\d{2,}b$/i.test(id)) return 'ollama-cloud';
  if (/^qwen[\w.-]*:/i.test(id)) return 'ollama';
  if (/^gpt-oss:[1-9]\d{2,}b$/i.test(id)) return 'ollama-cloud';
  if (id.startsWith('gpt-oss:')) return id.endsWith('-cloud') ? 'ollama-cloud' : 'ollama';

  if (id === 'openrouter/auto' || id.includes('/')) return 'openrouter';

  if (id.includes(':')) return 'ollama';

  if (id.startsWith('glm-') || id === 'glm') return 'glm';
  if (
    id.startsWith('moonshot-') ||
    id.startsWith('kimi-') ||
    id === 'kimi' ||
    id === 'k3' ||
    id === 'k3-256k'
  )
    return 'kimi';
  if (id.startsWith('minimax-') || id === 'minimax') return 'minimax';
  if (id.startsWith('deepseek-') || id === 'deepseek') return 'deepseek';
  if (id === 'ollama') return 'ollama';
  if (id.startsWith('gpt-')) return 'anthropic-codex';
  return undefined;
}

export function groupModelsByProvider(models: ModelInfo[]): Map<string, ModelInfo[]> {
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const provider = model.provider || 'anthropic';
    const existing = groups.get(provider);
    if (existing) {
      existing.push(model);
    } else {
      groups.set(provider, [model]);
    }
  }
  return groups;
}

export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  glm: 'Z.ai',
  kimi: 'Kimi',
  minimax: 'MiniMax',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  'anthropic-copilot': 'Copilot',
  'anthropic-codex': 'Codex',
};

export function getProviderLabel(provider: string): string {
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
  if (provider.startsWith('custom:')) {
    const slug = provider.slice('custom:'.length);
    return `Custom — ${slug}`;
  }
  return provider;
}

export function isDefinitiveAuthFailure(auth: ProviderAuthStatus): boolean {
  return !auth.isAuthenticated && auth.errorKind !== 'transient';
}

export function filterModelsForPicker(
  models: ModelInfo[],
  providerAuthMap: Map<string, ProviderAuthStatus>,
  currentProvider?: string,
  currentModelId?: string
): ModelInfo[] {
  return models.filter((m) => {
    const auth = providerAuthMap.get(m.provider);
    if (!auth) return true;
    if (isDefinitiveAuthFailure(auth)) {
      return m.provider === currentProvider && m.id === currentModelId;
    }
    return true;
  });
}

export function filterModelsBySearch(models: ModelInfo[], searchQuery: string): ModelInfo[] {
  const terms = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return models;

  return models.filter((model) => {
    const provider = model.provider || 'anthropic';
    const searchable = [model.name, model.id, model.alias, getProviderLabel(provider), provider]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return terms.every((term) => searchable.includes(term));
  });
}

export function useFilteredModelsForPicker(
  models: ModelInfo[],
  providerAuthMap: Map<string, ProviderAuthStatus>,
  currentProvider: string | undefined,
  currentModelId: string | undefined,
  searchQuery: string
): ModelInfo[] {
  return useMemo(() => {
    const authFilteredModels = filterModelsForPicker(
      models,
      providerAuthMap,
      currentProvider,
      currentModelId
    );
    return filterModelsBySearch(authFilteredModels, searchQuery);
  }, [models, providerAuthMap, currentProvider, currentModelId, searchQuery]);
}

export function useModelSwitcher(sessionId: string | null): UseModelSwitcherResult {
  const [currentModel, setCurrentModel] = useState<string>('');
  const [currentModelInfo, setCurrentModelInfo] = useState<ModelInfo | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [switching, setSwitching] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadModelInfo = useCallback(async () => {
    try {
      setLoading(true);
      const hub = connectionManager.getHubIfConnected();
      if (!hub) return;

      let fetchedModelId = '';
      let fetchedProvider = '';
      let fetchedModelInfo: ModelInfo | null = null;
      if (sessionId) {
        try {
          const {
            currentModel: modelId,
            currentProvider,
            modelInfo,
          } = (await hub.request('session.model.get', { sessionId })) as {
            currentModel: string;
            currentProvider: string;
            modelInfo: ModelInfo | null;
          };
          fetchedModelId = modelId;
          fetchedProvider = currentProvider;
          fetchedModelInfo = modelInfo;
          setCurrentModel(modelId);
          setCurrentModelInfo(modelInfo);
        } catch {}
      }

      const { models } = (await hub.request('models.list', {
        useCache: true,
      })) as { models: RawModelEntry[] };

      const modelInfos = mapRawModelsToModelInfos(models);
      setAvailableModels(modelInfos);

      if (fetchedModelId && fetchedProvider && !fetchedModelInfo) {
        const matched = modelInfos.find(
          (m) => m.id === fetchedModelId && m.provider === fetchedProvider
        );
        if (matched) setCurrentModelInfo(matched);
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const isConnected = connectionState.value === 'connected';
  useEffect(() => {
    if (isConnected) {
      loadModelInfo();
    }
  }, [loadModelInfo, isConnected]);

  useEffect(() => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;
    const unsub = hub.onEvent('providers.changed', () => {
      loadModelInfo();
    });
    return () => {
      unsub();
    };
  }, [loadModelInfo, connectionState.value]);

  const switchModel = useCallback(
    async (model: ModelInfo) => {
      if (!model.provider) {
        toast.error('Model provider information is missing');
        return;
      }

      if (model.id === currentModel && model.provider === currentModelInfo?.provider) {
        toast.info(`Already using ${currentModelInfo?.name || currentModel}`);
        return;
      }

      try {
        setSwitching(true);
        const hub = connectionManager.getHubIfConnected();
        if (!hub) {
          toast.error('Not connected to server');
          return;
        }

        const result = (await hub.request('session.model.switch', {
          sessionId,
          model: model.id,
          provider: model.provider,
        })) as {
          success: boolean;
          model: string;
          error?: string;
        };

        if (result.success) {
          setCurrentModel(result.model);
          const newModelInfo =
            availableModels.find((m) => m.id === result.model && m.provider === model.provider) ??
            availableModels.find((m) => m.id === result.model);
          setCurrentModelInfo(newModelInfo || null);
          toast.success(`Switched to ${newModelInfo?.name || result.model}`);
        } else {
          toast.error(result.error || 'Failed to switch model');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to switch model';
        toast.error(errorMessage);
      } finally {
        setSwitching(false);
      }
    },
    [sessionId, currentModel, currentModelInfo, availableModels]
  );

  return {
    currentModel,
    currentModelInfo,
    availableModels,
    switching,
    loading,
    switchModel,
    reload: loadModelInfo,
  };
}
