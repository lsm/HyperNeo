import type {
  CustomEndpointConfig,
  CustomEndpointModel,
  CustomEndpointModelCapabilities,
  CustomEndpointType,
} from '@hyperneo/shared';
import {
  AUTO_COMPACT_PERCENT_MAX,
  AUTO_COMPACT_PERCENT_MIN,
  CUSTOM_ENDPOINT_TYPE_CAPABILITY_DEFAULTS,
  DEFAULT_CUSTOM_ENDPOINT_CAPABILITIES,
} from '@hyperneo/shared';
import { useEffect } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/Button.tsx';
import {
  CUSTOM_ENDPOINT_PRESETS,
  type CustomEndpointPreset,
  findPreset,
} from './customEndpointPresets.ts';

const TYPE_OPTIONS: Array<{ value: CustomEndpointType; label: string }> = [
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'ollama-native', label: 'Ollama Native' },
];

export interface ModelDraft extends CustomEndpointModel {
  resolved: CustomEndpointModelCapabilities;
}

export function resolveCapabilities(
  type: CustomEndpointType,
  caps?: Partial<CustomEndpointModelCapabilities>
): CustomEndpointModelCapabilities {
  const typeDefaults = CUSTOM_ENDPOINT_TYPE_CAPABILITY_DEFAULTS[type] ?? {};
  return {
    ...DEFAULT_CUSTOM_ENDPOINT_CAPABILITIES,
    ...typeDefaults,
    ...caps,
  };
}

export function makeModelDraft(
  type: CustomEndpointType,
  model?: Partial<CustomEndpointModel>
): ModelDraft {
  return {
    id: model?.id ?? '',
    name: model?.name,
    providerModelId: model?.providerModelId,
    capabilities: model?.capabilities,
    resolved: resolveCapabilities(type, model?.capabilities),
  };
}

export interface EditorState {
  mode: 'create' | 'edit';
  original?: CustomEndpointConfig;
  id: string;
  type: CustomEndpointType;
  name: string;
  baseUrl: string;
  apiKey: string;
  headersText: string;
  defaultModelId: string;
  models: ModelDraft[];
  presetCapabilities?: Partial<CustomEndpointModelCapabilities>;
  selectedFetchedModelIds?: string[];
}

export function presetToEditor(preset: CustomEndpointPreset): EditorState {
  const type = preset.template.type ?? 'openai-chat';
  return {
    mode: 'create',
    id: preset.template.id ?? '',
    type,
    name: preset.template.name ?? '',
    baseUrl: preset.template.baseUrl ?? '',
    apiKey: preset.template.apiKey ?? '',
    headersText: preset.template.headers
      ? Object.entries(preset.template.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n')
      : '',
    defaultModelId: preset.template.defaultModelId ?? '',
    presetCapabilities: preset.defaultModelCapabilities,
    models: (preset.template.models ?? []).map((m) =>
      makeModelDraft(type, {
        ...m,
        capabilities: { ...preset.defaultModelCapabilities, ...m.capabilities },
      })
    ),
  };
}

export function existingToEditor(config: CustomEndpointConfig): EditorState {
  const type: CustomEndpointType = config.type ?? 'openai-chat';
  return {
    mode: 'edit',
    original: config,
    id: config.id,
    type,
    name: config.name,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey ?? '',
    headersText: config.headers
      ? Object.entries(config.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n')
      : '',
    defaultModelId: config.defaultModelId ?? '',
    models: config.models.map((m) => makeModelDraft(type, m)),
  };
}

export function parseHeaders(text: string): Record<string, string> | undefined {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx <= 0) throw new Error(`Invalid header line: '${line}' (expected 'Key: Value')`);
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) throw new Error(`Invalid header line: '${line}' (empty key)`);
    headers[key] = value;
  }
  return headers;
}

export function editorToConfig(state: EditorState): CustomEndpointConfig {
  const headers = parseHeaders(state.headersText);
  const models = state.models.map((m): CustomEndpointModel => {
    const out: CustomEndpointModel = { id: m.id.trim() };
    if (m.name?.trim()) out.name = m.name.trim();
    if (m.providerModelId?.trim()) out.providerModelId = m.providerModelId.trim();
    const baseDefaults = resolveCapabilities(state.type);
    const delta: Partial<CustomEndpointModelCapabilities> = {};
    const keys: (keyof CustomEndpointModelCapabilities)[] = [
      'streaming',
      'toolUse',
      'vision',
      'thinking',
      'caching',
      'streamUsage',
      'maxContextTokens',
      'autoCompactPercent',
      'chatTemplateKwargs',
    ];
    for (const k of keys) {
      if (m.resolved[k] !== baseDefaults[k]) {
        (delta[k] as CustomEndpointModelCapabilities[typeof k]) = m.resolved[k];
      }
    }
    if (Object.keys(delta).length > 0) out.capabilities = delta;
    return out;
  });

  const config: CustomEndpointConfig = {
    id: state.id.trim(),
    type: state.type,
    name: state.name.trim(),
    baseUrl: state.baseUrl.trim(),
    models,
  };
  if (state.apiKey.trim()) config.apiKey = state.apiKey.trim();
  if (headers) config.headers = headers;
  if (state.defaultModelId.trim()) config.defaultModelId = state.defaultModelId.trim();
  return config;
}

