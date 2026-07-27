/**
 * useModelSwitcher Hook
 *
 * Manages model information loading and switching for a session.
 * Handles fetching current model, available models list, and switching logic.
 *
 * @example
 * ```typescript
 * const {
 *   currentModel,
 *   currentModelInfo,
 *   availableModels,
 *   switching,
 *   loading,
 *   switchModel,
 * } = useModelSwitcher(sessionId);
 * ```
 */

import { useState, useEffect, useCallback, useMemo } from 'preact/hooks';
import type { ModelInfo } from '@hyperneo/shared';
import type { ProviderAuthStatus } from '@hyperneo/shared/provider';
import { connectionManager } from '../lib/connection-manager';
import { connectionState } from '../lib/state';
import { toast } from '../lib/toast';

export interface UseModelSwitcherResult {
  /** Current model ID */
  currentModel: string;
  /** Current model info (null if not loaded) */
  currentModelInfo: ModelInfo | null;
  /** List of available models */
  availableModels: ModelInfo[];
  /** Whether a model switch is in progress */
  switching: boolean;
  /** Whether models are being loaded */
  loading: boolean;
  /** Switch to a different model */
  switchModel: (model: ModelInfo) => Promise<void>;
  /** Reload model info */
  reload: () => Promise<void>;
}

/** Model family icons for visual hierarchy */
export const MODEL_FAMILY_ICONS: Record<string, string> = {
  opus: '🧠',
  sonnet: '💎',
  haiku: '⚡',
  glm: '🌐',
  kimi: '🌙',
  minimax: '🔥',
  openrouter: '🧭',
  gpt: '🔮',
  // Default icon for unknown families
  __default__: '💎',
};

/**
 * Get the icon for a model family with fallback to default
 */
export function getModelFamilyIcon(family: string): string {
  return MODEL_FAMILY_ICONS[family] || MODEL_FAMILY_ICONS.__default__;
}

/** Provider sort order for model picker grouping */
export const PROVIDER_ORDER: Record<string, number> = {
  anthropic: 0,
  'anthropic-copilot': 1,
  'anthropic-codex': 2,
  openrouter: 3,
  glm: 4,
  kimi: 5,
  minimax: 6,
};

/** Model family sort order (exported for shared use) */
export const FAMILY_ORDER: Record<string, number> = {
  opus: 0,
  sonnet: 1,
  haiku: 2,
  glm: 3,
  kimi: 4,
  minimax: 5,
  openrouter: 6,
  gpt: 7,
};

/** Raw model shape returned by the `models.list` RPC */
export interface RawModelEntry {
  id: string;
  display_name: string;
  description: string;
  alias?: string;
  provider?: string;
  contextWindow?: number;
  context_window?: number;
}

/**
 * Map raw `models.list` RPC entries to `ModelInfo` objects and sort them
 * by provider (PROVIDER_ORDER) then family (FAMILY_ORDER).
 *
 * This is the canonical mapping used by model selection surfaces so that
 * family detection and sort order stay in sync.
 */
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
    } else if (mid === 'openrouter/auto') {
      family = 'openrouter';
    } else if (mid.startsWith('gpt-') || mid.includes('/gpt')) {
      family = 'gpt';
    } else if (mid.includes('/')) {
      family = 'openrouter';
    }
    const contextWindow = m.contextWindow ?? m.context_window;
    // Provider precedence: backend-supplied provider wins. If missing, prefer
    // ID-based inference (mirrors backend `inferProviderForModel` rules so
    // edge cases like `openai/gpt-*`, `gpt-oss:*`, `kimi-*:latest`, and
    // `claude-*/preview` route correctly) before falling back to the
    // family map and finally anthropic. Without this, dropping the
    // provider field would lump GLM/Kimi/etc. models under Anthropic.
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

/** Map model family → owning provider for FE fallback inference. */
const PROVIDER_FROM_FAMILY: Record<string, string> = {
  glm: 'glm',
  kimi: 'kimi',
  minimax: 'minimax',
  gpt: 'anthropic-codex',
  openrouter: 'openrouter',
};

/**
 * Infer the owning provider purely from a model ID string.
 *
 * Used only as a defensive fallback when the backend payload omits a provider
 * tag. The backend is the source of truth — this exists so a missing or
 * stale provider field never makes a non-Anthropic model appear under the
 * Anthropic group in the picker.
 *
 * Rules mirror the daemon's `inferProviderForModel` (registry.ts) so the
 * frontend fallback never disagrees with backend routing:
 *   - canonical `claude-*` always stays anthropic, including slash-suffixed
 *     variants like `claude-sonnet-4.6/preview`
 *   - Ollama Cloud claims any `:cloud` suffix (catches `openrouter`-style
 *     refs too, e.g. `foo:cloud`) — mirrors daemon precedence
 *   - `qwen*:NNNb` (large size) → ollama-cloud, other `qwen*:` → ollama
 *   - `gpt-oss:NNNb` → ollama-cloud, other `gpt-oss:` → ollama or ollama-cloud
 *     depending on `-cloud` suffix
 *   - slash refs (`openai/gpt-5.4`, `google/gemma-4-31b:free`) → openrouter
 *   - colon-tagged variants of `kimi-*`/`moonshot-*` (e.g. `kimi-k2:latest`)
 *     fall through to ollama; bare prefixes (`kimi-k2`) → kimi
 */
