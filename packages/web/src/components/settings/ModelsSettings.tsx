import { NeoFrontSettings } from './NeoFrontSettings.tsx';
import { MODEL_LIST_REQUEST_TIMEOUT_MS } from '@hyperneo/shared/provider';
import {
  ModelChevronUpIcon as ChevronUpIcon,
  ModelChevronDownIcon as ChevronDownIcon,
  ModelXIcon as XIcon,
  ModelPlusIcon as PlusIcon,
  ModelPencilIcon as PencilIcon,
} from '../icons/panel-icons.tsx';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  AUTO_COMPACT_PERCENT_DEFAULT,
  AUTO_COMPACT_PERCENT_MIN,
  AUTO_COMPACT_PERCENT_MAX,
  resolveAutoCompactPercent,
  findSameModel,
  normalizeThinkingLevel,
  PROVIDER_THINKING_MODES,
  THINKING_LEVEL_EFFORT,
  THINKING_LEVEL_LABELS,
  THINKING_OPTIONS,
  type FallbackModelEntry,
  type ModelInfo,
  type NeoModelPreference,
  type ThinkingLevel,
} from '@hyperneo/shared';
import type { ComponentChildren } from 'preact';
import { invokeOperation } from '../../lib/operations.ts';
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
  findDefaultModel,
} from '../../hooks/useModelSwitcher.ts';
import { SettingsSection } from './SettingsSection.tsx';
import { Spinner } from '../ui/Spinner';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal.tsx';
import { listProviderAuthStatus } from '../../lib/api-helpers.ts';
import { ProviderLogo } from '../ProviderLogo.tsx';

interface RawModelEntry {
  id: string;
  display_name: string;
  description: string;
  alias?: string;
  provider?: string;
  autoCompactPercent?: number;
}

interface ModelPickerModalProps {
  title: string;
  groupedModels: Map<string, ModelInfo[]>;
  providerAuthStatuses: Map<string, ProviderAuthStatus>;
  excludeModels: FallbackModelEntry[];
  selectionDisabled?: boolean;
  onSelect: (model: ModelInfo) => void;
  onClose: () => void;
}