export async function testCustomEndpoint(
  state: EditorState
): Promise<{ success: boolean; message: string }> {
  const err = validateEditor(state);
  if (err) return { success: false, message: err };

  const url = state.baseUrl.trim().replace(/\/+$/, '');
  const probe =
    state.type === 'ollama-native'
      ? `${url}/api/tags`
      : state.type === 'anthropic-messages'
        ? `${url}/v1/models`
        : `${url}/models`;

  const headers: Record<string, string> = {};
  if (state.apiKey.trim()) headers.Authorization = `Bearer ${state.apiKey.trim()}`;
  try {
    const parsed = parseHeaders(state.headersText);
    if (parsed) Object.assign(headers, parsed);
  } catch {}

  const resp = await fetch(probe, { method: 'GET', headers });
  if (!resp.ok) {
    return { success: false, message: `Probe ${probe} → HTTP ${resp.status}` };
  }
  return { success: true, message: `Reached ${probe}` };
}

export function validateEditor(state: EditorState): string | null {
  if (!state.id.trim()) return 'Endpoint id is required';
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(state.id.trim()))
    return "Endpoint id must be a slug (letters, digits, '.', '_', '-')";
  if (!state.name.trim()) return 'Endpoint name is required';
  if (!state.baseUrl.trim()) return 'Base URL is required';
  try {
    const url = new URL(state.baseUrl.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return 'Base URL must use http:// or https://';
  } catch {
    return 'Base URL is invalid';
  }
  if (state.models.length === 0) return 'At least one model is required';
  const seen = new Set<string>();
  for (const m of state.models) {
    const id = m.id.trim();
    if (!id) return 'Every model must have an id';
    if (seen.has(id)) return `Duplicate model id '${id}'`;
    const pct = m.resolved.autoCompactPercent;
    if (
      pct !== undefined &&
      (!Number.isFinite(pct) ||
        !Number.isInteger(pct) ||
        pct < AUTO_COMPACT_PERCENT_MIN ||
        pct > AUTO_COMPACT_PERCENT_MAX)
    ) {
      return `Model '${id}': auto-compact percent must be between ${AUTO_COMPACT_PERCENT_MIN} and ${AUTO_COMPACT_PERCENT_MAX}`;
    }
    seen.add(id);
  }
  if (state.defaultModelId.trim() && !seen.has(state.defaultModelId.trim()))
    return `Default model '${state.defaultModelId}' not in models list`;
  try {
    parseHeaders(state.headersText);
  } catch (err) {
    return err instanceof Error ? err.message : 'Headers are invalid';
  }
  return null;
}

