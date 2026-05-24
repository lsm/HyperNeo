/**
 * CustomEndpointsSettings
 *
 * CRUD over user-defined custom API endpoints (`settings.customEndpoints`).
 * Backed by the daemon `customEndpoints.list/add/update/remove` RPCs.
 *
 * The picker exposes stock presets (Ollama, OpenRouter, LM Studio, LiteLLM,
 * Anthropic proxy) which pre-fill the editor with sensible defaults. The user
 * confirms / customises before saving.
 *
 * Validation mirrors the daemon-side `validateCustomEndpoint`:
 *   - id required, slug-like
 *   - baseUrl must parse as http(s)
 *   - at least one model
 *   - distinct model ids
 *   - defaultModelId (when set) must match a model
 */

import { useEffect, useState } from 'preact/hooks';
import type {
  CustomEndpointConfig,
  CustomEndpointModel,
  CustomEndpointModelCapabilities,
  CustomEndpointType,
} from '@neokai/shared';
import {
  DEFAULT_CUSTOM_ENDPOINT_CAPABILITIES,
  CUSTOM_ENDPOINT_TYPE_CAPABILITY_DEFAULTS,
} from '@neokai/shared';
import {
  listCustomEndpoints,
  addCustomEndpoint,
  updateCustomEndpoint,
  removeCustomEndpoint,
} from '../../lib/api-helpers.ts';
import { connectionManager } from '../../lib/connection-manager';
import { toast } from '../../lib/toast.ts';
import { SettingsSection } from './SettingsSection.tsx';
import { Button } from '../ui/Button.tsx';
import { Spinner } from '../ui/Spinner';
import { cn } from '../../lib/utils.ts';
import {
  CUSTOM_ENDPOINT_PRESETS,
  findPreset,
  type CustomEndpointPreset,
} from './customEndpointPresets.ts';

const TYPE_OPTIONS: Array<{ value: CustomEndpointType; label: string }> = [
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'ollama-native', label: 'Ollama Native' },
];

interface ModelDraft extends CustomEndpointModel {
  /** Resolved capability values for the editor (defaults applied). */
  resolved: CustomEndpointModelCapabilities;
}

