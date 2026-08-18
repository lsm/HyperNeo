import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/preact';

const {
  mockListCustomEndpoints,
  mockAddCustomEndpoint,
  mockUpdateCustomEndpoint,
  mockRemoveCustomEndpoint,
  mockToastError,
  mockToastSuccess,
} = vi.hoisted(() => ({
  mockListCustomEndpoints: vi.fn(),
  mockAddCustomEndpoint: vi.fn(),
  mockUpdateCustomEndpoint: vi.fn(),
  mockRemoveCustomEndpoint: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock('../../../lib/api-helpers.ts', () => ({
  listCustomEndpoints: () => mockListCustomEndpoints(),
  addCustomEndpoint: (e: unknown) => mockAddCustomEndpoint(e),
  updateCustomEndpoint: (e: unknown) => mockUpdateCustomEndpoint(e),
  removeCustomEndpoint: (id: string) => mockRemoveCustomEndpoint(id),
}));

vi.mock('../../../lib/toast.ts', () => ({
  toast: {
    error: (msg: string) => mockToastError(msg),
    success: (msg: string) => mockToastSuccess(msg),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => null,
  },
}));

import { CustomEndpointsSettings } from '../CustomEndpointsSettings.tsx';
import { __test__, EditorModal } from '../CustomEndpointEditor.tsx';
import { CUSTOM_ENDPOINT_PRESETS, findPreset } from '../customEndpointPresets.ts';
import type { CustomEndpointConfig } from '@hyperneo/shared';

describe('CustomEndpointsSettings — helpers', () => {
  it('resolveCapabilities applies type + global defaults', () => {
    const caps = __test__.resolveCapabilities('ollama-native');
    expect(caps.streaming).toBe(true);
    expect(caps.thinking).toBe(false);
    expect(caps.caching).toBe(false);
    expect(__test__.resolveCapabilities('anthropic-messages').thinking).toBe(true);
  });

  it('resolveCapabilities lets per-model override win', () => {
    const caps = __test__.resolveCapabilities('ollama-native', {
      thinking: true,
      maxContextTokens: 32000,
    });
    expect(caps.thinking).toBe(true);
    expect(caps.maxContextTokens).toBe(32000);
  });

  it('parseHeaders parses Key: Value lines', () => {
    const h = __test__.parseHeaders('A: 1\nB: 2');
    expect(h).toEqual({ A: '1', B: '2' });
  });

  it('parseHeaders rejects bad lines', () => {
    expect(() => __test__.parseHeaders('nope')).toThrow();
  });

  it('parseHeaders returns undefined for empty input', () => {
    expect(__test__.parseHeaders('')).toBeUndefined();
    expect(__test__.parseHeaders('  \n  ')).toBeUndefined();
  });

  it('validateEditor catches missing id / bad URL', () => {
    const base = __test__.presetToEditor(findPreset('blank')!);
    expect(__test__.validateEditor({ ...base, id: '' })).toMatch(/id is required/i);
    expect(
      __test__.validateEditor({ ...base, id: 'has space', baseUrl: 'http://x', models: [] })
    ).toMatch(/slug/i);
    expect(__test__.validateEditor({ ...base, id: 'ok', baseUrl: '' })).toMatch(/base url/i);
    expect(__test__.validateEditor({ ...base, id: 'ok', baseUrl: 'ftp://nope' })).toMatch(/http/i);
  });

  it('validateEditor requires at least one model and rejects duplicates', () => {
    const base = __test__.presetToEditor(findPreset('lmstudio')!);
    expect(__test__.validateEditor({ ...base, models: [] })).toMatch(/at least one/i);
    const m1 = __test__.makeModelDraft('openai-chat', { id: 'a' });
    expect(__test__.validateEditor({ ...base, models: [m1, m1] })).toMatch(/duplicate/i);
  });

  it('editorToConfig drops capability fields equal to resolved defaults', () => {
    const editor = __test__.presetToEditor(findPreset('lmstudio')!);
    editor.id = 'lm-test';
    editor.name = 'LM Test';
    editor.baseUrl = 'http://localhost:1234/v1';
    const m = __test__.makeModelDraft('openai-chat', { id: 'qwen2' });
    m.resolved = { ...m.resolved, thinking: true };
    editor.models = [m];
    const cfg = __test__.editorToConfig(editor);
    expect(cfg.models[0]?.capabilities).toEqual({ thinking: true });
  });

  it('editorToConfig preserves chatTemplateKwargs through existingToEditor round-trip', () => {
    const original: CustomEndpointConfig = {
      id: 'qwen3',
      type: 'openai-chat',
      name: 'Qwen3',
      baseUrl: 'http://localhost:1234/v1',
      models: [
        {
          id: 'qwen3:32b',
          capabilities: {
            chatTemplateKwargs: { enable_thinking: false },
          },
        },
      ],
      defaultModelId: 'qwen3:32b',
    };
    const editor = __test__.existingToEditor(original);
    const roundTripped = __test__.editorToConfig(editor);
    expect(roundTripped.models[0]?.capabilities?.chatTemplateKwargs).toEqual({
      enable_thinking: false,
    });
  });

  it('editorToConfig persists baseUrl + apiKey + headers when set', () => {
    const editor = __test__.presetToEditor(findPreset('openrouter')!);
    editor.id = 'or';
    editor.name = 'OR';
    editor.baseUrl = 'https://openrouter.ai/api/v1';
    editor.apiKey = 'sk-xx';
    editor.headersText = 'X-Title: HyperNeo';
    editor.models = [__test__.makeModelDraft('openai-chat', { id: 'mistral' })];
    const cfg = __test__.editorToConfig(editor);
    expect(cfg.apiKey).toBe('sk-xx');
    expect(cfg.headers).toEqual({ 'X-Title': 'HyperNeo' });
    expect(cfg.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('presetToEditor carries defaultModelCapabilities onto the editor state', () => {
    const editor = __test__.presetToEditor(findPreset('openrouter')!);
    expect(editor.presetCapabilities?.streamUsage).toBe(true);
    const fresh = __test__.makeModelDraft(editor.type, {
      capabilities: editor.presetCapabilities,
    });
    expect(fresh.resolved.streamUsage).toBe(true);
  });

  it('capability edits survive an endpoint type switch', () => {
    const base = __test__.presetToEditor(findPreset('blank')!);
    base.id = 'x';
    base.name = 'X';
    base.baseUrl = 'http://localhost:9999';

    const initial = __test__.makeModelDraft('openai-chat', { id: 'm1' });
    expect(initial.resolved.thinking).toBe(false);

    const edited = {
      ...initial,
      capabilities: { ...initial.capabilities, thinking: true as const },
      resolved: { ...initial.resolved, thinking: true },
    };

    const afterTypeChange = {
      ...edited,
      resolved: __test__.resolveCapabilities('ollama-native', edited.capabilities),
    };
    expect(afterTypeChange.resolved.thinking).toBe(true);

    base.type = 'ollama-native';
    base.models = [afterTypeChange];
    const cfg = __test__.editorToConfig(base);
    expect(cfg.models[0]?.capabilities?.thinking).toBe(true);
  });
});

describe('CustomEndpointsSettings — presets', () => {
  it('exposes the four required presets', () => {
    const keys = CUSTOM_ENDPOINT_PRESETS.map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(['ollama', 'openrouter', 'lmstudio', 'litellm']));
  });

  it('Ollama preset disables thinking + caching by default', () => {
    const p = findPreset('ollama')!;
    expect(p.defaultModelCapabilities?.thinking).toBe(false);
    expect(p.defaultModelCapabilities?.caching).toBe(false);
  });

  it('OpenRouter preset marks apiKeyRequired and seeds stream usage', () => {
    const p = findPreset('openrouter')!;
    expect(p.apiKeyRequired).toBe(true);
    expect(p.defaultModelCapabilities?.streamUsage).toBe(true);
  });
});

describe('EditorModal — fetch models', () => {
  const baseState = (): import('../CustomEndpointEditor.tsx').EditorState => ({
    mode: 'create',
    id: 'test',
    type: 'openai-chat',
    name: 'Test',
    baseUrl: 'http://localhost:1234/v1',
    apiKey: '',
    headersText: '',
    defaultModelId: '',
    models: [],
  });

  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows fetch models button and disabled state when baseUrl is empty', async () => {
    const state = { ...baseState(), baseUrl: '' };
    render(
      <EditorModal
        state={state}
        existingIds={[]}
        onChange={() => {}}
        onSave={() => {}}
        onClose={() => {}}
        saving={false}
        onTest={() => {}}
        testing={false}
        onFetchModels={() => {}}
        fetchingModels={false}
        fetchedModels={null}
        fetchModelsError={null}
        fetchedAt={null}
      />
    );
    const fetchBtn = screen.getAllByText('Fetch models')[0] as HTMLButtonElement;
    expect(fetchBtn).toBeTruthy();
    expect(fetchBtn.disabled).toBe(true);
  });

  it('renders fetched models as checkboxes', async () => {
    const state = baseState();
    const { container } = render(
      <EditorModal
        state={state}
        existingIds={[]}
        onChange={() => {}}
        onSave={() => {}}
        onClose={() => {}}
        saving={false}
        onTest={() => {}}
        testing={false}
        onFetchModels={() => {}}
        fetchingModels={false}
        fetchedModels={[{ id: 'gpt-4' }, { id: 'gpt-3.5-turbo', name: 'GPT-3.5' }]}
        fetchModelsError={null}
        fetchedAt={Date.now()}
      />
    );
    await waitFor(() => {
      expect(container.textContent).toContain('2 models found');
      expect(container.textContent).toContain('gpt-4');
      expect(container.textContent).toContain('GPT-3.5');
    });
  });

  it('calls onChange with selected models when adding fetched models', async () => {
    let changedState: import('../CustomEndpointEditor.tsx').EditorState | null = null;
    const state = { ...baseState(), selectedFetchedModelIds: ['gpt-4'] };
    const { container } = render(
      <EditorModal
        state={state}
        existingIds={[]}
        onChange={(s) => {
          changedState = s;
        }}
        onSave={() => {}}
        onClose={() => {}}
        saving={false}
        onTest={() => {}}
        testing={false}
        onFetchModels={() => {}}
        fetchingModels={false}
        fetchedModels={[{ id: 'gpt-4' }]}
        fetchModelsError={null}
        fetchedAt={Date.now()}
      />
    );
    const addBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add selected')
    );
    expect(addBtn).toBeTruthy();
    if (addBtn) fireEvent.click(addBtn);

    await waitFor(() => {
      expect(changedState).not.toBeNull();
    });
    expect(changedState!.models).toHaveLength(1);
    expect(changedState!.models[0].id).toBe('gpt-4');
    expect(changedState!.selectedFetchedModelIds).toEqual([]);
  });

  it('shows error message when fetch fails', async () => {
    const state = baseState();
    const { container } = render(
      <EditorModal
        state={state}
        existingIds={[]}
        onChange={() => {}}
        onSave={() => {}}
        onClose={() => {}}
        saving={false}
        onTest={() => {}}
        testing={false}
        onFetchModels={() => {}}
        fetchingModels={false}
        fetchedModels={null}
        fetchModelsError="Connection refused"
        fetchedAt={null}
      />
    );
    await waitFor(() => {
      expect(container.textContent).toContain('Connection refused');
    });
  });
});