export function inferProviderFromModelId(modelId: string): string | undefined {
  const id = modelId.toLowerCase();

  // Anthropic claims canonical claude-* IDs — including slash-suffixed variants
  if (id.startsWith('claude-')) return 'anthropic';

  // Ollama-Cloud explicit suffix wins even on slash refs (mirrors backend order)
  if (id === 'ollama-cloud' || id.endsWith(':cloud')) return 'ollama-cloud';

  // Specific Ollama families with colon-size routing
  if (/^qwen[\w.-]*:[1-9]\d{2,}b$/i.test(id)) return 'ollama-cloud';
  if (/^qwen[\w.-]*:/i.test(id)) return 'ollama';
  if (/^gpt-oss:[1-9]\d{2,}b$/i.test(id)) return 'ollama-cloud';
  if (id.startsWith('gpt-oss:')) return id.endsWith('-cloud') ? 'ollama-cloud' : 'ollama';

  // Slash refs (e.g. `openai/gpt-5.4`, `google/gemma-4-31b:free`) go to OpenRouter.
  // Must precede the generic colon→ollama fallback so OpenRouter IDs that
  // happen to carry tier suffixes like `:free` are not misrouted to Ollama.
  if (id === 'openrouter/auto' || id.includes('/')) return 'openrouter';

  // Remaining colon-tagged IDs are local Ollama tags (e.g. `kimi-k2:latest`,
  // `moonshot-v1:latest`). The colon-exclusion mirrors daemon kimi routing.
  if (id.includes(':')) return 'ollama';

  if (id.startsWith('glm-') || id === 'glm') return 'glm';
  if (id.startsWith('moonshot-') || id.startsWith('kimi-') || id === 'kimi' || id === 'k3')
    return 'kimi';
  if (id.startsWith('minimax-') || id === 'minimax') return 'minimax';
  if (id === 'ollama') return 'ollama';
  if (id.startsWith('gpt-')) return 'anthropic-codex';
  return undefined;
}

/**
 * Group models by their provider, preserving insertion order of the input array.
 * Provider group ordering depends on the caller supplying a pre-sorted array —
 * `loadModelInfo` sorts by PROVIDER_ORDER before calling this function.
 * Models within each group retain their input order (family-sorted by the caller).
 */
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

/** Provider display labels for UI */
export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  glm: 'Z.ai',
  kimi: 'Kimi',
  minimax: 'MiniMax',
  openrouter: 'OpenRouter',
  'anthropic-copilot': 'Copilot',
  'anthropic-codex': 'Codex',
  // Note: keep in sync with PROVIDER_ORDER above
};

/**
 * Get the display label for a provider, with friendly fallback for
 * `custom:<id>` providers (renders as "Custom — <id>").
 */
export function getProviderLabel(provider: string): string {
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
  if (provider.startsWith('custom:')) {
    const slug = provider.slice('custom:'.length);
    return `Custom — ${slug}`;
  }
  return provider;
}

/**
 * Filter a model list for display in the model picker, respecting auth status.
 *
 * Rules:
 * - Models from authenticated providers are always shown.
 * - Models from unauthenticated providers are hidden, UNLESS the model is the
 *   currently active one (to avoid confusing the user about their session).
 * - Models from providers with `needsRefresh: true` are shown (callers should
 *   add a visual warning badge).
 * - Models from providers absent from the auth map are shown (optimistic).
 */
export function filterModelsForPicker(
  models: ModelInfo[],
  providerAuthMap: Map<string, ProviderAuthStatus>,
  currentProvider?: string
): ModelInfo[] {
  return models.filter((m) => {
    const auth = providerAuthMap.get(m.provider);
    if (!auth) return true; // provider unknown → optimistic show
    if (m.provider === currentProvider) return true; // always keep active provider
    return auth.isAuthenticated; // hide unauthenticated (needsRefresh stays visible)
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
  searchQuery: string
): ModelInfo[] {
  return useMemo(() => {
    const authFilteredModels = filterModelsForPicker(models, providerAuthMap, currentProvider);
    return filterModelsBySearch(authFilteredModels, searchQuery);
  }, [models, providerAuthMap, currentProvider, searchQuery]);
}

/**
 * Hook for managing model switching
 *
 * @param sessionId - Current session ID
 */
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

      // Fetch current model (skip when no sessionId; best effort otherwise)
      if (sessionId) {
        try {
          const { currentModel: modelId, modelInfo } = (await hub.request('session.model.get', {
            sessionId,
          })) as {
            currentModel: string;
            modelInfo: ModelInfo | null;
          };
          setCurrentModel(modelId);
          setCurrentModelInfo(modelInfo);
        } catch {
          // Session not found or not started yet — keep defaults
        }
      }

      // Fetch available models (independent of session state)
      const { models } = (await hub.request('models.list', {
        useCache: true,
      })) as { models: RawModelEntry[] };

      setAvailableModels(mapRawModelsToModelInfos(models));
    } catch {
      // Error handled silently - loading state will be cleared
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Load when connected and on session change.
  // connectionState.value triggers a retry when the WebSocket connects
  // after mount (e.g. fresh page load where ChatContainer renders before
  // the hub is ready).
  const isConnected = connectionState.value === 'connected';
  useEffect(() => {
    if (isConnected) {
      loadModelInfo();
    }
  }, [loadModelInfo, isConnected]);

  // Reload model list when providers change (added/removed/updated).
  // Include connectionState so we re-subscribe after the WebSocket connects
  // following a fresh page load where the hook rendered before the hub was ready.
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
          // Match by both id AND provider to avoid returning the wrong entry when
          // two providers share the same canonical model ID (e.g. anthropic and
          // anthropic-copilot both expose claude-sonnet-4.6).
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