/** Resolve effective capabilities given the global+per-type defaults. */
function resolveCapabilities(
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

function makeModelDraft(
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

interface EditorState {
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
  /**
   * Capability overrides carried from the chosen preset (if any). Applied to
   * every newly added model so preset behaviour (e.g. `streamUsage: true` for
   * OpenRouter / LiteLLM) follows through the editor instead of being lost
   * on subsequent `addModel` clicks.
   */
  presetCapabilities?: Partial<CustomEndpointModelCapabilities>;
}

function presetToEditor(preset: CustomEndpointPreset): EditorState {
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

function existingToEditor(config: CustomEndpointConfig): EditorState {
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

function parseHeaders(text: string): Record<string, string> | undefined {
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

function editorToConfig(state: EditorState): CustomEndpointConfig {
  const headers = parseHeaders(state.headersText);
  const models = state.models.map((m): CustomEndpointModel => {
    const out: CustomEndpointModel = { id: m.id.trim() };
    if (m.name?.trim()) out.name = m.name.trim();
    if (m.providerModelId?.trim()) out.providerModelId = m.providerModelId.trim();
    // Persist only fields the user explicitly changed away from defaults.
    const baseDefaults = resolveCapabilities(state.type);
    const delta: Partial<CustomEndpointModelCapabilities> = {};
    const keys: (keyof CustomEndpointModelCapabilities)[] = [
      'streaming',
      'toolUse',
      'vision',
      'thinking',
      'caching',
      'maxContextTokens',
      'streamUsage',
    ];
    for (const k of keys) {
      if (m.resolved[k] !== baseDefaults[k]) {
        // Typed indexed write into the same-shape partial.
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

function validateEditor(state: EditorState): string | null {
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

// ─── Capability badge component ───────────────────────────────────────────────

function CapabilityBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      class={cn(
        'inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded',
        active ? 'bg-blue-900/40 text-blue-300' : 'bg-dark-800 text-gray-600'
      )}
    >
      {label}
    </span>
  );
}

// ─── Model row editor ─────────────────────────────────────────────────────────

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
    // Persist the override in `capabilities` so it survives subsequent type
    // changes (which re-resolve `resolved` from `capabilities`). Without this
    // write, toggling a checkbox and then switching the endpoint type would
    // silently discard the edit.
    onChange({
      ...model,
      capabilities: { ...model.capabilities, [key]: value },
      resolved: { ...model.resolved, [key]: value },
    });
  };

  return (
    <div class="rounded-lg border border-white/[0.08] bg-dark-900/60 px-3 py-2.5 space-y-2">
      <div class="flex items-start gap-2">
        <div class="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            type="text"
            placeholder="Model id (e.g. qwen2.5-coder:14b)"
            aria-label="Model id"
            value={model.id}
            onInput={(e) => update({ id: e.currentTarget.value })}
            class="bg-dark-950 border border-dark-700 rounded px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-blue-500 font-mono"
          />
          <input
            type="text"
            placeholder="Display name (optional)"
            aria-label="Model display name"
            value={model.name ?? ''}
            onInput={(e) => update({ name: e.currentTarget.value || undefined })}
            class="bg-dark-950 border border-dark-700 rounded px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
          />
          <input
            type="text"
            placeholder="Upstream model id (optional)"
            aria-label="Upstream model id"
            value={model.providerModelId ?? ''}
            onInput={(e) => update({ providerModelId: e.currentTarget.value || undefined })}
            class="bg-dark-950 border border-dark-700 rounded px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-blue-500 font-mono"
          />
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove model"
          class="p-1.5 rounded hover:bg-red-900/30 text-red-400"
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
          <label key={k} class="flex items-center gap-1.5 text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={model.resolved[k]}
              onChange={(e) => updateCap(k, e.currentTarget.checked)}
              class="rounded border-dark-600 bg-dark-900 text-blue-600 focus:ring-blue-500 focus:ring-offset-0"
            />
            {label}
          </label>
        ))}
        <label class="flex items-center gap-1.5 text-gray-300 col-span-2">
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
            class="w-24 bg-dark-950 border border-dark-700 rounded px-1.5 py-0.5 text-xs text-gray-100 focus:outline-none focus:border-blue-500"
          />
          tokens
        </label>
      </div>
    </div>
  );
}

// ─── Editor modal ─────────────────────────────────────────────────────────────

function EditorModal({
  state,
  existingIds,
  onChange,
  onSave,
  onClose,
  saving,
  onTest,
  testing,
}: {
  state: EditorState;
  existingIds: string[];
  onChange: (next: EditorState) => void;
  onSave: () => void;
  onClose: () => void;
  saving: boolean;
  onTest: () => void;
  testing: boolean;
}) {
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

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div class="bg-dark-850 border border-dark-600 rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div class="flex items-center justify-between px-4 py-3 border-b border-dark-700">
          <h3 class="text-sm font-semibold text-gray-100">
            {state.mode === 'edit' ? `Edit endpoint — ${state.id}` : 'Add custom endpoint'}
          </h3>
          <button type="button" onClick={onClose} class="p-1 rounded hover:bg-dark-700">
            <svg
              class="w-4 h-4 text-gray-400"
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
              <span class="text-xs font-medium text-gray-400 mb-1 block">Endpoint id</span>
              <input
                type="text"
                disabled={state.mode === 'edit'}
                value={state.id}
                placeholder="lmstudio"
                onInput={(e) => update({ id: e.currentTarget.value })}
                class={cn(
                  'w-full bg-dark-950 border rounded px-2 py-1.5 text-sm text-gray-100 font-mono focus:outline-none focus:border-blue-500',
                  idConflict ? 'border-red-700' : 'border-dark-700',
                  state.mode === 'edit' && 'opacity-60 cursor-not-allowed'
                )}
              />
              {idConflict && (
                <p class="text-xs text-red-400 mt-1">An endpoint with this id already exists</p>
              )}
            </label>
            <label class="block">
              <span class="text-xs font-medium text-gray-400 mb-1 block">Display name</span>
              <input
                type="text"
                value={state.name}
                placeholder="LM Studio"
                onInput={(e) => update({ name: e.currentTarget.value })}
                class="w-full bg-dark-950 border border-dark-700 rounded px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              />
            </label>
            <label class="block">
              <span class="text-xs font-medium text-gray-400 mb-1 block">Type</span>
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
                class="w-full bg-dark-950 border border-dark-700 rounded px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              >
                {TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label class="block">
              <span class="text-xs font-medium text-gray-400 mb-1 block">API key (optional)</span>
              <input
                type="password"
                value={state.apiKey}
                placeholder="sk-..."
                onInput={(e) => update({ apiKey: e.currentTarget.value })}
                class="w-full bg-dark-950 border border-dark-700 rounded px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500 font-mono"
              />
            </label>
            <label class="block sm:col-span-2">
              <span class="text-xs font-medium text-gray-400 mb-1 block">Base URL</span>
              <input
                type="url"
                value={state.baseUrl}
                placeholder="http://localhost:1234/v1"
                onInput={(e) => update({ baseUrl: e.currentTarget.value })}
                class="w-full bg-dark-950 border border-dark-700 rounded px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500 font-mono"
              />
            </label>
            <label class="block sm:col-span-2">
              <span class="text-xs font-medium text-gray-400 mb-1 block">
                Extra headers (one per line, "Key: Value")
              </span>
              <textarea
                value={state.headersText}
                placeholder={'HTTP-Referer: https://example.com\nX-Title: NeoKai'}
                onInput={(e) => update({ headersText: e.currentTarget.value })}
                class="w-full h-20 bg-dark-950 border border-dark-700 rounded px-2 py-1.5 text-xs text-gray-100 focus:outline-none focus:border-blue-500 font-mono"
              />
            </label>
            <label class="block sm:col-span-2">
              <span class="text-xs font-medium text-gray-400 mb-1 block">
                Default model id (optional)
              </span>
              <select
                value={state.defaultModelId}
                onChange={(e) => update({ defaultModelId: e.currentTarget.value })}
                class="w-full bg-dark-950 border border-dark-700 rounded px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
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
              <h4 class="text-xs font-semibold uppercase tracking-wider text-gray-400">Models</h4>
              <Button size="xs" variant="secondary" onClick={addModel}>
                Add model
              </Button>
            </div>
            {state.models.length === 0 ? (
              <p class="text-xs text-gray-500 italic">
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

        <div class="px-4 py-3 border-t border-dark-700 flex items-center justify-between gap-2">
          <div class="text-xs text-red-400 truncate">{validationError ?? ''}</div>
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

// ─── Preset picker ────────────────────────────────────────────────────────────

function PresetPicker({
  onPick,
  onClose,
}: {
  onPick: (preset: CustomEndpointPreset) => void;
  onClose: () => void;
}) {
  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div class="bg-dark-850 border border-dark-600 rounded-lg shadow-xl w-full max-w-md max-h-[80vh] flex flex-col">
        <div class="flex items-center justify-between px-4 py-3 border-b border-dark-700">
          <h3 class="text-sm font-semibold text-gray-100">Choose a preset</h3>
          <button type="button" onClick={onClose} class="p-1 rounded hover:bg-dark-700">
            <svg
              class="w-4 h-4 text-gray-400"
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
              class="w-full text-left px-3 py-2 rounded hover:bg-dark-700 transition-colors"
            >
              <div class="text-sm text-gray-100 font-medium">{preset.label}</div>
              <div class="text-xs text-gray-500 mt-0.5">{preset.description}</div>
              {preset.apiKeyRequired && (
                <div class="text-[10px] text-amber-400 mt-0.5">Requires API key</div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function CustomEndpointsSettings() {
  const [endpoints, setEndpoints] = useState<CustomEndpointConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [showPresets, setShowPresets] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = async () => {
    try {
      setLoading(true);
      const { endpoints: list } = await listCustomEndpoints();
      setEndpoints(list);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load custom endpoints');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handlePickPreset = (preset: CustomEndpointPreset) => {
    setShowPresets(false);
    // Avoid id collisions — append `-N` until unique.
    let candidateId = preset.template.id ?? 'custom';
    const taken = new Set(endpoints.map((e) => e.id));
    let suffix = 1;
    const base = candidateId;
    while (taken.has(candidateId)) {
      suffix += 1;
      candidateId = `${base}-${suffix}`;
    }
    setEditor({ ...presetToEditor(preset), id: candidateId });
  };

  const handleSave = async () => {
    if (!editor) return;
    const err = validateEditor(editor);
    if (err) {
      toast.error(err);
      return;
    }
    try {
      setSaving(true);
      const config = editorToConfig(editor);
      if (editor.mode === 'edit') {
        await updateCustomEndpoint(config);
        toast.success(`Updated '${config.name}'`);
      } else {
        await addCustomEndpoint(config);
        toast.success(`Added '${config.name}'`);
      }
      setEditor(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (config: CustomEndpointConfig) => {
    if (!confirm(`Remove custom endpoint '${config.name}'?`)) return;
    try {
      setRemovingId(config.id);
      await removeCustomEndpoint(config.id);
      toast.success(`Removed '${config.name}'`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Remove failed');
    } finally {
      setRemovingId(null);
    }
  };

  const handleTest = async () => {
    if (!editor) return;
    const err = validateEditor(editor);
    if (err) {
      toast.error(err);
      return;
    }
    try {
      setTesting(true);
      // Probe the upstream `models` endpoint (or `tags` for Ollama) directly
      // from the browser — no daemon round-trip needed. Endpoints reachable
      // from the daemon may not be reachable from the browser; in that case
      // the user will see a CORS / network error and can rely on a save
      // + force-refresh to verify daemon-side connectivity.
      const url = editor.baseUrl.replace(/\/+$/, '');
      const probe =
        editor.type === 'ollama-native'
          ? `${url}/api/tags`
          : editor.type === 'anthropic-messages'
            ? `${url}/v1/models`
            : `${url}/models`;
      const headers: Record<string, string> = {};
      if (editor.apiKey.trim()) headers.Authorization = `Bearer ${editor.apiKey.trim()}`;
      try {
        const parsed = parseHeaders(editor.headersText);
        if (parsed) Object.assign(headers, parsed);
      } catch {
        // Validated above
      }
      const resp = await fetch(probe, { method: 'GET', headers });
      if (!resp.ok) {
        toast.error(`Probe ${probe} → HTTP ${resp.status}`);
        return;
      }
      toast.success(`Reached ${probe}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  const existingIds = endpoints.map((e) => e.id.toLowerCase());

  return (
    <SettingsSection title="Custom Endpoints">
      <p class="text-xs text-gray-500 px-1">
        User-defined API endpoints. Each entry registers a provider with id{' '}
        <code class="bg-dark-800 px-1 rounded text-[11px]">custom:&lt;id&gt;</code>. Models become
        selectable in the model picker.
      </p>

      {loading ? (
        <div class="flex items-center gap-2 text-xs text-gray-500 px-1">
          <Spinner size="xs" />
          Loading endpoints...
        </div>
      ) : endpoints.length === 0 ? (
        <div class="rounded-lg border border-dashed border-dark-600 px-4 py-6 text-center">
          <p class="text-sm text-gray-400">No custom endpoints configured.</p>
          <p class="text-xs text-gray-500 mt-1">
            Add one to use a self-hosted or third-party model.
          </p>
        </div>
      ) : (
        <div class="space-y-2">
          {endpoints.map((endpoint) => {
            const type = endpoint.type ?? 'openai-chat';
            return (
              <div
                key={endpoint.id}
                class="rounded-lg border border-white/[0.08] bg-white/[0.025] px-4 py-3"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="text-sm font-medium text-gray-100">{endpoint.name}</span>
                      <span class="text-[10px] uppercase tracking-wide text-gray-500 px-1.5 py-0.5 rounded bg-dark-800">
                        {type}
                      </span>
                      <code class="text-[11px] text-gray-500 font-mono">custom:{endpoint.id}</code>
                    </div>
                    <div class="text-xs text-gray-500 mt-1 truncate font-mono">
                      {endpoint.baseUrl}
                    </div>
                    <div class="mt-2 flex flex-wrap gap-1.5">
                      {endpoint.models.map((m) => {
                        const resolved = resolveCapabilities(type, m.capabilities);
                        return (
                          <div
                            key={m.id}
                            class="flex items-center gap-1 px-2 py-0.5 bg-dark-900 border border-dark-700 rounded-full"
                          >
                            <span class="text-xs text-gray-200">{m.name ?? m.id}</span>
                            {resolved.toolUse && <CapabilityBadge label="tools" active />}
                            {resolved.vision && <CapabilityBadge label="vision" active />}
                            {resolved.thinking && <CapabilityBadge label="think" active />}
                            <span class="text-[10px] text-gray-500">
                              {Math.round(resolved.maxContextTokens / 1000)}k
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div class="flex-shrink-0 flex gap-1.5">
                    <Button
                      size="xs"
                      variant="secondary"
                      onClick={() => setEditor(existingToEditor(endpoint))}
                    >
                      Edit
                    </Button>
                    <Button
                      size="xs"
                      variant="danger"
                      onClick={() => handleRemove(endpoint)}
                      loading={removingId === endpoint.id}
                      disabled={removingId !== null}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div class="flex gap-2 pt-1">
        <Button size="sm" variant="primary" onClick={() => setShowPresets(true)}>
          Add provider
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            // Force a model-list refresh so newly added providers surface in the picker
            // immediately.
            void (async () => {
              try {
                const hub = connectionManager.getHubIfConnected();
                if (!hub) return;
                await hub.request('models.list', { forceRefresh: true });
                toast.success('Models refreshed');
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Refresh failed');
              }
            })();
          }}
        >
          Refresh models
        </Button>
      </div>

      {showPresets && (
        <PresetPicker onPick={handlePickPreset} onClose={() => setShowPresets(false)} />
      )}

      {editor && (
        <EditorModal
          state={editor}
          existingIds={existingIds.filter((id) => id !== editor.original?.id)}
          onChange={setEditor}
          onSave={handleSave}
          onClose={() => setEditor(null)}
          saving={saving}
          onTest={handleTest}
          testing={testing}
        />
      )}
    </SettingsSection>
  );
}

// Re-export helpers for testing.
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
