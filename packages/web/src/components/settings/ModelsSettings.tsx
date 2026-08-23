import { useEffect, useRef, useState } from 'preact/hooks';
import type { FallbackModelEntry, ModelInfo } from '@hyperneo/shared';
import type { ProviderAuthStatus } from '@hyperneo/shared/provider';
import { connectionState, globalSettings } from '../../lib/state.ts';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import { connectionManager } from '../../lib/connection-manager';
import {
  groupModelsByProvider,
  filterModelsForPicker,
  filterModelsBySearch,
  mapRawModelsToModelInfos,
  PROVIDER_LABELS,
  getProviderLabel,
} from '../../hooks/useModelSwitcher.ts';
import { SettingsSection } from './SettingsSection.tsx';
import { Spinner } from '../ui/Spinner';
import { Button } from '../ui/Button';
import { listProviderAuthStatus } from '../../lib/api-helpers.ts';
import { ProviderLogo } from '../ProviderLogo.tsx';

interface RawModelEntry {
  id: string;
  display_name: string;
  description: string;
  alias?: string;
  provider?: string;
}

function ChevronUpIcon() {
  return (
    <svg class="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg class="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function XIcon({ class: cls }: { class?: string }) {
  return (
    <svg
      class={cls ?? 'w-4 h-4 text-gray-400'}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M6 18L18 6M6 6l12 12"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg class="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M15.232 5.232l3.536 3.536M9 11l6.536-6.536a2 2 0 012.828 2.828L11.828 13.828a2 2 0 01-1.414.586H8v-2.414a2 2 0 01.586-1.414z"
      />
    </svg>
  );
}

interface ModelPickerModalProps {
  title: string;
  groupedModels: Map<string, ModelInfo[]>;
  providerAuthStatuses: Map<string, ProviderAuthStatus>;
  excludeModels: FallbackModelEntry[];
  onSelect: (model: ModelInfo) => void;
  onClose: () => void;
}

function ModelPickerModal({
  title,
  groupedModels,
  providerAuthStatuses,
  excludeModels,
  onSelect,
  onClose,
}: ModelPickerModalProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const allModels = Array.from(groupedModels.values()).flat();
  const searchFilteredModels = filterModelsBySearch(allModels, searchQuery);
  const remaining = searchFilteredModels.filter(
    (m) => !excludeModels.some((e) => e.model === m.id && e.provider === m.provider)
  );
  const hasUnselectedModels = allModels.some(
    (m) => !excludeModels.some((e) => e.model === m.id && e.provider === m.provider)
  );
  const visibleGroupedModels = groupModelsByProvider(remaining);

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div class="bg-dark-850 border border-dark-600 rounded-lg shadow-xl w-80 max-h-[80vh] overflow-hidden flex flex-col">
        <div class="flex items-center justify-between px-4 py-3 border-b border-dark-700">
          <h3 class="text-sm font-medium text-gray-100">{title}</h3>
          <button class="p-1 rounded hover:bg-dark-700" onClick={onClose}>
            <XIcon />
          </button>
        </div>

        <div class="px-3 py-3 border-b border-dark-700">
          <input
            type="search"
            value={searchQuery}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
            placeholder="Search models..."
            aria-label="Search models"
            class="w-full bg-dark-900 border border-dark-600 rounded px-2 py-1.5 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none focus:border-blue-500"
          />
        </div>

        <div class="flex-1 overflow-y-auto py-2">
          {Array.from(visibleGroupedModels.entries()).map(([provider, models]) => {
            const authStatus = providerAuthStatuses.get(provider);
            const isAuthenticated = authStatus?.isAuthenticated ?? false;

            return (
              <div key={provider}>
                <div class="px-4 py-1.5 text-xs font-semibold text-gray-400">
                  {PROVIDER_LABELS[provider] || getProviderLabel(provider)}
                  {!isAuthenticated && <span class="text-gray-600 ml-1">(not authenticated)</span>}
                </div>
                {models.map((model) => {
                  return (
                    <button
                      key={`${model.provider}:${model.id}`}
                      class="w-full text-left px-4 py-2 text-sm flex items-center gap-2 hover:bg-dark-700 transition-colors"
                      onClick={() => onSelect(model)}
                    >
                      <ProviderLogo provider={model.provider} class="h-4 w-4" />
                      <span class="flex-1 text-gray-200 truncate">{model.name}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}

          {remaining.length === 0 && (
            <div class="px-4 py-4 text-sm text-gray-500 text-center">
              {searchQuery.trim() && hasUnselectedModels
                ? 'No matching models'
                : 'All available models are already selected'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface FallbackChainEditorProps {
  models: FallbackModelEntry[];
  availableModels: ModelInfo[];
  isUpdating: boolean;
  onMove: (index: number, direction: 'up' | 'down') => void;
  onRemove: (index: number) => void;
}

function FallbackChainEditor({
  models,
  availableModels,
  isUpdating,
  onMove,
  onRemove,
}: FallbackChainEditorProps) {
  const getDisplayInfo = (entry: FallbackModelEntry) => {
    const model = availableModels.find(
      (m) => m.id === entry.model && m.provider === entry.provider
    );
    return { name: model?.name ?? entry.model, family: model?.family ?? 'sonnet' };
  };

  return (
    <div class="space-y-2">
      {models.map((entry, index) => {
        const displayInfo = getDisplayInfo(entry);
        return (
          <div
            key={`${entry.provider}:${entry.model}`}
            class="flex items-center gap-2 bg-dark-800 border border-dark-700 rounded-lg px-3 py-2"
          >
            <span class="text-xs text-gray-500 font-medium w-4">{index + 1}.</span>
            <ProviderLogo provider={entry.provider} class="h-4 w-4" />
            <div class="flex-1 min-w-0">
              <div class="text-sm text-gray-200 truncate">{displayInfo.name}</div>
              <div class="text-xs text-gray-500">
                {PROVIDER_LABELS[entry.provider] || getProviderLabel(entry.provider)}
              </div>
            </div>
            <div class="flex items-center gap-1">
              <button
                class="p-1 rounded hover:bg-dark-700 disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={() => onMove(index, 'up')}
                disabled={index === 0 || isUpdating}
                title="Move up"
              >
                <ChevronUpIcon />
              </button>
              <button
                class="p-1 rounded hover:bg-dark-700 disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={() => onMove(index, 'down')}
                disabled={index === models.length - 1 || isUpdating}
                title="Move down"
              >
                <ChevronDownIcon />
              </button>
            </div>
            <button
              class="p-1 rounded hover:bg-red-900/30 disabled:opacity-30 disabled:cursor-not-allowed"
              onClick={() => onRemove(index)}
              disabled={isUpdating}
              title="Remove"
            >
              <XIcon class="w-4 h-4 text-red-400" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

interface OverrideEditorModalProps {
  editingKey: string | null;
  availableModels: ModelInfo[];
  groupedModels: Map<string, ModelInfo[]>;
  providerAuthStatuses: Map<string, ProviderAuthStatus>;
  existingMapKeys: string[];
  initialChain: FallbackModelEntry[];
  onSave: (sourceKey: string, chain: FallbackModelEntry[]) => void;
  onClose: () => void;
}

function OverrideEditorModal({
  editingKey,
  availableModels,
  groupedModels,
  providerAuthStatuses,
  existingMapKeys,
  initialChain,
  onSave,
  onClose,
}: OverrideEditorModalProps) {
  const [sourceKey, setSourceKey] = useState<string>(editingKey ?? '');
  const [chain, setChain] = useState<FallbackModelEntry[]>(initialChain);
  const [showSourcePicker, setShowSourcePicker] = useState(editingKey === null);
  const [showAddFallbackPicker, setShowAddFallbackPicker] = useState(false);

  const getDisplayInfo = (key: string) => {
    const [provider, ...rest] = key.split('/');
    const modelId = rest.join('/');
    const model = availableModels.find((m) => m.id === modelId && m.provider === provider);
    return model
      ? { name: model.name, family: model.family, provider }
      : { name: modelId || key, family: 'sonnet', provider };
  };

  const handleSelectSource = (model: ModelInfo) => {
    const key = `${model.provider}/${model.id}`;
    setSourceKey(key);
    setShowSourcePicker(false);
  };

  const handleAddFallback = (model: ModelInfo) => {
    if (chain.some((e) => e.model === model.id && e.provider === model.provider)) return;
    setChain((prev) => [...prev, { model: model.id, provider: model.provider ?? 'anthropic' }]);
    setShowAddFallbackPicker(false);
  };

  const handleMoveChain = (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= chain.length) return;
    const next = [...chain];
    [next[index], next[newIndex]] = [next[newIndex], next[index]];
    setChain(next);
  };

  const handleRemoveChain = (index: number) => {
    setChain((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = () => {
    if (!sourceKey) {
      toast.error('Please select a source model');
      return;
    }
    onSave(sourceKey, chain);
  };

  const excludeFromSourcePicker: FallbackModelEntry[] = existingMapKeys
    .filter((k) => k !== editingKey)
    .map((k) => {
      const [provider, ...rest] = k.split('/');
      return { provider, model: rest.join('/') };
    });

  const sourceInfo = sourceKey ? getDisplayInfo(sourceKey) : null;

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div class="bg-dark-850 border border-dark-600 rounded-lg shadow-xl w-96 max-h-[85vh] overflow-hidden flex flex-col">
        <div class="flex items-center justify-between px-4 py-3 border-b border-dark-700">
          <h3 class="text-sm font-medium text-gray-100">
            {editingKey ? 'Edit Override' : 'Add Model-Specific Override'}
          </h3>
          <button class="p-1 rounded hover:bg-dark-700" onClick={onClose}>
            <XIcon />
          </button>
        </div>

        <div class="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">Source model</label>
            {sourceInfo ? (
              <div class="flex items-center gap-2 bg-dark-800 border border-dark-700 rounded-lg px-3 py-2">
                <ProviderLogo provider={sourceInfo.provider} class="h-4 w-4" />
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-gray-200 truncate">{sourceInfo.name}</div>
                  <div class="text-xs text-gray-500">
                    {PROVIDER_LABELS[sourceInfo.provider] || getProviderLabel(sourceInfo.provider)}
                  </div>
                </div>
                {editingKey === null && (
                  <button
                    class="p-1 rounded hover:bg-dark-700"
                    onClick={() => setShowSourcePicker(true)}
                    title="Change"
                  >
                    <PencilIcon />
                  </button>
                )}
              </div>
            ) : (
              <button
                class="w-full flex items-center gap-2 px-3 py-2 text-sm text-blue-400 hover:text-blue-300 hover:bg-dark-800 rounded-lg border border-dashed border-dark-600 hover:border-dark-500 transition-colors"
                onClick={() => setShowSourcePicker(true)}
              >
                <PlusIcon />
                Select source model
              </button>
            )}
          </div>

          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">Fallback chain</label>
            {chain.length === 0 ? (
              <p class="text-xs text-gray-500 italic mb-2">No fallback models in this chain</p>
            ) : (
              <FallbackChainEditor
                models={chain}
                availableModels={availableModels}
                isUpdating={false}
                onMove={handleMoveChain}
                onRemove={handleRemoveChain}
              />
            )}
            <button
              class="mt-2 flex items-center gap-2 px-3 py-2 text-sm text-blue-400 hover:text-blue-300 hover:bg-dark-800 rounded-lg border border-dashed border-dark-600 hover:border-dark-500 transition-colors"
              onClick={() => setShowAddFallbackPicker(true)}
            >
              <PlusIcon />
              Add Fallback Model
            </button>
          </div>
        </div>

        <div class="px-4 py-3 border-t border-dark-700 flex justify-end gap-2">
          <button
            class="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 rounded-lg hover:bg-dark-700 transition-colors"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            class="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
            onClick={handleSave}
            disabled={!sourceKey}
          >
            Save
          </button>
        </div>
      </div>

      {showSourcePicker && (
        <ModelPickerModal
          title="Select Source Model"
          groupedModels={groupedModels}
          providerAuthStatuses={providerAuthStatuses}
          excludeModels={excludeFromSourcePicker}
          onSelect={handleSelectSource}
          onClose={() => setShowSourcePicker(false)}
        />
      )}

      {showAddFallbackPicker && (
        <ModelPickerModal
          title="Add Fallback Model"
          groupedModels={groupedModels}
          providerAuthStatuses={providerAuthStatuses}
          excludeModels={chain}
          onSelect={handleAddFallback}
          onClose={() => setShowAddFallbackPicker(false)}
        />
      )}
    </div>
  );
}

export function ModelsSettings() {
  const settings = globalSettings.value;
  const [fallbackModels, setFallbackModels] = useState<FallbackModelEntry[]>(
    settings?.fallbackModels ?? []
  );
  const [modelFallbackMap, setModelFallbackMap] = useState<Record<string, FallbackModelEntry[]>>(
    settings?.modelFallbackMap ?? {}
  );
  const [openRouterAllowlistText, setOpenRouterAllowlistText] = useState(
    (settings?.providerModelAllowlists?.openrouter ?? []).join('\n')
  );
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [providerAuthStatuses, setProviderAuthStatuses] = useState<Map<string, ProviderAuthStatus>>(
    new Map()
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [loadError, setLoadError] = useState<{ message: string; forceRefresh: boolean } | null>(
    null
  );
  const autoRetriedMessagesRef = useRef<Set<string>>(new Set());
  const fetchInFlightRef = useRef(false);
  const pendingForceRefreshRef = useRef(false);

  const [showAddModal, setShowAddModal] = useState(false);

  const [overrideModal, setOverrideModal] = useState<{
    open: boolean;
    editingKey: string | null;
  }>({ open: false, editingKey: null });

  useEffect(() => {
    if (settings) {
      setFallbackModels(settings.fallbackModels ?? []);
      setModelFallbackMap(settings.modelFallbackMap ?? {});
      setOpenRouterAllowlistText((settings.providerModelAllowlists?.openrouter ?? []).join('\n'));
    }
  }, [settings]);

  const fetchModels = async (forceRefresh: boolean) => {
    if (fetchInFlightRef.current) {
      if (forceRefresh) pendingForceRefreshRef.current = true;
      return;
    }

    fetchInFlightRef.current = true;
    setLoading(true);
    try {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        setLoadError({ message: 'Not connected to server', forceRefresh });
        return;
      }

      const [modelsResponse, authResponse] = await Promise.all([
        hub.request(
          'models.list',
          forceRefresh ? { forceRefresh: true } : { useCache: true }
        ) as Promise<{ models: RawModelEntry[] }>,
        listProviderAuthStatus().catch(() => ({ providers: [] })),
      ]);

      setAvailableModels(mapRawModelsToModelInfos(modelsResponse.models));

      const authMap = new Map<string, ProviderAuthStatus>();
      for (const p of authResponse.providers) {
        authMap.set(p.id, p);
      }
      setProviderAuthStatuses(authMap);
      setLoadError(null);
    } catch (e) {
      setLoadError({
        message: e instanceof Error ? e.message : 'Failed to load models',
        forceRefresh,
      });
      throw e;
    } finally {
      fetchInFlightRef.current = false;
      if (pendingForceRefreshRef.current) {
        pendingForceRefreshRef.current = false;
        loadModels(true);
      } else {
        setLoading(false);
      }
    }
  };

  const saveOpenRouterAllowlist = async () => {
    const openrouter = Array.from(
      new Set(
        openRouterAllowlistText
          .split(/[\n,]/)
          .map((id) => id.trim())
          .filter(Boolean)
      )
    );
    const nextAllowlists = { ...settings?.providerModelAllowlists };
    if (openrouter.length > 0) {
      nextAllowlists.openrouter = openrouter;
    } else {
      delete nextAllowlists.openrouter;
    }

    setIsUpdating(true);
    try {
      await updateGlobalSettings({ providerModelAllowlists: nextAllowlists });
      setOpenRouterAllowlistText(openrouter.join('\n'));
      toast.success('OpenRouter model allowlist updated');
      await fetchModels(true);
    } catch {
      toast.error('Failed to update OpenRouter model allowlist');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetchModels(true);
    } catch {
      toast.error('Failed to refresh models');
    } finally {
      setRefreshing(false);
    }
  };

  const isConnected = connectionState.value === 'connected';

  const loadModels = (forceRefresh: boolean) => {
    void fetchModels(forceRefresh).catch(() => {});
  };

  useEffect(() => {
    loadModels(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loadError) {
      autoRetriedMessagesRef.current.clear();
      return;
    }
    if (!isConnected) return;
    if (autoRetriedMessagesRef.current.has(loadError.message)) return;
    autoRetriedMessagesRef.current.add(loadError.message);
    loadModels(loadError.forceRefresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, loadError]);

  const saveFallbackModels = async (models: FallbackModelEntry[]) => {
    setIsUpdating(true);
    try {
      await updateGlobalSettings({ fallbackModels: models });
      setFallbackModels(models);
      toast.success('Fallback models updated');
    } catch {
      toast.error('Failed to update fallback models');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleRemove = async (index: number) => {
    const newModels = [...fallbackModels];
    newModels.splice(index, 1);
    await saveFallbackModels(newModels);
  };

  const handleMove = async (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= fallbackModels.length) return;

    const newModels = [...fallbackModels];
    [newModels[index], newModels[newIndex]] = [newModels[newIndex], newModels[index]];
    await saveFallbackModels(newModels);
  };

  const handleAdd = async (model: ModelInfo) => {
    if (fallbackModels.some((m) => m.model === model.id && m.provider === model.provider)) {
      toast.error('Model is already in the fallback chain');
      return;
    }

    const newModels = [
      ...fallbackModels,
      { model: model.id, provider: model.provider ?? 'anthropic' },
    ];
    await saveFallbackModels(newModels);
    setShowAddModal(false);
  };

  const saveModelFallbackMap = async (map: Record<string, FallbackModelEntry[]>) => {
    setIsUpdating(true);
    try {
      await updateGlobalSettings({ modelFallbackMap: map });
      setModelFallbackMap(map);
      toast.success('Model overrides updated');
    } catch {
      toast.error('Failed to update model overrides');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleSaveOverride = async (sourceKey: string, chain: FallbackModelEntry[]) => {
    const newMap = { ...modelFallbackMap, [sourceKey]: chain };
    await saveModelFallbackMap(newMap);
    setOverrideModal({ open: false, editingKey: null });
  };

  const handleDeleteOverride = async (key: string) => {
    const newMap = { ...modelFallbackMap };
    delete newMap[key];
    await saveModelFallbackMap(newMap);
  };

  const getModelDisplayInfo = (entry: FallbackModelEntry): { name: string; family: string } => {
    const model = availableModels.find(
      (m) => m.id === entry.model && m.provider === entry.provider
    );
    return { name: model?.name ?? entry.model, family: model?.family ?? 'sonnet' };
  };

  const getKeyDisplayInfo = (key: string) => {
    const [provider, ...rest] = key.split('/');
    const modelId = rest.join('/');
    const model = availableModels.find((m) => m.id === modelId && m.provider === provider);
    return model
      ? { name: model.name, family: model.family, provider }
      : { name: modelId || key, family: 'sonnet', provider: provider ?? '' };
  };

  const filteredModels = filterModelsForPicker(availableModels, providerAuthStatuses, undefined);
  const groupedModels = groupModelsByProvider(filteredModels);
  const overrideEntries = Object.entries(modelFallbackMap);

  return (
    <SettingsSection title="Models">
      <div class="space-y-3 rounded-lg border border-white/[0.08] bg-white/[0.025] px-4 py-3">
        <div>
          <h4 class="text-sm font-medium text-gray-300">OpenRouter Model Allowlist</h4>
          <p class="text-xs text-gray-500 mt-0.5">
            OpenRouter does not expose dashboard-enabled account models through its public API. Add
            one model ID per line to limit model pickers and runtime validation to models you have
            enabled on OpenRouter.
          </p>
        </div>
        <textarea
          value={openRouterAllowlistText}
          onInput={(e) => setOpenRouterAllowlistText(e.currentTarget.value)}
          placeholder={`xai/grok-4.3\nqwen/qwen3.6-max-preview\ndeepseek/deepseek-v4-pro`}
          class="w-full h-28 bg-dark-950/60 border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:border-blue-500 font-mono"
        />
        <Button
          variant="primary"
          size="xs"
          onClick={saveOpenRouterAllowlist}
          disabled={isUpdating}
          loading={isUpdating}
        >
          Save OpenRouter allowlist
        </Button>
      </div>
      <div class="flex items-center justify-end">
        <Button
          variant="secondary"
          size="xs"
          onClick={handleRefresh}
          disabled={loading || refreshing}
          loading={refreshing}
        >
          Refresh models
        </Button>
      </div>
      {loadError && (
        <div
          class="flex items-center justify-between gap-3 rounded-lg border border-red-300/20 px-4 py-3 text-sm text-red-200"
          role="alert"
        >
          <span>{loadError.message}</span>
          <Button
            variant="ghost"
            size="xs"
            loading={loading}
            disabled={refreshing}
            onClick={() => loadModels(loadError.forceRefresh)}
          >
            Retry
          </Button>
        </div>
      )}
      <div class="space-y-3">
        <div class="space-y-3 rounded-lg border border-white/[0.08] bg-white/[0.025] px-4 py-3">
          <div>
            <h4 class="text-sm font-medium text-gray-300">Default Fallback Chain</h4>
            <p class="text-xs text-gray-500 mt-0.5">
              Applies to all models that don&apos;t have a specific override below.
            </p>
          </div>

          {loading ? (
            <div class="flex items-center gap-2 text-xs text-gray-500">
              <Spinner size="xs" />
              <span>Loading models...</span>
            </div>
          ) : fallbackModels.length === 0 ? (
            <div class="text-xs text-gray-500 italic">No fallback models configured</div>
          ) : (
            <FallbackChainEditor
              models={fallbackModels}
              availableModels={availableModels}
              isUpdating={isUpdating}
              onMove={handleMove}
              onRemove={handleRemove}
            />
          )}

          <button
            class="flex items-center gap-2 px-3 py-2 text-sm text-blue-400 hover:text-blue-300 hover:bg-dark-800 rounded-lg border border-dashed border-dark-600 hover:border-dark-500 transition-colors disabled:opacity-50"
            onClick={() => setShowAddModal(true)}
            disabled={loading}
          >
            <PlusIcon />
            Add Fallback Model
          </button>
        </div>

        <div class="space-y-3 rounded-lg border border-white/[0.08] bg-white/[0.025] px-4 py-3">
          <div>
            <h4 class="text-sm font-medium text-gray-300">Model-Specific Overrides</h4>
            <p class="text-xs text-gray-500 mt-0.5">
              Override the default chain for a specific model. Takes priority when that model hits a
              limit.
            </p>
          </div>

          {loading ? (
            <div class="flex items-center gap-2 text-xs text-gray-500">
              <Spinner size="xs" />
              <span>Loading models...</span>
            </div>
          ) : overrideEntries.length === 0 ? (
            <div class="text-xs text-gray-500 italic">
              No model-specific overrides. Add one to override the default chain for a specific
              model.
            </div>
          ) : (
            <div class="space-y-2">
              {overrideEntries.map(([key, chain]) => {
                const sourceInfo = getKeyDisplayInfo(key);
                return (
                  <div key={key} class="bg-dark-800 border border-dark-700 rounded-lg px-3 py-2">
                    <div class="flex items-center gap-2">
                      <ProviderLogo provider={sourceInfo.provider} class="h-4 w-4" />
                      <div class="flex-1 min-w-0">
                        <div class="text-sm text-gray-200 truncate">{sourceInfo.name}</div>
                        <div class="text-xs text-gray-500">
                          {PROVIDER_LABELS[sourceInfo.provider] ||
                            getProviderLabel(sourceInfo.provider)}
                        </div>
                      </div>
                      <button
                        class="p-1 rounded hover:bg-dark-700 disabled:opacity-30"
                        onClick={() => setOverrideModal({ open: true, editingKey: key })}
                        disabled={isUpdating}
                        title="Edit"
                      >
                        <PencilIcon />
                      </button>
                      <button
                        class="p-1 rounded hover:bg-red-900/30 disabled:opacity-30"
                        onClick={() => handleDeleteOverride(key)}
                        disabled={isUpdating}
                        title="Delete"
                      >
                        <XIcon class="w-4 h-4 text-red-400" />
                      </button>
                    </div>

                    {chain.length > 0 && (
                      <div class="mt-2 flex flex-wrap gap-1.5">
                        {chain.map((entry, i) => {
                          const info = getModelDisplayInfo(entry);
                          return (
                            <span
                              key={`${entry.provider}:${entry.model}`}
                              class="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-dark-700 text-gray-300 rounded-full"
                            >
                              <span class="text-gray-500">{i + 1}.</span>
                              <ProviderLogo provider={entry.provider} class="h-3 w-3" />
                              <span class="truncate max-w-[120px]">{info.name}</span>
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {chain.length === 0 && (
                      <p class="mt-1.5 text-xs text-gray-600 italic">Empty chain</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <button
            class="flex items-center gap-2 px-3 py-2 text-sm text-blue-400 hover:text-blue-300 hover:bg-dark-800 rounded-lg border border-dashed border-dark-600 hover:border-dark-500 transition-colors disabled:opacity-50"
            onClick={() => setOverrideModal({ open: true, editingKey: null })}
            disabled={loading}
          >
            <PlusIcon />
            Add Override
          </button>
        </div>
      </div>

      {showAddModal && (
        <ModelPickerModal
          title="Add Fallback Model"
          groupedModels={groupedModels}
          providerAuthStatuses={providerAuthStatuses}
          excludeModels={fallbackModels}
          onSelect={handleAdd}
          onClose={() => setShowAddModal(false)}
        />
      )}

      {overrideModal.open && (
        <OverrideEditorModal
          editingKey={overrideModal.editingKey}
          availableModels={availableModels}
          groupedModels={groupedModels}
          providerAuthStatuses={providerAuthStatuses}
          existingMapKeys={Object.keys(modelFallbackMap)}
          initialChain={
            overrideModal.editingKey ? (modelFallbackMap[overrideModal.editingKey] ?? []) : []
          }
          onSave={handleSaveOverride}
          onClose={() => setOverrideModal({ open: false, editingKey: null })}
        />
      )}
    </SettingsSection>
  );
}
