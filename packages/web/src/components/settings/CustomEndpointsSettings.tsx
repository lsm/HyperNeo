import { useEffect, useState } from 'preact/hooks';
import type { CustomEndpointConfig } from '@hyperneo/shared';
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
import {
  EditorModal,
  PresetPicker,
  presetToEditor,
  existingToEditor,
  validateEditor,
  editorToConfig,
  parseHeaders,
  resolveCapabilities,
  type EditorState,
} from './CustomEndpointEditor.tsx';
import { useFetchModels } from './useFetchModels.ts';
import { findPreset } from './customEndpointPresets.ts';

export function CustomEndpointsSettings() {
  const [endpoints, setEndpoints] = useState<CustomEndpointConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [showPresets, setShowPresets] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const { fetchingModels, fetchedModels, fetchModelsError, fetchedAt, handleFetchModels } =
    useFetchModels(editor);

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

  const handlePickPreset = (preset: import('./customEndpointPresets.ts').CustomEndpointPreset) => {
    setShowPresets(false);
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
      } catch {}
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
      <p class="text-xs text-fg-faint px-1">
        User-defined API endpoints. Each entry registers a provider with id{' '}
        <code class="bg-surface-raised px-1 rounded text-[11px]">custom:&lt;id&gt;</code>. Models
        become selectable in the model picker.
      </p>

      {loading ? (
        <div class="flex items-center gap-2 text-xs text-fg-faint px-1">
          <Spinner size="xs" />
          Loading endpoints...
        </div>
      ) : endpoints.length === 0 ? (
        <div class="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center">
          <p class="text-sm text-fg-muted">No custom endpoints configured.</p>
          <p class="text-xs text-fg-faint mt-1">
            Add one to use a self-hosted or third-party model.
          </p>
        </div>
      ) : (
        <div class="space-y-2">
          {endpoints.map((endpoint) => {
            const type = endpoint.type ?? 'openai-chat';
            return (
              <div key={endpoint.id} class="rounded-lg border border-line bg-fill-soft px-4 py-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="text-sm font-medium text-fg">{endpoint.name}</span>
                      <span class="text-[10px] uppercase tracking-wide text-fg-faint px-1.5 py-0.5 rounded bg-surface-raised">
                        {type}
                      </span>
                      <code class="text-[11px] text-fg-faint font-mono">custom:{endpoint.id}</code>
                    </div>
                    <div class="text-xs text-fg-faint mt-1 truncate font-mono">
                      {endpoint.baseUrl}
                    </div>
                    <div class="mt-2 flex flex-wrap gap-1.5">
                      {endpoint.models.map((m) => {
                        const resolved = resolveCapabilities(type, m.capabilities);
                        return (
                          <div
                            key={m.id}
                            class="flex items-center gap-1 px-2 py-0.5 bg-surface border border-line rounded-full"
                          >
                            <span class="text-xs text-fg-soft">{m.name ?? m.id}</span>
                            {resolved.toolUse && (
                              <span class="text-[10px] text-accent-soft">tools</span>
                            )}
                            {resolved.vision && (
                              <span class="text-[10px] text-accent-soft">vision</span>
                            )}
                            {resolved.thinking && (
                              <span class="text-[10px] text-accent-soft">think</span>
                            )}
                            <span class="text-[10px] text-fg-faint">
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
          onFetchModels={handleFetchModels}
          fetchingModels={fetchingModels}
          fetchedModels={fetchedModels}
          fetchModelsError={fetchModelsError}
          fetchedAt={fetchedAt}
        />
      )}
    </SettingsSection>
  );
}

export {
  resolveCapabilities,
  parseHeaders,
  editorToConfig,
  validateEditor,
  presetToEditor,
  existingToEditor,
  makeModelDraft,
} from './CustomEndpointEditor.tsx';
export { findPreset } from './customEndpointPresets.ts';

import {
  resolveCapabilities as _resolveCapabilities,
  parseHeaders as _parseHeaders,
  editorToConfig as _editorToConfig,
  validateEditor as _validateEditor,
  presetToEditor as _presetToEditor,
  existingToEditor as _existingToEditor,
  makeModelDraft as _makeModelDraft,
} from './CustomEndpointEditor.tsx';

export const __test__ = {
  resolveCapabilities: _resolveCapabilities,
  parseHeaders: _parseHeaders,
  editorToConfig: _editorToConfig,
  validateEditor: _validateEditor,
  presetToEditor: _presetToEditor,
  existingToEditor: _existingToEditor,
  findPreset,
  makeModelDraft: _makeModelDraft,
};
