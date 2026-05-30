/**
 * Tests for CustomEndpointsSettings + presets.
 *
 * Covers pure helpers (validateEditor, parseHeaders, editorToConfig,
 * resolveCapabilities, presetToEditor) and a thin render path to verify
 * the load → list pipeline and the preset → editor flow.
 */

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
import { __test__ } from '../CustomEndpointEditor.tsx';
import { CUSTOM_ENDPOINT_PRESETS, findPreset } from '../customEndpointPresets.ts';

describe('CustomEndpointsSettings — helpers', () => {
  it('resolveCapabilities applies type + global defaults', () => {
    const caps = __test__.resolveCapabilities('ollama-native');
    expect(caps.streaming).toBe(true);
    // ollama-native disables thinking + caching
    expect(caps.thinking).toBe(false);
    expect(caps.caching).toBe(false);
    // anthropic-messages enables thinking
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
    // Only `thinking` should be persisted as a delta since the rest match defaults.
    expect(cfg.models[0]?.capabilities).toEqual({ thinking: true });
  });

  it('editorToConfig persists baseUrl + apiKey + headers when set', () => {
    const editor = __test__.presetToEditor(findPreset('openrouter')!);
    editor.id = 'or';
    editor.name = 'OR';
    editor.baseUrl = 'https://openrouter.ai/api/v1';
    editor.apiKey = 'sk-xx';
    editor.headersText = 'X-Title: NeoKai';
    editor.models = [__test__.makeModelDraft('openai-chat', { id: 'mistral' })];
    const cfg = __test__.editorToConfig(editor);
    expect(cfg.apiKey).toBe('sk-xx');
    expect(cfg.headers).toEqual({ 'X-Title': 'NeoKai' });
    expect(cfg.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('presetToEditor carries defaultModelCapabilities onto the editor state', () => {
    const editor = __test__.presetToEditor(findPreset('openrouter')!);
    // OpenRouter preset opts into streamUsage. Newly-added models in the
    // editor must inherit it, not just the seeded ones.
    expect(editor.presetCapabilities?.streamUsage).toBe(true);
    const fresh = __test__.makeModelDraft(editor.type, {
      capabilities: editor.presetCapabilities,
    });
    expect(fresh.resolved.streamUsage).toBe(true);
  });

  it('capability edits survive an endpoint type switch', () => {
    // Simulate the editor flow: user enables `thinking` on an openai-chat
    // model, then switches the endpoint type to ollama-native. The override
    // must remain visible (resolved=true) instead of resetting to the
    // type-default (false).
    const base = __test__.presetToEditor(findPreset('blank')!);
    base.id = 'x';
    base.name = 'X';
    base.baseUrl = 'http://localhost:9999';

    // Initial model with no overrides
    const initial = __test__.makeModelDraft('openai-chat', { id: 'm1' });
    expect(initial.resolved.thinking).toBe(false);

    // User toggles `thinking` on — simulate ModelEditor.updateCap behaviour:
    // both `capabilities` and `resolved` must be patched.
    const edited = {
      ...initial,
      capabilities: { ...initial.capabilities, thinking: true as const },
      resolved: { ...initial.resolved, thinking: true },
    };

    // Parent flips endpoint type to ollama-native — recomputes resolved from
    // capabilities. The override must survive.
    const afterTypeChange = {
      ...edited,
      resolved: __test__.resolveCapabilities('ollama-native', edited.capabilities),
    };
    expect(afterTypeChange.resolved.thinking).toBe(true);

    // Verify it persists through editorToConfig as well.
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

describe('CustomEndpointsSettings — render', () => {
  beforeEach(() => {
    mockListCustomEndpoints.mockReset();
    mockAddCustomEndpoint.mockReset();
    mockUpdateCustomEndpoint.mockReset();
    mockRemoveCustomEndpoint.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
  });

  afterEach(() => cleanup());

  it('shows empty state when no endpoints exist', async () => {
    mockListCustomEndpoints.mockResolvedValue({ endpoints: [] });
    render(<CustomEndpointsSettings />);
    await waitFor(() => {
      expect(screen.getByText(/No custom endpoints configured/i)).toBeTruthy();
    });
  });

  it('renders the list with capability badges for each endpoint model', async () => {
    mockListCustomEndpoints.mockResolvedValue({
      endpoints: [
        {
          id: 'lm',
          name: 'LM Studio',
          type: 'openai-chat',
          baseUrl: 'http://localhost:1234/v1',
          models: [{ id: 'qwen', capabilities: { vision: true, thinking: false, toolUse: true } }],
        },
      ],
    });
    render(<CustomEndpointsSettings />);
    await waitFor(() => {
      expect(screen.getByText('LM Studio')).toBeTruthy();
      expect(screen.getByText('qwen')).toBeTruthy();
      // vision + tools badges should be rendered
      expect(screen.getAllByText('vision').length).toBeGreaterThan(0);
      expect(screen.getAllByText('tools').length).toBeGreaterThan(0);
    });
  });

  it('opens the preset picker when "Add provider" is clicked', async () => {
    mockListCustomEndpoints.mockResolvedValue({ endpoints: [] });
    render(<CustomEndpointsSettings />);
    await waitFor(() => screen.getByText(/Add provider/i));
    fireEvent.click(screen.getByText(/Add provider/i));
    expect(screen.getByText(/Choose a preset/i)).toBeTruthy();
    // Presets visible
    expect(screen.getByText(/Ollama \(local\)/i)).toBeTruthy();
    expect(screen.getByText(/OpenRouter/i)).toBeTruthy();
  });
});