function ModelPickerModal({
  title,
  groupedModels,
  providerAuthStatuses,
  excludeModels,
  selectionDisabled = false,
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
      <div class="bg-surface-overlay border border-line-strong rounded-lg shadow-xl w-80 max-h-[80vh] overflow-hidden flex flex-col">
        <div class="flex items-center justify-between px-4 py-3 border-b border-line">
          <h3 class="text-sm font-medium text-fg">{title}</h3>
          <button class="p-1 rounded hover:bg-fill-strong" onClick={onClose}>
            <XIcon />
          </button>
        </div>

        <div class="px-3 py-3 border-b border-line">
          <input
            type="search"
            value={searchQuery}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
            placeholder="Search models..."
            aria-label="Search models"
            class="w-full bg-surface border border-line-strong rounded px-2 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent"
          />
        </div>

        <div class="flex-1 overflow-y-auto py-2">
          {selectionDisabled && (
            <p class="px-4 py-2 text-xs text-fg-faint">
              Wait or reconnect before selecting a model.
            </p>
          )}
          {Array.from(visibleGroupedModels.entries()).map(([provider, models]) => {
            const authStatus = providerAuthStatuses.get(provider);
            const isAuthenticated = authStatus?.isAuthenticated ?? false;

            return (
              <div key={provider}>
                <div class="px-4 py-1.5 text-xs font-semibold text-fg-muted">
                  {PROVIDER_LABELS[provider] || getProviderLabel(provider)}
                  {!isAuthenticated && <span class="text-fg-faint ml-1">(not authenticated)</span>}
                </div>
                {models.map((model) => {
                  const unavailable = model.available === false;
                  return (
                    <button
                      key={`${model.provider}:${model.id}`}
                      class={`w-full text-left px-4 py-2 text-sm flex items-center gap-2 transition-colors ${
                        unavailable || selectionDisabled
                          ? 'cursor-not-allowed opacity-50'
                          : 'hover:bg-fill-strong'
                      }`}
                      disabled={unavailable || selectionDisabled}
                      onClick={() => onSelect(model)}
                    >
                      <ProviderLogo provider={model.provider} class="h-4 w-4" />
                      <span class="flex-1 text-fg-soft truncate">{model.name}</span>
                      {unavailable && (
                        <span class="text-xs text-fg-faint" title="Not runnable on this account">
                          unavailable
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}

          {remaining.length === 0 && (
            <div class="px-4 py-4 text-sm text-fg-faint text-center">
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
  indexOffset?: number;
  availableModels: ModelInfo[];
  isUpdating: boolean;
  onMove: (index: number, direction: 'up' | 'down') => void;
  onRemove: (index: number) => void;
  controls?: (entry: FallbackModelEntry, index: number) => ComponentChildren;
  canRemove?: (index: number) => boolean;
}

function FallbackChainEditor({
  models,
  indexOffset = 0,
  availableModels,
  isUpdating,
  onMove,
  onRemove,
  controls,
  canRemove,
}: FallbackChainEditorProps) {
  const getDisplayInfo = (entry: FallbackModelEntry) => {
    const model = findSameModel(availableModels, entry);
    return { name: model?.name ?? entry.model, family: model?.family ?? 'sonnet' };
  };

  return (
    <div class="space-y-2">
      {models.map((entry, index) => {
        const displayInfo = getDisplayInfo(entry);
        return (
          <div
            key={`${entry.provider}:${entry.model}`}
            class="flex flex-wrap items-center gap-2 bg-surface-raised border border-line rounded-lg px-3 py-3"
          >
            <span class="text-xs text-fg-faint font-medium w-4">{index + indexOffset + 1}.</span>
            <ProviderLogo provider={entry.provider} class="h-4 w-4" />
            <div class="flex-1 min-w-0">
              <div class="text-sm text-fg-soft truncate">{displayInfo.name}</div>
              <div class="text-xs text-fg-faint">
                {PROVIDER_LABELS[entry.provider] || getProviderLabel(entry.provider)}
              </div>
            </div>
            <div
              class={`ml-auto flex max-w-full flex-wrap items-center justify-end gap-2 ${controls ? 'w-full border-t border-line pt-3' : ''}`}
            >
              {controls?.(entry, index + indexOffset)}
              <div class="flex items-center gap-1">
                <button
                  class="p-1 rounded hover:bg-fill-strong disabled:opacity-30 disabled:cursor-not-allowed"
                  onClick={() => onMove(index + indexOffset, 'up')}
                  disabled={(index === 0 && indexOffset === 0) || isUpdating}
                  title="Move up"
                >
                  <ChevronUpIcon />
                </button>
                <button
                  class="p-1 rounded hover:bg-fill-strong disabled:opacity-30 disabled:cursor-not-allowed"
                  onClick={() => onMove(index + indexOffset, 'down')}
                  disabled={index === models.length - 1 || isUpdating}
                  title="Move down"
                >
                  <ChevronDownIcon />
                </button>
              </div>
              <button
                class="p-1 rounded hover:bg-danger/30 disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={() => onRemove(index + indexOffset)}
                disabled={isUpdating || canRemove?.(index + indexOffset) === false}
                title="Remove"
              >
                <XIcon class="w-4 h-4 text-danger" />
              </button>
            </div>
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
    const model = findSameModel(availableModels, { model: modelId, provider });
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
      <div class="bg-surface-overlay border border-line-strong rounded-lg shadow-xl w-96 max-h-[85vh] overflow-hidden flex flex-col">
        <div class="flex items-center justify-between px-4 py-3 border-b border-line">
          <h3 class="text-sm font-medium text-fg">
            {editingKey ? 'Edit Override' : 'Add Model-Specific Override'}
          </h3>
          <button class="p-1 rounded hover:bg-fill-strong" onClick={onClose}>
            <XIcon />
          </button>
        </div>

        <div class="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <label class="block text-xs font-medium text-fg-muted mb-1">Source model</label>
            {sourceInfo ? (
              <div class="flex items-center gap-2 bg-surface-raised border border-line rounded-lg px-3 py-2">
                <ProviderLogo provider={sourceInfo.provider} class="h-4 w-4" />
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-fg-soft truncate">{sourceInfo.name}</div>
                  <div class="text-xs text-fg-faint">
                    {PROVIDER_LABELS[sourceInfo.provider] || getProviderLabel(sourceInfo.provider)}
                  </div>
                </div>
                {editingKey === null && (
                  <button
                    class="p-1 rounded hover:bg-fill-strong"
                    onClick={() => setShowSourcePicker(true)}
                    title="Change"
                  >
                    <PencilIcon />
                  </button>
                )}
              </div>
            ) : (
              <button
                class="w-full flex items-center gap-2 px-3 py-2 text-sm text-accent hover:text-accent-soft hover:bg-surface-raised rounded-lg border border-dashed border-line-strong hover:border-line-strong transition-colors"
                onClick={() => setShowSourcePicker(true)}
              >
                <PlusIcon />
                Select source model
              </button>
            )}
          </div>

          <div>
            <label class="block text-xs font-medium text-fg-muted mb-1">Fallback chain</label>
            {chain.length === 0 ? (
              <p class="text-xs text-fg-faint italic mb-2">No fallback models in this chain</p>
            ) : (
              <FallbackChainEditor
                models={chain}
                availableModels={availableModels}
                isUpdating={false}
                onMove={handleMoveChain}
                onRemove={handleRemoveChain}
                controls={(entry, index) => (
                  <FallbackThinkingSelect
                    saved={entry.thinkingLevel}
                    label={`Override fallback ${index + 1} thinking`}
                    capability={findSameModel(availableModels, entry) ?? entry}
                    disabled={false}
                    onChange={(level) =>
                      setChain(
                        chain.map((item, i) => (i === index ? withThinking(item, level) : item))
                      )
                    }
                  />
                )}
              />
            )}
            <button
              class="mt-2 flex items-center gap-2 px-3 py-2 text-sm text-accent hover:text-accent-soft hover:bg-surface-raised rounded-lg border border-dashed border-line-strong hover:border-line-strong transition-colors"
              onClick={() => setShowAddFallbackPicker(true)}
            >
              <PlusIcon />
              Add Fallback Model
            </button>
          </div>
        </div>

        <div class="px-4 py-3 border-t border-line flex justify-end gap-2">
          <button
            class="px-3 py-1.5 text-sm text-fg-muted hover:text-fg-soft rounded-lg hover:bg-fill-strong transition-colors"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            class="px-3 py-1.5 text-sm bg-accent-hover hover:bg-accent text-accent-fg rounded-lg transition-colors disabled:opacity-50"
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

interface ModelRowProps {
  heading: string;
  name: string;
  provider: string;
  pickLabel: string;
  disabled: boolean;
  onPick: () => void;
  thinking?: {
    saved: ThinkingLevel | undefined;
    label: string;
    capability: ThinkingCapability | null;
    onChange: (level: ThinkingLevel | undefined) => void;
  };
  percent: {
    label: string;
    title: string;
    value: string;
    onInput: (value: string) => void;
    onBlur: (value: string) => void;
  };
}

function ModelRow({
  heading,
  name,
  provider,
  pickLabel,
  disabled,
  onPick,
  thinking,
  percent,
}: ModelRowProps) {
  return (
    <div data-model-row class="space-y-4">
      <div class="flex min-w-0 items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="text-xs text-fg-muted">{heading}</div>
          <div class="mt-1 truncate text-sm font-medium text-fg" title={name}>
            {name}
          </div>
          <div class="mt-0.5 text-xs text-fg-faint">{provider}</div>
        </div>
        <Button
          aria-label={pickLabel}
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={onPick}
        >
          Change model
        </Button>
      </div>
      <div class="grid grid-cols-2 gap-4 border-t border-line pt-4">
        {thinking && (
          <label class="flex min-w-0 flex-col items-start gap-2 text-xs text-fg-muted">
            <span>Thinking</span>
            <FallbackThinkingSelect
              saved={thinking.saved}
              label={thinking.label}
              capability={thinking.capability}
              disabled={disabled}
              inherits={false}
              onChange={thinking.onChange}
            />
          </label>
        )}
        <label class="flex min-w-0 flex-col items-start gap-2 text-xs text-fg-muted">
          <span>Auto-compact</span>
          <span class="flex items-center gap-2">
            <input
              type="number"
              aria-label={percent.label}
              title={percent.title}
              min={AUTO_COMPACT_PERCENT_MIN}
              max={AUTO_COMPACT_PERCENT_MAX}
              step={1}
              value={percent.value}
              disabled={disabled}
              onInput={(event) => percent.onInput(event.currentTarget.value)}
              onBlur={(event) => percent.onBlur(event.currentTarget.value)}
              class="w-20 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg"
            />
            <span>%</span>
          </span>
        </label>
      </div>
    </div>
  );
}

function FrontModelSettings({
  groupedModels,
  providerAuthStatuses,
  loading,
}: Pick<ModelPickerModalProps, 'groupedModels' | 'providerAuthStatuses'> & { loading: boolean }) {
  const preference = globalSettings.value?.neo?.front?.model;
  const [picker, setPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  const [percent, setPercent] = useState('');
  const allModels = [...groupedModels.values()].flat();
  const busy = loading || saving || connectionState.value !== 'connected';
  const savedPercent = String(preference?.autoCompactPercent ?? AUTO_COMPACT_PERCENT_DEFAULT);
  useEffect(() => setPercent(savedPercent), [savedPercent]);
  async function save(
    model: Pick<ModelInfo, 'id' | 'provider'>,
    thinkingLevel = preference?.thinkingLevel ?? 'off',
    autoCompactPercent = preference?.autoCompactPercent
  ) {
    if (busy || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setPicker(false);
    setError('');
    try {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) throw new Error('Reconnect before changing the Convo model.');
      const result = await invokeOperation<{ ok: boolean; reason?: string }>(
        hub,
        'neo.front.model.set',
        {
          model: model.id,
          provider: model.provider,
          thinkingLevel,
          ...(autoCompactPercent === undefined ? {} : { autoCompactPercent }),
        }
      );
      if (!result.ok) throw new Error(result.reason ?? 'Could not save the Convo model.');
    } catch (cause) {
      setPercent(savedPercent);
      setError(cause instanceof Error ? cause.message : 'Could not save the Convo model.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  function savePercent(text: string) {
    if (!preference) return;
    const value = Number(text);
    if (
      !text.trim() ||
      !Number.isInteger(value) ||
      value < AUTO_COMPACT_PERCENT_MIN ||
      value > AUTO_COMPACT_PERCENT_MAX
    ) {
      setPercent(savedPercent);
      setError('Enter a whole number from 10 to 100.');
      return;
    }
    setError('');
    if (String(value) === savedPercent) return;
    void save(
      { id: preference.model, provider: preference.provider },
      preference.thinkingLevel,
      value
    );
  }
  return (
    <div class="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div class="border-b border-line pb-4">
        <h4 class="text-sm font-semibold text-fg">Convo</h4>
        <p class="mt-1 text-xs leading-relaxed text-fg-muted">
          Receives your messages and replies. Hands work to Neo when needed.
        </p>
      </div>
      {preference ? (
        <ModelRow
          heading="Model"
          name={findSameModel(allModels, preference)?.name ?? preference.model}
          provider={getProviderLabel(preference.provider)}
          pickLabel="Choose Convo model"
          disabled={busy}
          onPick={() => setPicker(true)}
          thinking={{
            saved: preference.thinkingLevel,
            label: 'Convo model thinking',
            capability: loading ? null : (findSameModel(allModels, preference) ?? preference),
            onChange: (level) => {
              void save({ id: preference.model, provider: preference.provider }, level);
            },
          }}
          percent={{
            label: 'Convo model auto-compact percentage',
            title: 'Applies to Convo replies as they run',
            value: percent,
            onInput: setPercent,
            onBlur: savePercent,
          }}
        />
      ) : (
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => setPicker(true)}>
          Choose Convo model
        </Button>
      )}
      {error && (
        <p role="alert" class="text-xs text-danger">
          {error}
        </p>
      )}
      {picker && (
        <ModelPickerModal
          title="Choose Convo model"
          groupedModels={groupedModels}
          providerAuthStatuses={providerAuthStatuses}
          excludeModels={[]}
          selectionDisabled={busy}
          onClose={() => setPicker(false)}
          onSelect={save}
        />
      )}
    </div>
  );
}

type SettingsModel = ModelInfo;
type NeoModelEntry = NonNullable<NeoModelPreference['fallbacks']>[number];
const entryKey = (entry: { provider: string; model: string }) => `${entry.provider}/${entry.model}`;
function percentTexts(preference?: NeoModelPreference | null): Record<string, string> {
  if (!preference) return {};
  return Object.fromEntries(
    [preference, ...(preference.fallbacks ?? [])].map((entry) => [
      entryKey(entry),
      String(entry.autoCompactPercent ?? AUTO_COMPACT_PERCENT_DEFAULT),
    ])
  );
}
function tokens(count: number): string {
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`;
  return count >= 1000 ? `${Math.round(count / 1000)}K` : String(count);
}

function NeoModelSettings({
  availableModels,
  groupedModels,
  providerAuthStatuses,
  loading,
}: Pick<ModelPickerModalProps, 'groupedModels' | 'providerAuthStatuses'> & {
  availableModels: SettingsModel[];
  loading: boolean;
}) {
  const preference = globalSettings.value?.neo?.preferences;
  const [draft, setDraft] = useState<NeoModelPreference | null>(preference ?? null);
  const [percents, setPercents] = useState(() => percentTexts(preference));
  const [picker, setPicker] = useState<'add' | 'primary' | null>(null);
  const [pendingPrimary, setPendingPrimary] = useState<NeoModelPreference | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setDraft(preference ?? null);
    setPercents(percentTexts(preference));
  }, [preference]);
  const percentText = (entry: { provider: string; model: string }) =>
    percents[entryKey(entry)] ?? String(AUTO_COMPACT_PERCENT_DEFAULT);
  function compactSize(entry: { provider: string; model: string }): string {
    const info = findSameModel(availableModels, entry);
    const typed = Number(percentText(entry));
    const percent = resolveAutoCompactPercent(
      typed === AUTO_COMPACT_PERCENT_DEFAULT ? info?.autoCompactPercent : typed
    );
    return info?.contextWindow
      ? `${percent}% ≈ ${tokens(Math.floor((info.contextWindow * percent) / 100))} of ${tokens(info.contextWindow)} tokens`
      : `${percent}% · context window unknown`;
  }
  const busy = loading || saving || connectionState.value !== 'connected';
  const list: NeoModelEntry[] = draft
    ? [
        {
          model: draft.model,
          provider: draft.provider,
          thinkingLevel: draft.thinkingLevel,
          ...(draft.autoCompactPercent === undefined
            ? {}
            : { autoCompactPercent: draft.autoCompactPercent }),
        },
        ...(draft.fallbacks ?? []),
      ]
    : [];
  function save(next: NeoModelPreference) {
    if (busy || savingRef.current) return;
    if (draft && (draft.model !== next.model || draft.provider !== next.provider)) {
      setPendingPrimary(next);
      return;
    }
    void commitSave(next);
  }
  async function commitSave(next: NeoModelPreference) {
    if (busy || savingRef.current) return;
    const previous = draft;
    savingRef.current = true;
    setSaving(true);
    setError('');
    setDraft(next);
    try {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) throw new Error('Reconnect before changing Neo models.');
      const result = await invokeOperation<
        { ok: true; preferences: NeoModelPreference } | { ok: false; reason: string }
      >(hub, 'neo.preferences.set', next);
      if (!result.ok) throw new Error(result.reason);
      setDraft(result.preferences);
      setPercents(percentTexts(result.preferences));
    } catch (cause) {
      const currentPreference = globalSettings.value?.neo?.preferences;
      const rollback = currentPreference === preference ? previous : (currentPreference ?? null);
      setDraft(rollback);
      setPercents(percentTexts(rollback));
      setError(cause instanceof Error ? cause.message : 'Could not save Neo models.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  function setList(next: NeoModelEntry[]) {
    const [first, ...rest] = next;
    if (!first) return;
    void save({
      ...first,
      ...(draft?.fallbacks === undefined && !rest.length ? {} : { fallbacks: rest }),
    });
  }
  function savePercent(index: number, text: string) {
    const entry = list[index];
    const value = Number(text);
    if (
      !text.trim() ||
      !Number.isInteger(value) ||
      value < AUTO_COMPACT_PERCENT_MIN ||
      value > AUTO_COMPACT_PERCENT_MAX
    ) {
      setError('Enter a whole number from 10 to 100.');
      return;
    }
    if (value === (entry.autoCompactPercent ?? AUTO_COMPACT_PERCENT_DEFAULT)) {
      setError('');
      return;
    }
    const { autoCompactPercent: _previous, ...other } = entry;
    const updated =
      value === AUTO_COMPACT_PERCENT_DEFAULT ? other : { ...other, autoCompactPercent: value };
    setList(list.map((item, i) => (i === index ? updated : item)));
  }
  return (
    <section
      aria-label="Neo models"
      class="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5"
    >
      {pendingPrimary && (
        <ConfirmModal
          isOpen
          title="Confirm Neo model"
          message={`Switch Neo to ${pendingPrimary ? (findSameModel(availableModels, pendingPrimary)?.name ?? pendingPrimary.model) : ''}?`}
          confirmButtonVariant="primary"
          isLoading={busy}
          onClose={() => {
            if (!busy && !savingRef.current && connectionState.value === 'connected') {
              setPendingPrimary(null);
            }
          }}
          onConfirm={() => {
            if (busy || savingRef.current || connectionState.value !== 'connected') return;
            if (pendingPrimary) void commitSave(pendingPrimary);
            setPendingPrimary(null);
          }}
        />
      )}
      <div class="border-b border-line pb-4">
        <h4 class="text-sm font-semibold text-fg">Neo</h4>
        <p class="mt-1 text-xs leading-relaxed text-fg-muted">
          Handles work and investigations. Publishes delegated results.
        </p>
      </div>
      {draft ? (
        <ModelRow
          heading="Primary model"
          name={findSameModel(availableModels, draft)?.name ?? draft.model}
          provider={getProviderLabel(draft.provider)}
          pickLabel="Change Neo primary"
          disabled={busy}
          onPick={() => setPicker('primary')}
          thinking={{
            saved: draft.thinkingLevel ?? 'off',
            label: 'Neo model 1 thinking',
            capability: loading ? null : (findSameModel(availableModels, draft) ?? draft),
            onChange: (level) => void save({ ...draft, thinkingLevel: level ?? 'off' }),
          }}
          percent={{
            label: 'Neo model 1 auto-compact percentage',
            title: compactSize(draft),
            value: percentText(draft),
            onInput: (value) => setPercents({ ...percents, [entryKey(draft)]: value }),
            onBlur: (value) => savePercent(0, value),
          }}
        />
      ) : (
        <div class="space-y-2">
          <p class="text-xs text-fg-faint">
            Follows default (current: {globalSettings.value?.model ?? 'none'})
          </p>
          <p class="text-xs text-fg-faint">
            Add a model to save a Neo preference. The first one is the primary.
          </p>
          <Button variant="secondary" size="xs" disabled={busy} onClick={() => setPicker('add')}>
            Choose Neo model
          </Button>
        </div>
      )}
      <div class="border-t border-line pt-4">
        <div class="space-y-3">
          {list.length > 1 && (
            <div class="text-xs font-medium text-fg-muted">Fallback models · tried in order</div>
          )}
          <FallbackChainEditor
            models={list.slice(1)}
            indexOffset={1}
            availableModels={availableModels}
            isUpdating={busy}
            canRemove={() => list.length > 1}
            onRemove={(index) => setList(list.filter((_, i) => i !== index))}
            onMove={(index, direction) => {
              const next = [...list];
              const other = index + (direction === 'up' ? -1 : 1);
              [next[index], next[other]] = [next[other], next[index]];
              setList(next);
            }}
            controls={(entry, index) => (
              <div class="flex flex-wrap items-center justify-end gap-2">
                {index === 0 ? (
                  <span class="text-xs font-medium text-accent">Primary</span>
                ) : (
                  <Button
                    variant="secondary"
                    size="xs"
                    disabled={busy}
                    aria-label={`Make Neo model ${index + 1} primary`}
                    onClick={() => setList([list[index], ...list.filter((_, i) => i !== index)])}
                  >
                    Use as primary
                  </Button>
                )}
                {index > 0 && (
                  <label class="flex items-center gap-2 text-xs text-fg-muted">
                    <span>Thinking</span>
                    <FallbackThinkingSelect
                      saved={entry.thinkingLevel ?? 'off'}
                      label={`Neo model ${index + 1} thinking`}
                      capability={loading ? null : (findSameModel(availableModels, entry) ?? entry)}
                      disabled={busy}
                      inherits={false}
                      onChange={(level = 'off') =>
                        setList(
                          list.map((item, i) =>
                            i === index ? { ...item, thinkingLevel: level } : item
                          )
                        )
                      }
                    />
                  </label>
                )}
                <label class="flex items-center gap-2 text-xs text-fg-muted">
                  <span>Auto-compact</span>
                  <input
                    type="number"
                    aria-label={`Neo model ${index + 1} auto-compact percentage`}
                    title={compactSize(entry)}
                    min={AUTO_COMPACT_PERCENT_MIN}
                    max={AUTO_COMPACT_PERCENT_MAX}
                    step={1}
                    value={percentText(entry)}
                    disabled={busy}
                    onInput={(event) =>
                      setPercents({ ...percents, [entryKey(entry)]: event.currentTarget.value })
                    }
                    onBlur={(event) => savePercent(index, event.currentTarget.value)}
                    class="w-14 rounded border border-line bg-surface px-1.5 py-1 text-xs text-fg"
                  />
                  <span>%</span>
                </label>
              </div>
            )}
          />
          <div class="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="xs"
              disabled={busy || list.length > 10}
              onClick={() => setPicker('add')}
            >
              Add Neo model
            </Button>
            <Button
              variant="secondary"
              size="xs"
              disabled={busy || !draft}
              onClick={() => draft && void save({ ...draft, fallbacks: [] })}
            >
              Clear saved fallbacks
            </Button>
          </div>
        </div>
      </div>
      {saving && (
        <p role="status" class="text-xs text-fg-faint">
          Saving changes. Wait until complete, then retry any other action.
        </p>
      )}
      {error && (
        <p role="alert" class="text-xs text-danger">
          {error}
        </p>
      )}
      {picker && (
        <ModelPickerModal
          title={picker === 'primary' ? 'Change Neo primary' : 'Add Neo model'}
          groupedModels={groupedModels}
          providerAuthStatuses={providerAuthStatuses}
          excludeModels={list}
          selectionDisabled={busy}
          onClose={() => setPicker(null)}
          onSelect={(model) => {
            if (busy || savingRef.current || connectionState.value !== 'connected') return;
            if (picker === 'primary' && draft) {
              const { autoCompactPercent: _previous, ...preference } = draft;
              void save({ ...preference, model: model.id, provider: model.provider });
            } else {
              setList([
                ...list,
                { model: model.id, provider: model.provider, thinkingLevel: 'off' },
              ]);
            }
            setPicker(null);
          }}
        />
      )}
    </section>
  );
}

type ThinkingCapability = Pick<ModelInfo, 'provider' | 'thinkingModes' | 'effortLevels'>;

function thinkingChoices(model: ThinkingCapability | null | undefined) {
  const mode =
    model?.thinkingModes ??
    PROVIDER_THINKING_MODES[model?.provider as keyof typeof PROVIDER_THINKING_MODES];
  const efforts = model?.effortLevels;
  return {
    options: THINKING_OPTIONS.filter(({ value }) => {
      const effort = THINKING_LEVEL_EFFORT[value];
      if (!effort) return true;
      return mode !== 'off' && (!efforts?.length || efforts.includes(effort));
    }),
    unknown: Boolean(model && !mode),
  };
}

function withThinking(entry: FallbackModelEntry, level: ThinkingLevel | undefined) {
  const { thinkingLevel: _previous, ...rest } = entry;
  return level ? { ...rest, thinkingLevel: level } : rest;
}

function FallbackThinkingSelect({
  saved,
  label,
  capability,
  disabled,
  inherits = true,
  onChange,
}: {
  saved: ThinkingLevel | undefined;
  label: string;
  capability: ThinkingCapability | null;
  disabled: boolean;
  inherits?: boolean;
  onChange: (level: ThinkingLevel | undefined) => void;
}) {
  const { options, unknown } = thinkingChoices(capability);
  const unsupported = saved !== undefined && !options.some((option) => option.value === saved);
  return (
    <>
      <select
        aria-label={label}
        class="rounded border border-line bg-surface px-2 py-1 text-xs text-fg"
        value={saved ?? ''}
        disabled={disabled}
        onChange={(event) =>
          onChange((event.currentTarget.value || undefined) as ThinkingLevel | undefined)
        }
      >
        {inherits && <option value="">Use default</option>}
        {options.map((option) => (
          <option value={option.value}>{option.label}</option>
        ))}
        {unsupported && <option value={saved}>{THINKING_LEVEL_LABELS[saved]}</option>}
      </select>
      {unsupported && (
        <span class="text-xs text-warning">Saved level is not supported by this model.</span>
      )}
      {unknown && (
        <span class="text-xs text-fg-faint">Thinking support for this model is unknown.</span>
      )}
    </>
  );
}

function DefaultThinkingSelect({ model }: { model: ModelInfo | null }) {
  const saved = normalizeThinkingLevel(globalSettings.value?.thinkingLevel);
  const [level, setLevel] = useState<ThinkingLevel>(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => setLevel(saved), [saved]);
  const { options, unknown } = thinkingChoices(model);
  const unsupported = !options.some((option) => option.value === level);
  const change = async (next: ThinkingLevel) => {
    setLevel(next);
    setSaving(true);
    try {
      await updateGlobalSettings({ thinkingLevel: next });
    } catch {
      toast.error('Failed to update thinking level');
      setLevel(saved);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div class="flex flex-wrap items-center gap-2">
      <label class="text-xs text-fg-muted" for="default-thinking">
        Thinking
      </label>
      <select
        id="default-thinking"
        aria-label="Default thinking"
        class="rounded border border-line bg-surface px-2 py-1 text-xs text-fg"
        value={level}
        disabled={saving}
        onChange={(event) => change(event.currentTarget.value as ThinkingLevel)}
      >
        {options.map((option) => (
          <option value={option.value}>{option.label}</option>
        ))}
        {unsupported && <option value={level}>{THINKING_LEVEL_LABELS[level]}</option>}
      </select>
      {unsupported && (
        <span class="text-xs text-warning">Saved level is not supported by this model.</span>
      )}
      {unknown && (
        <span class="text-xs text-fg-faint">Thinking support for this model is unknown.</span>
      )}
    </div>
  );
}

export function ModelsSettings({ neoOnly = false }: { neoOnly?: boolean } = {}) {
  const settings = globalSettings.value;
  const [fallbackModels, setFallbackModels] = useState<FallbackModelEntry[]>(
    settings?.fallbackModels ?? []
  );
  const [modelFallbackMap, setModelFallbackMap] = useState<Record<string, FallbackModelEntry[]>>(
    settings?.modelFallbackMap ?? {}
  );
  const [availableModels, setAvailableModels] = useState<SettingsModel[]>([]);
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
  const [showDefaultModal, setShowDefaultModal] = useState(false);

  const [overrideModal, setOverrideModal] = useState<{
    open: boolean;
    editingKey: string | null;
  }>({ open: false, editingKey: null });

  useEffect(() => {
    if (settings) {
      setFallbackModels(settings.fallbackModels ?? []);
      setModelFallbackMap(settings.modelFallbackMap ?? {});
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
        hub.request('models.list', forceRefresh ? { forceRefresh: true } : { useCache: true }, {
          timeout: MODEL_LIST_REQUEST_TIMEOUT_MS,
        }) as Promise<{ models: RawModelEntry[] }>,
        listProviderAuthStatus().catch(() => ({ providers: [] })),
      ]);

      setAvailableModels(
        mapRawModelsToModelInfos(modelsResponse.models).map((model) => ({
          ...model,
          autoCompactPercent: modelsResponse.models.find(
            (raw) => raw.id === model.id && (raw.provider ?? model.provider) === model.provider
          )?.autoCompactPercent,
        }))
      );

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

  const handleThinking = async (index: number, level: ThinkingLevel | undefined) => {
    await saveFallbackModels(
      fallbackModels.map((entry, i) => (i === index ? withThinking(entry, level) : entry))
    );
  };

  const handleDefaultModel = async (model: ModelInfo) => {
    setIsUpdating(true);
    try {
      await updateGlobalSettings({ model: model.id, modelProvider: model.provider });
      setShowDefaultModal(false);
    } catch {
      toast.error('Failed to update the default model');
    } finally {
      setIsUpdating(false);
    }
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
    const model = findSameModel(availableModels, entry);
    return { name: model?.name ?? entry.model, family: model?.family ?? 'sonnet' };
  };

  const getKeyDisplayInfo = (key: string) => {
    const [provider, ...rest] = key.split('/');
    const modelId = rest.join('/');
    const model = findSameModel(availableModels, { model: modelId, provider: provider ?? '' });
    return model
      ? { name: model.name, family: model.family, provider }
      : { name: modelId || key, family: 'sonnet', provider: provider ?? '' };
  };

  const filteredModels = filterModelsForPicker(availableModels, providerAuthStatuses, undefined);
  const groupedModels = groupModelsByProvider(filteredModels);
  const overrideEntries = Object.entries(modelFallbackMap);
  const defaultModel = findDefaultModel(availableModels, settings?.model, settings?.modelProvider);

  if (neoOnly)
    return (
      <SettingsSection
        title="Conversation models"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRefresh}
            disabled={loading || refreshing}
            loading={refreshing}
          >
            Refresh models
          </Button>
        }
      >
        {loadError && (
          <p role="alert" class="text-sm text-danger">
            {loadError.message}
          </p>
        )}
        <NeoFrontSettings />
        <div class="grid items-start gap-4 xl:grid-cols-2">
          <section aria-label="Convo">
            <FrontModelSettings
              groupedModels={groupedModels}
              providerAuthStatuses={providerAuthStatuses}
              loading={loading}
            />
          </section>
          <NeoModelSettings
            availableModels={availableModels}
            groupedModels={groupedModels}
            providerAuthStatuses={providerAuthStatuses}
            loading={loading}
          />
        </div>
      </SettingsSection>
    );

  return (
    <SettingsSection
      title="HyperNeo sessions"
      actions={
        <Button
          variant="secondary"
          size="sm"
          onClick={handleRefresh}
          disabled={loading || refreshing}
          loading={refreshing}
        >
          Refresh models
        </Button>
      }
    >
      {loadError && (
        <div
          class="flex items-center justify-between gap-3 rounded-lg border border-danger-soft/20 px-4 py-3 text-sm text-danger-soft"
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
        <div class="space-y-3 rounded-xl border border-line bg-surface p-4">
          <div>
            <h4 class="text-[13px] font-semibold text-fg">Default Model</h4>
            <p class="text-xs text-fg-faint mt-0.5">
              Used for new sessions that don&apos;t choose a model.
            </p>
          </div>
          <div class="flex items-center gap-2">
            {defaultModel && <ProviderLogo provider={defaultModel.provider} class="h-4 w-4" />}
            <span class="flex-1 truncate text-sm text-fg-soft">
              {loading
                ? 'Loading models...'
                : defaultModel
                  ? `${defaultModel.name} · ${PROVIDER_LABELS[defaultModel.provider] || getProviderLabel(defaultModel.provider)}`
                  : `${settings?.model ?? 'None'} (not available)`}
            </span>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setShowDefaultModal(true)}
              disabled={loading || isUpdating}
            >
              Change
            </Button>
          </div>
          <DefaultThinkingSelect model={defaultModel} />
        </div>

        <details class="space-y-3">
          <summary class="cursor-pointer text-sm font-semibold">Advanced</summary>
          <div class="space-y-3 rounded-xl border border-line bg-surface p-4">
            <div>
              <h4 class="text-[13px] font-semibold text-fg">Default Fallback Chain</h4>
              <p class="text-xs text-fg-faint mt-0.5">
                Applies to all models that don&apos;t have a specific override below.
              </p>
            </div>

            {loading ? (
              <div class="flex items-center gap-2 text-xs text-fg-faint">
                <Spinner size="xs" />
                <span>Loading models...</span>
              </div>
            ) : fallbackModels.length === 0 ? (
              <div class="text-xs text-fg-faint italic">No fallback models configured</div>
            ) : (
              <FallbackChainEditor
                models={fallbackModels}
                availableModels={availableModels}
                isUpdating={isUpdating}
                onMove={handleMove}
                onRemove={handleRemove}
                controls={(entry, index) => (
                  <FallbackThinkingSelect
                    saved={entry.thinkingLevel}
                    label={`Fallback ${index + 1} thinking`}
                    capability={findSameModel(availableModels, entry) ?? entry}
                    disabled={isUpdating}
                    onChange={(level) => handleThinking(index, level)}
                  />
                )}
              />
            )}

            <button
              class="flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-line-strong hover:text-fg-soft disabled:opacity-50"
              onClick={() => setShowAddModal(true)}
              disabled={loading}
            >
              <PlusIcon />
              Add Fallback Model
            </button>
          </div>

          <div class="space-y-3 rounded-xl border border-line bg-surface p-4">
            <div>
              <h4 class="text-[13px] font-semibold text-fg">Model-Specific Overrides</h4>
              <p class="text-xs text-fg-faint mt-0.5">
                Override the default chain for a specific model. Takes priority when that model hits
                a limit.
              </p>
            </div>

            {loading ? (
              <div class="flex items-center gap-2 text-xs text-fg-faint">
                <Spinner size="xs" />
                <span>Loading models...</span>
              </div>
            ) : overrideEntries.length === 0 ? (
              <div class="text-xs text-fg-faint italic">
                No model-specific overrides. Add one to override the default chain for a specific
                model.
              </div>
            ) : (
              <div class="space-y-2">
                {overrideEntries.map(([key, chain]) => {
                  const sourceInfo = getKeyDisplayInfo(key);
                  return (
                    <div
                      key={key}
                      class="bg-surface-raised border border-line rounded-lg px-3 py-2"
                    >
                      <div class="flex items-center gap-2">
                        <ProviderLogo provider={sourceInfo.provider} class="h-4 w-4" />
                        <div class="flex-1 min-w-0">
                          <div class="text-sm text-fg-soft truncate">{sourceInfo.name}</div>
                          <div class="text-xs text-fg-faint">
                            {PROVIDER_LABELS[sourceInfo.provider] ||
                              getProviderLabel(sourceInfo.provider)}
                          </div>
                        </div>
                        <button
                          class="p-1 rounded hover:bg-fill-strong disabled:opacity-30"
                          onClick={() => setOverrideModal({ open: true, editingKey: key })}
                          disabled={isUpdating}
                          title="Edit"
                        >
                          <PencilIcon />
                        </button>
                        <button
                          class="p-1 rounded hover:bg-danger/30 disabled:opacity-30"
                          onClick={() => handleDeleteOverride(key)}
                          disabled={isUpdating}
                          title="Delete"
                        >
                          <XIcon class="w-4 h-4 text-danger" />
                        </button>
                      </div>

                      {chain.length > 0 && (
                        <div class="mt-2 flex flex-wrap gap-1.5">
                          {chain.map((entry, i) => {
                            const info = getModelDisplayInfo(entry);
                            return (
                              <span
                                key={`${entry.provider}:${entry.model}`}
                                class="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-fill-strong text-fg-soft rounded-full"
                              >
                                <span class="text-fg-faint">{i + 1}.</span>
                                <ProviderLogo provider={entry.provider} class="h-3 w-3" />
                                <span class="truncate max-w-[120px]">{info.name}</span>
                              </span>
                            );
                          })}
                        </div>
                      )}
                      {chain.length === 0 && (
                        <p class="mt-1.5 text-xs text-fg-faint italic">Empty chain</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <button
              class="flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-line-strong hover:text-fg-soft disabled:opacity-50"
              onClick={() => setOverrideModal({ open: true, editingKey: null })}
              disabled={loading}
            >
              <PlusIcon />
              Add Override
            </button>
          </div>
        </details>
      </div>

      {showDefaultModal && (
        <ModelPickerModal
          title="Default Model"
          groupedModels={groupedModels}
          providerAuthStatuses={providerAuthStatuses}
          excludeModels={
            defaultModel ? [{ model: defaultModel.id, provider: defaultModel.provider }] : []
          }
          onSelect={handleDefaultModel}
          onClose={() => setShowDefaultModal(false)}
        />
      )}

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