function ModelEditor({
  model,
  onChange,
  onRemove,
}: {
  model: ModelDraft;
  onChange: (next: ModelDraft) => void;
  onRemove: () => void;
}) {
  const update = (patch: Partial<ModelDraft>) => onChange({ ...model, ...patch });
  const updateCap = <K extends keyof CustomEndpointModelCapabilities>(
    key: K,
    value: CustomEndpointModelCapabilities[K]
  ) => {
    onChange({
      ...model,
      capabilities: { ...model.capabilities, [key]: value },
      resolved: { ...model.resolved, [key]: value },
    });
  };

  return (
    <div class="rounded-lg border border-line bg-surface/60 px-3 py-2.5 space-y-2">
      <div class="flex items-start gap-2">
        <div class="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            type="text"
            placeholder="Model id (e.g. qwen2.5-coder:14b)"
            aria-label="Model id"
            value={model.id}
            onInput={(e) => update({ id: e.currentTarget.value })}
            class="bg-bg border border-line rounded px-2 py-1 text-sm text-fg focus:outline-none focus:border-accent font-mono"
          />
          <input
            type="text"
            placeholder="Display name (optional)"
            aria-label="Model display name"
            value={model.name ?? ''}
            onInput={(e) => update({ name: e.currentTarget.value || undefined })}
            class="bg-bg border border-line rounded px-2 py-1 text-sm text-fg focus:outline-none focus:border-accent"
          />
          <input
            type="text"
            placeholder="Upstream model id (optional)"
            aria-label="Upstream model id"
            value={model.providerModelId ?? ''}
            onInput={(e) => update({ providerModelId: e.currentTarget.value || undefined })}
            class="bg-bg border border-line rounded px-2 py-1 text-sm text-fg focus:outline-none focus:border-accent font-mono"
          />
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove model"
          class="p-1.5 rounded hover:bg-danger/30 text-danger"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs">
        {(
          [
            ['streaming', 'Streaming'],
            ['toolUse', 'Tool use'],
            ['vision', 'Vision'],
            ['thinking', 'Thinking'],
            ['caching', 'Caching'],
            ['streamUsage', 'Stream usage'],
          ] as const
        ).map(([k, label]) => (
          <label key={k} class="flex items-center gap-1.5 text-fg-soft cursor-pointer">
            <input
              type="checkbox"
              checked={model.resolved[k]}
              onChange={(e) => updateCap(k, e.currentTarget.checked)}
              class="rounded border-line-strong bg-surface text-accent focus:ring-accent focus:ring-offset-0"
            />
            {label}
          </label>
        ))}
        <label class="flex items-center gap-1.5 text-fg-soft col-span-2">
          Context:
          <input
            type="number"
            min={1024}
            step={1024}
            value={model.resolved.maxContextTokens}
            aria-label="Max context tokens"
            onInput={(e) => {
              const v = Number(e.currentTarget.value);
              if (Number.isFinite(v) && v > 0) updateCap('maxContextTokens', v);
            }}
            class="w-24 bg-bg border border-line rounded px-1.5 py-0.5 text-xs text-fg focus:outline-none focus:border-accent"
          />
          tokens
        </label>
        <label class="flex items-center gap-1.5 text-fg-soft col-span-2">
          Auto-compact:
          <input
            type="number"
            min={AUTO_COMPACT_PERCENT_MIN}
            max={AUTO_COMPACT_PERCENT_MAX}
            step={5}
            value={model.resolved.autoCompactPercent}
            aria-label="Auto-compact percent"
            onInput={(e) => {
              const v = Number(e.currentTarget.value);
              if (Number.isFinite(v)) updateCap('autoCompactPercent', v);
            }}
            class="w-14 bg-bg border border-line rounded px-1.5 py-0.5 text-xs text-fg focus:outline-none focus:border-accent"
          />
          %
        </label>
      </div>
    </div>
  );
}

export interface EditorModalProps {
  state: EditorState;
  existingIds: string[];
  onChange: (next: EditorState) => void;
  onSave: () => void;
  onClose: () => void;
  saving: boolean;
  onTest: () => void;
  testing: boolean;
  onFetchModels: () => void;
  fetchingModels: boolean;
  fetchedModels: Array<{ id: string; name?: string }> | null;
  fetchModelsError: string | null;
  fetchedAt: number | null;
}

