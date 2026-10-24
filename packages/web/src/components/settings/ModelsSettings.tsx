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
                        unavailable ? 'cursor-not-allowed opacity-50' : 'hover:bg-fill-strong'
                      }`}
                      disabled={unavailable}
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
  availableModels: ModelInfo[];
  isUpdating: boolean;
  onMove: (index: number, direction: 'up' | 'down') => void;
  onRemove: (index: number) => void;
  controls?: (entry: FallbackModelEntry, index: number) => ComponentChildren;
}

function FallbackChainEditor({
  models,
  availableModels,
  isUpdating,
  onMove,
  onRemove,
  controls,
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
            class="flex flex-wrap items-center gap-2 bg-surface-raised border border-line rounded-lg px-3 py-2"
          >
            <span class="text-xs text-fg-faint font-medium w-4">{index + 1}.</span>
            <ProviderLogo provider={entry.provider} class="h-4 w-4" />
            <div class="flex-1 min-w-[7rem]">
              <div class="text-sm text-fg-soft truncate">{displayInfo.name}</div>
              <div class="text-xs text-fg-faint">
                {PROVIDER_LABELS[entry.provider] || getProviderLabel(entry.provider)}
              </div>
            </div>
            <div class="ml-auto flex flex-wrap items-center justify-end gap-2">
              {controls?.(entry, index)}
              <div class="flex items-center gap-1">
                <button
                  class="p-1 rounded hover:bg-fill-strong disabled:opacity-30 disabled:cursor-not-allowed"
                  onClick={() => onMove(index, 'up')}
                  disabled={index === 0 || isUpdating}
                  title="Move up"
                >
                  <ChevronUpIcon />
                </button>
                <button
                  class="p-1 rounded hover:bg-fill-strong disabled:opacity-30 disabled:cursor-not-allowed"
                  onClick={() => onMove(index, 'down')}
                  disabled={index === models.length - 1 || isUpdating}
                  title="Move down"
                >
                  <ChevronDownIcon />
                </button>
              </div>
              <button
                class="p-1 rounded hover:bg-danger/30 disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={() => onRemove(index)}
                disabled={isUpdating}
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
  const [picker, setPicker] = useState(false);
  const [saving, setSaving] = useState(false);
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
  function setList(next: NeoModelEntry[]) {
    const [first, ...rest] = next;
    if (!first) return setDraft(null);
    setDraft({
      ...first,
      ...(preference?.fallbacks === undefined && draft?.fallbacks === undefined && !rest.length
        ? {}
        : { fallbacks: rest }),
    });
  }
  const providers = [...groupedModels.entries()]
    .filter(([, models]) => models.some((model) => model.available !== false))
    .map(([id]) => PROVIDER_LABELS[id] || getProviderLabel(id));
  function thinking(
    entry: FallbackModelEntry,
    label: string,
    change: (thinkingLevel: ThinkingLevel) => void
  ) {
    const options = THINKING_OPTIONS;
    return (
      <select
        aria-label={label}
        class="rounded border border-line bg-surface px-2 py-1 text-xs text-fg"
        value={entry.thinkingLevel ?? 'off'}
        disabled={busy || !options.length}
        onChange={(event) => change(event.currentTarget.value as ThinkingLevel)}
      >
        {(options.length ? options : [{ value: 'off', label: 'Off' }]).map((option) => (
          <option value={option.value}>{option.label}</option>
        ))}
      </select>
    );
  }
  async function save() {
    if (!draft || busy) return;
    if (
      list.some(
        (entry) => !percentText(entry).trim() || !Number.isInteger(Number(percentText(entry)))
      )
    ) {
      setError('Enter a whole number from 10 to 100.');
      return;
    }
    const [first, ...rest] = list.map(({ autoCompactPercent: _previous, ...entry }) => {
      const typed = Number(percentText(entry));
      return typed === AUTO_COMPACT_PERCENT_DEFAULT
        ? entry
        : { ...entry, autoCompactPercent: resolveAutoCompactPercent(typed) };
    });
    const next = {
      ...first,
      ...(draft.fallbacks === undefined && rest.length === 0 ? {} : { fallbacks: rest }),
    };
    setSaving(true);
    setError('');
    try {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) throw new Error('Reconnect before changing Neo models.');
      const result = await invokeOperation<
        { ok: true; preferences: NeoModelPreference } | { ok: false; reason: string }
      >(hub, 'neo.preferences.set', next);
      if (!result.ok) throw new Error(result.reason);
      setDraft(result.preferences);
      setPercents(percentTexts(result.preferences));
      toast.success('Neo models saved');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save Neo models.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <section aria-label="Neo models" class="space-y-3 rounded-xl border border-line bg-surface p-4">
      <div>
        <h4 class="text-[13px] font-semibold text-fg">Neo models</h4>
        <p class="text-xs text-fg-faint mt-0.5">
          Models Neo and its projects use, in order: the primary first, then the fallbacks. Neo
          returns to the primary after recovery.
        </p>
      </div>
      <p class="text-xs text-fg-faint">
        Auto-compact is set per model and shown against that model’s context window. 90% keeps the
        provider default; at 100%, compaction follows the provider’s limits. Changes apply after the
        current reply.
      </p>
      <p class="text-xs text-fg-faint">
        Usable fallback providers: {providers.join(', ') || 'None available'}
      </p>
      {!draft ? (
        <p class="text-xs text-fg-faint">Add a model. The first one in the list is the primary.</p>
      ) : draft.fallbacks === undefined ? (
        <p class="text-xs text-fg-faint">
          Uses the general session fallback chain until you save a Neo chain.
        </p>
      ) : draft.fallbacks.length === 0 ? (
        <p class="text-xs text-fg-faint">Neo fallbacks disabled.</p>
      ) : null}
      <FallbackChainEditor
        models={list}
        availableModels={availableModels}
        isUpdating={busy}
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
                <span class="whitespace-nowrap">Make primary</span>
              </Button>
            )}
            {thinking(entry, `Neo model ${index + 1} thinking`, (thinkingLevel) =>
              setList(list.map((item, i) => (i === index ? { ...item, thinkingLevel } : item)))
            )}
            <input
              type="number"
              aria-label={`Neo model ${index + 1} auto-compact percentage`}
              min={AUTO_COMPACT_PERCENT_MIN}
              max={AUTO_COMPACT_PERCENT_MAX}
              step={1}
              value={percentText(entry)}
              disabled={busy}
              onInput={(event) =>
                setPercents({ ...percents, [entryKey(entry)]: event.currentTarget.value })
              }
              class="w-14 rounded border border-line bg-surface px-1.5 py-1 text-xs text-fg"
            />
            <span class="text-xs text-fg-faint whitespace-nowrap">{compactSize(entry)}</span>
          </div>
        )}
      />
      <div class="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="xs"
          disabled={busy || list.length > 10}
          onClick={() => setPicker(true)}
        >
          Add Neo model
        </Button>
        <Button
          variant="secondary"
          size="xs"
          disabled={busy || !draft}
          onClick={() => draft && setDraft({ ...draft, fallbacks: [] })}
        >
          Disable Neo fallbacks
        </Button>
        <Button size="xs" disabled={busy || !draft} onClick={save}>
          Save Neo models
        </Button>
      </div>
      {error && (
        <p role="alert" class="text-xs text-danger">
          {error}
        </p>
      )}
      {picker && (
        <ModelPickerModal
          title="Add Neo model"
          groupedModels={groupedModels}
          providerAuthStatuses={providerAuthStatuses}
          excludeModels={list}
          onClose={() => setPicker(false)}
          onSelect={(model) => {
            setList([...list, { model: model.id, provider: model.provider, thinkingLevel: 'off' }]);
            setPicker(false);
          }}
        />
      )}
    </section>
  );
}

function DefaultThinkingSelect({ model }: { model: ModelInfo | null }) {
  const saved = normalizeThinkingLevel(globalSettings.value?.thinkingLevel);
  const [level, setLevel] = useState<ThinkingLevel>(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => setLevel(saved), [saved]);
  const mode =
    model?.thinkingModes ??
    PROVIDER_THINKING_MODES[model?.provider as keyof typeof PROVIDER_THINKING_MODES];
  const options = mode === 'off' ? THINKING_OPTIONS.slice(0, 1) : THINKING_OPTIONS;
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
      {!mode && (
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
  const [openRouterAllowlistText, setOpenRouterAllowlistText] = useState(
    (settings?.providerModelAllowlists?.openrouter ?? []).join('\n')
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
        title="Neo model"
        description="Model, provider, thinking and compaction for Neo and its projects. Changes apply after the current reply."
      >
        {loadError && (
          <p role="alert" class="text-sm text-danger">
            {loadError.message}
          </p>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={handleRefresh}
          disabled={loading || refreshing}
        >
          Refresh models
        </Button>
        <NeoModelSettings
          availableModels={availableModels}
          groupedModels={groupedModels}
          providerAuthStatuses={providerAuthStatuses}
          loading={loading}
        />
      </SettingsSection>
    );

  return (
    <SettingsSection
      title="Models"
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
      <div class="space-y-3 rounded-xl border border-line bg-surface p-4">
        <div>
          <h4 class="text-[13px] font-semibold text-fg">OpenRouter Model Allowlist</h4>
          <p class="text-xs text-fg-faint mt-0.5">
            OpenRouter does not expose dashboard-enabled account models through its public API. Add
            one model ID per line to limit model pickers and runtime validation to models you have
            enabled on OpenRouter.
          </p>
        </div>
        <textarea
          value={openRouterAllowlistText}
          onInput={(e) => setOpenRouterAllowlistText(e.currentTarget.value)}
          placeholder={`xai/grok-4.3\nqwen/qwen3.6-max-preview\ndeepseek/deepseek-v4-pro`}
          class="w-full h-28 bg-bg/60 border border-line rounded-lg px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent font-mono"
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
              Override the default chain for a specific model. Takes priority when that model hits a
              limit.
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
                  <div key={key} class="bg-surface-raised border border-line rounded-lg px-3 py-2">
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