export function EditorModal({
  state,
  existingIds,
  onChange,
  onSave,
  onClose,
  saving,
  onTest,
  testing,
  onFetchModels,
  fetchingModels,
  fetchedModels,
  fetchModelsError,
  fetchedAt,
}: EditorModalProps) {
  const update = (patch: Partial<EditorState>) => onChange({ ...state, ...patch });
  const updateModel = (index: number, next: ModelDraft) => {
    const models = [...state.models];
    models[index] = next;
    update({ models });
  };
  const addModel = () =>
    update({
      models: [
        ...state.models,
        makeModelDraft(state.type, { capabilities: state.presetCapabilities }),
      ],
    });
  const removeModel = (index: number) =>
    update({ models: state.models.filter((_, i) => i !== index) });

  const idConflict =
    state.mode === 'create' &&
    state.id.trim() &&
    existingIds.includes(state.id.trim().toLowerCase());
  const validationError = validateEditor(state);

  useEffect(() => {
    if (fetchedModels !== null && state.selectedFetchedModelIds?.length) {
      update({ selectedFetchedModelIds: [] });
    }
  }, [fetchedModels]);

  const existingModelIds = new Set(state.models.map((m) => m.id.trim()));
  const selectableFetched = fetchedModels?.filter((m) => !existingModelIds.has(m.id)) ?? [];

  const toggleFetchedModel = (id: string) => {
    const current = new Set(state.selectedFetchedModelIds ?? []);
    if (current.has(id)) current.delete(id);
    else current.add(id);
    update({ selectedFetchedModelIds: [...current] });
  };

  const addSelectedFetchedModels = () => {
    const selected = new Set(state.selectedFetchedModelIds ?? []);
    const toAdd =
      fetchedModels?.filter((m) => selected.has(m.id) && !existingModelIds.has(m.id)) ?? [];
    if (toAdd.length === 0) return;
    const newDrafts = toAdd.map((m) =>
      makeModelDraft(state.type, {
        id: m.id,
        name: m.name,
        capabilities: state.presetCapabilities,
      })
    );
    update({
      models: [...state.models, ...newDrafts],
      selectedFetchedModelIds: [],
    });
  };

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4">
      <div class="bg-surface-overlay border border-line-strong rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div class="flex items-center justify-between px-4 py-3 border-b border-line">
          <h3 class="text-sm font-semibold text-fg">
            {state.mode === 'edit' ? `Edit endpoint — ${state.id}` : 'Add custom endpoint'}
          </h3>
          <button type="button" onClick={onClose} class="p-1 rounded hover:bg-fill-strong">
            <svg
              class="w-4 h-4 text-fg-muted"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div class="flex-1 overflow-y-auto p-4 space-y-4">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label class="block">
              <span class="text-xs font-medium text-fg-muted mb-1 block">Endpoint id</span>
              <input
                type="text"
                disabled={state.mode === 'edit'}
                value={state.id}
                placeholder="lmstudio"
                onInput={(e) => update({ id: e.currentTarget.value })}
                class={cn(
                  'w-full bg-bg border rounded px-2 py-1.5 text-sm text-fg font-mono focus:outline-none focus:border-accent',
                  idConflict ? 'border-danger' : 'border-line',
                  state.mode === 'edit' && 'opacity-60 cursor-not-allowed'
                )}
              />
              {idConflict && (
                <p class="text-xs text-danger mt-1">An endpoint with this id already exists</p>
              )}
            </label>
            <label class="block">
              <span class="text-xs font-medium text-fg-muted mb-1 block">Display name</span>
              <input
                type="text"
                value={state.name}
                placeholder="LM Studio"
                onInput={(e) => update({ name: e.currentTarget.value })}
                class="w-full bg-bg border border-line rounded px-2 py-1.5 text-sm text-fg focus:outline-none focus:border-accent"
              />
            </label>
            <label class="block">
              <span class="text-xs font-medium text-fg-muted mb-1 block">Type</span>
              <select
                value={state.type}
                onChange={(e) => {
                  const nextType = e.currentTarget.value as CustomEndpointType;
                  update({
                    type: nextType,
                    models: state.models.map((m) => ({
                      ...m,
                      resolved: resolveCapabilities(nextType, m.capabilities),
                    })),
                  });
                }}
                class="w-full bg-bg border border-line rounded px-2 py-1.5 text-sm text-fg focus:outline-none focus:border-accent"
              >
                {TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label class="block">
              <span class="text-xs font-medium text-fg-muted mb-1 block">API key (optional)</span>
              <input
                type="password"
                value={state.apiKey}
                placeholder="sk-..."
                onInput={(e) => update({ apiKey: e.currentTarget.value })}
                class="w-full bg-bg border border-line rounded px-2 py-1.5 text-sm text-fg focus:outline-none focus:border-accent font-mono"
              />
            </label>
            <label class="block sm:col-span-2">
              <span class="text-xs font-medium text-fg-muted mb-1 block">Base URL</span>
              <input
                type="url"
                value={state.baseUrl}
                placeholder="http://localhost:1234/v1"
                onInput={(e) => update({ baseUrl: e.currentTarget.value })}
                class="w-full bg-bg border border-line rounded px-2 py-1.5 text-sm text-fg focus:outline-none focus:border-accent font-mono"
              />
            </label>
            <label class="block sm:col-span-2">
              <span class="text-xs font-medium text-fg-muted mb-1 block">
                Extra headers (one per line, "Key: Value")
              </span>
              <textarea
                value={state.headersText}
                placeholder={'HTTP-Referer: https://example.com\nX-Title: HyperNeo'}
                onInput={(e) => update({ headersText: e.currentTarget.value })}
                class="w-full h-20 bg-bg border border-line rounded px-2 py-1.5 text-xs text-fg focus:outline-none focus:border-accent font-mono"
              />
            </label>
            <label class="block sm:col-span-2">
              <span class="text-xs font-medium text-fg-muted mb-1 block">
                Default model id (optional)
              </span>
              <select
                value={state.defaultModelId}
                onChange={(e) => update({ defaultModelId: e.currentTarget.value })}
                class="w-full bg-bg border border-line rounded px-2 py-1.5 text-sm text-fg focus:outline-none focus:border-accent"
              >
                <option value="">— none —</option>
                {state.models
                  .filter((m) => m.id.trim())
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  ))}
              </select>
            </label>
          </div>

          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <h4 class="text-xs font-semibold uppercase tracking-wider text-fg-muted">Models</h4>
              <div class="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={onFetchModels}
                  loading={fetchingModels}
                  disabled={!state.baseUrl.trim() || fetchingModels}
                >
                  Fetch models
                </Button>
                <Button size="xs" variant="secondary" onClick={addModel}>
                  Add model
                </Button>
              </div>
            </div>

            {fetchModelsError && <p class="text-xs text-danger">{fetchModelsError}</p>}

            {fetchedModels && (
              <div class="rounded-lg border border-line bg-surface/60 px-3 py-2.5 space-y-2">
                <div class="flex items-center justify-between">
                  <span class="text-xs text-fg-soft">
                    {fetchedModels.length} model{fetchedModels.length === 1 ? '' : 's'} found
                    {fetchedAt && (
                      <span class="text-fg-faint ml-1">
                        · fetched {new Date(fetchedAt).toLocaleTimeString()}
                      </span>
                    )}
                  </span>
                  {selectableFetched.length > 0 && (
                    <Button size="xs" variant="primary" onClick={addSelectedFetchedModels}>
                      Add selected
                    </Button>
                  )}
                </div>
                {selectableFetched.length === 0 ? (
                  <p class="text-xs text-fg-faint italic">All fetched models are already added.</p>
                ) : (
                  <div class="max-h-40 overflow-y-auto space-y-1">
                    {selectableFetched.map((m) => (
                      <label
                        key={m.id}
                        class="flex items-center gap-2 text-xs text-fg-soft cursor-pointer hover:bg-fill-soft rounded px-1 py-0.5"
                      >
                        <input
                          type="checkbox"
                          checked={(state.selectedFetchedModelIds ?? []).includes(m.id)}
                          onChange={() => toggleFetchedModel(m.id)}
                          class="rounded border-line-strong bg-surface text-accent focus:ring-accent focus:ring-offset-0"
                        />
                        <span class="font-mono">{m.id}</span>
                        {m.name && m.name !== m.id && <span class="text-fg-faint">{m.name}</span>}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {state.models.length === 0 ? (
              <p class="text-xs text-fg-faint italic">
                No models yet — add at least one to save the endpoint.
              </p>
            ) : (
              <div class="space-y-2">
                {state.models.map((m, i) => (
                  <ModelEditor
                    key={i}
                    model={m}
                    onChange={(next) => updateModel(i, next)}
                    onRemove={() => removeModel(i)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div class="px-4 py-3 border-t border-line flex items-center justify-between gap-2">
          <div class="text-xs text-danger truncate">{validationError ?? ''}</div>
          <div class="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={onTest}
              loading={testing}
              disabled={!!validationError || saving || testing}
            >
              Test connection
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={onSave}
              loading={saving}
              disabled={!!validationError || idConflict || saving}
            >
              {state.mode === 'edit' ? 'Save changes' : 'Add endpoint'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export interface PresetPickerProps {
  onPick: (preset: CustomEndpointPreset) => void;
  onClose: () => void;
}

export function PresetPicker({ onPick, onClose }: PresetPickerProps) {
  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4">
      <div class="bg-surface-overlay border border-line-strong rounded-lg shadow-xl w-full max-w-md max-h-[80vh] flex flex-col">
        <div class="flex items-center justify-between px-4 py-3 border-b border-line">
          <h3 class="text-sm font-semibold text-fg">Choose a preset</h3>
          <button type="button" onClick={onClose} class="p-1 rounded hover:bg-fill-strong">
            <svg
              class="w-4 h-4 text-fg-muted"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-2 space-y-1">
          {CUSTOM_ENDPOINT_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => onPick(preset)}
              class="w-full text-left px-3 py-2 rounded hover:bg-fill-strong transition-colors"
            >
              <div class="text-sm text-fg font-medium">{preset.label}</div>
              <div class="text-xs text-fg-faint mt-0.5">{preset.description}</div>
              {preset.apiKeyRequired && (
                <div class="text-[10px] text-warning mt-0.5">Requires API key</div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export const __test__ = {
  resolveCapabilities,
  parseHeaders,
  editorToConfig,
  validateEditor,
  presetToEditor,
  existingToEditor,
  findPreset,
  makeModelDraft,
};
