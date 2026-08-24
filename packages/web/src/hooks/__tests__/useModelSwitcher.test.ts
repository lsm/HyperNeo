// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/preact';
import {
  useModelSwitcher,
  MODEL_FAMILY_ICONS,
  getModelFamilyIcon,
  getProviderLabel,
  groupModelsByProvider,
  mapRawModelsToModelInfos,
  filterModelsForPicker,
  filterModelsBySearch,
  isDefinitiveAuthFailure,
  useFilteredModelsForPicker,
} from '../useModelSwitcher.ts';

const mockGetHubIfConnected = vi.fn();

vi.mock('../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => mockGetHubIfConnected(),
  },
}));

const { mockConnectionState } = vi.hoisted(() => {
  const obj = { value: 'connected' };
  return { mockConnectionState: obj };
});

vi.mock('../../lib/state', () => ({
  connectionState: mockConnectionState,
}));

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockToastInfo = vi.fn();

vi.mock('../../lib/toast', () => ({
  toast: {
    success: (msg: string) => mockToastSuccess(msg),
    error: (msg: string) => mockToastError(msg),
    info: (msg: string) => mockToastInfo(msg),
  },
}));

describe('useModelSwitcher', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockConnectionState.value = 'connected';
    mockGetHubIfConnected.mockReturnValue({
      request: vi.fn().mockResolvedValue({ acknowledged: true }),
      onEvent: vi.fn().mockReturnValue(() => {}),
      joinRoom: vi.fn(),
      leaveRoom: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      onConnection: vi.fn().mockReturnValue(() => {}),
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with empty model state', () => {
      const { result } = renderHook(() => useModelSwitcher('session-1'));

      expect(result.current.currentModel).toBe('');
      expect(result.current.currentModelInfo).toBeNull();
      expect(result.current.availableModels).toEqual([]);
      expect(result.current.switching).toBe(false);
    });

    it('should provide required functions', () => {
      const { result } = renderHook(() => useModelSwitcher('session-1'));

      expect(typeof result.current.reload).toBe('function');
      expect(typeof result.current.switchModel).toBe('function');
    });

    it('should initialize loading state', () => {
      const { result } = renderHook(() => useModelSwitcher('session-1'));

      expect(typeof result.current.loading).toBe('boolean');
    });
  });

  describe('MODEL_FAMILY_ICONS', () => {
    it('should have icons for all model families', () => {
      expect(MODEL_FAMILY_ICONS.opus).toBeDefined();
      expect(MODEL_FAMILY_ICONS.sonnet).toBeDefined();
      expect(MODEL_FAMILY_ICONS.haiku).toBeDefined();
    });

    it('should have emoji icons', () => {
      expect(typeof MODEL_FAMILY_ICONS.opus).toBe('string');
      expect(typeof MODEL_FAMILY_ICONS.sonnet).toBe('string');
      expect(typeof MODEL_FAMILY_ICONS.haiku).toBe('string');
    });

    it('should have glm icon for GLM models', () => {
      expect(MODEL_FAMILY_ICONS.glm).toBeDefined();
      expect(typeof MODEL_FAMILY_ICONS.glm).toBe('string');
    });

    it('should have default icon for unknown families', () => {
      expect(MODEL_FAMILY_ICONS.__default__).toBeDefined();
      expect(typeof MODEL_FAMILY_ICONS.__default__).toBe('string');
    });

    it('should have distinct icons for each family', () => {
      const icons = [
        MODEL_FAMILY_ICONS.opus,
        MODEL_FAMILY_ICONS.sonnet,
        MODEL_FAMILY_ICONS.haiku,
        MODEL_FAMILY_ICONS.glm,
      ];
      const uniqueIcons = new Set(icons);
      expect(uniqueIcons.size).toBe(4);
    });

    it('should have gpt icon for OpenAI models', () => {
      expect(MODEL_FAMILY_ICONS.gpt).toBeDefined();
      expect(typeof MODEL_FAMILY_ICONS.gpt).toBe('string');
    });

    it('should have openrouter icon for OpenRouter automatic routing', () => {
      expect(MODEL_FAMILY_ICONS.openrouter).toBeDefined();
      expect(typeof MODEL_FAMILY_ICONS.openrouter).toBe('string');
    });

    it('should have kimi icon for Kimi models', () => {
      expect(MODEL_FAMILY_ICONS.kimi).toBeDefined();
      expect(typeof MODEL_FAMILY_ICONS.kimi).toBe('string');
    });
  });

  describe('getModelFamilyIcon', () => {
    it('should return correct icon for known families', () => {
      expect(getModelFamilyIcon('opus')).toBe(MODEL_FAMILY_ICONS.opus);
      expect(getModelFamilyIcon('sonnet')).toBe(MODEL_FAMILY_ICONS.sonnet);
      expect(getModelFamilyIcon('haiku')).toBe(MODEL_FAMILY_ICONS.haiku);
      expect(getModelFamilyIcon('glm')).toBe(MODEL_FAMILY_ICONS.glm);
      expect(getModelFamilyIcon('kimi')).toBe(MODEL_FAMILY_ICONS.kimi);
      expect(getModelFamilyIcon('openrouter')).toBe(MODEL_FAMILY_ICONS.openrouter);
      expect(getModelFamilyIcon('gpt')).toBe(MODEL_FAMILY_ICONS.gpt);
    });

    it('should return default icon for unknown families', () => {
      expect(getModelFamilyIcon('unknown')).toBe(MODEL_FAMILY_ICONS.__default__);
      expect(getModelFamilyIcon('random-family')).toBe(MODEL_FAMILY_ICONS.__default__);
    });
  });

  describe('getProviderLabel', () => {
    it('should return correct label for known providers', () => {
      expect(getProviderLabel('anthropic')).toBe('Anthropic');
      expect(getProviderLabel('glm')).toBe('Z.ai');
      expect(getProviderLabel('kimi')).toBe('Kimi');
      expect(getProviderLabel('minimax')).toBe('MiniMax');
      expect(getProviderLabel('openrouter')).toBe('OpenRouter');
      expect(getProviderLabel('anthropic-copilot')).toBe('Copilot');
      expect(getProviderLabel('anthropic-codex')).toBe('Codex');
    });

    it('should return the provider string for unknown providers', () => {
      expect(getProviderLabel('unknown')).toBe('unknown');
      expect(getProviderLabel('some-provider')).toBe('some-provider');
    });

    it('should render custom: providers as "Custom — <slug>"', () => {
      expect(getProviderLabel('custom:ollama-local')).toBe('Custom — ollama-local');
      expect(getProviderLabel('custom:lmstudio')).toBe('Custom — lmstudio');
    });
  });

  describe('filterModelsForPicker', () => {
    const glmModels = [
      { id: 'glm-5.2', name: 'GLM-5.2', family: 'glm', provider: 'glm' },
      { id: 'glm-5', name: 'GLM-5', family: 'glm', provider: 'glm' },
    ];
    const anthropicModel = {
      id: 'sonnet',
      name: 'Sonnet',
      family: 'sonnet',
      provider: 'anthropic',
    };

    it('keeps GLM models when GLM is authenticated', () => {
      const auth = new Map([['glm', { id: 'glm', isAuthenticated: true }]]);
      const filtered = filterModelsForPicker([...glmModels, anthropicModel], auth, 'anthropic');
      expect(filtered.map((m) => m.id).sort()).toEqual(['glm-5', 'glm-5.2', 'sonnet']);
    });

    it('hides GLM models when GLM is not authenticated and is not the active provider', () => {
      const auth = new Map([['glm', { id: 'glm', isAuthenticated: false }]]);
      const filtered = filterModelsForPicker([...glmModels, anthropicModel], auth, 'anthropic');
      expect(filtered.map((m) => m.id)).toEqual(['sonnet']);
    });

    it('keeps GLM models when GLM is the active provider and not definitively failed', () => {
      const auth = new Map([
        ['glm', { id: 'glm', isAuthenticated: false, errorKind: 'transient' }],
      ]);
      const filtered = filterModelsForPicker([...glmModels, anthropicModel], auth, 'glm');
      expect(filtered.map((m) => m.id).sort()).toEqual(['glm-5', 'glm-5.2', 'sonnet']);
    });

    it('preserves only the selected model of the active provider under a definitive failure', () => {
      const auth = new Map([['glm', { id: 'glm', isAuthenticated: false }]]);
      const filtered = filterModelsForPicker([...glmModels, anthropicModel], auth, 'glm', 'glm-5');
      expect(filtered.map((m) => m.id).sort()).toEqual(['glm-5', 'sonnet']);
    });

    it('blocks every active-provider model under a credential failure when none is selected', () => {
      const auth = new Map([
        ['glm', { id: 'glm', isAuthenticated: false, errorKind: 'credential' }],
      ]);
      const filtered = filterModelsForPicker([...glmModels, anthropicModel], auth, 'glm');
      expect(filtered.map((m) => m.id)).toEqual(['sonnet']);
    });

    it('keeps models of a transiently failed provider even when unauthenticated', () => {
      const auth = new Map([
        ['glm', { id: 'glm', isAuthenticated: false, errorKind: 'transient' }],
      ]);
      const filtered = filterModelsForPicker([...glmModels, anthropicModel], auth, 'anthropic');
      expect(filtered.map((m) => m.id).sort()).toEqual(['glm-5', 'glm-5.2', 'sonnet']);
    });

    it('hides models of a provider with a definitive credential failure', () => {
      const auth = new Map([
        ['glm', { id: 'glm', isAuthenticated: false, errorKind: 'credential' }],
      ]);
      const filtered = filterModelsForPicker([...glmModels, anthropicModel], auth, 'anthropic');
      expect(filtered.map((m) => m.id)).toEqual(['sonnet']);
    });

    it('shows GLM models optimistically when GLM is absent from the auth map', () => {
      const filtered = filterModelsForPicker(
        [...glmModels, anthropicModel],
        new Map(),
        'anthropic'
      );
      expect(filtered.map((m) => m.id).sort()).toEqual(['glm-5', 'glm-5.2', 'sonnet']);
    });
  });

  describe('isDefinitiveAuthFailure', () => {
    it('treats unauthenticated without errorKind as definitive', () => {
      expect(isDefinitiveAuthFailure({ id: 'glm', isAuthenticated: false })).toBe(true);
    });

    it('treats unauthenticated with credential errorKind as definitive', () => {
      expect(
        isDefinitiveAuthFailure({ id: 'glm', isAuthenticated: false, errorKind: 'credential' })
      ).toBe(true);
    });

    it('treats unauthenticated with transient errorKind as not definitive', () => {
      expect(
        isDefinitiveAuthFailure({ id: 'glm', isAuthenticated: false, errorKind: 'transient' })
      ).toBe(false);
    });

    it('treats authenticated statuses as not definitive', () => {
      expect(isDefinitiveAuthFailure({ id: 'glm', isAuthenticated: true })).toBe(false);
      expect(
        isDefinitiveAuthFailure({
          id: 'glm',
          isAuthenticated: true,
          errorKind: 'transient',
        })
      ).toBe(false);
    });
  });

  describe('loadModelInfo with mocked hub', () => {
    it('should load current model and available models on mount', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'claude-sonnet-4-20250514',
            modelInfo: {
              id: 'claude-sonnet-4-20250514',
              name: 'Claude Sonnet 4',
              family: 'sonnet',
            },
          })
          .mockResolvedValueOnce({
            models: [
              {
                id: 'claude-sonnet-4-20250514',
                display_name: 'Claude Sonnet 4',
                description: 'Fast model',
              },
              {
                id: 'claude-opus-4-5-20251101',
                display_name: 'Claude Opus 4.5',
                description: 'Best model',
              },
              {
                id: 'claude-3-5-haiku-20241022',
                display_name: 'Claude Haiku',
                description: 'Quick model',
              },
            ],
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.currentModel).toBe('claude-sonnet-4-20250514');
      expect(result.current.currentModelInfo).toEqual({
        id: 'claude-sonnet-4-20250514',
        name: 'Claude Sonnet 4',
        family: 'sonnet',
      });
      expect(result.current.availableModels.length).toBe(3);
    });

    it('backfills current model info by provider and id', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'gpt-5.4',
            currentProvider: 'custom:local',
            modelInfo: null,
          })
          .mockResolvedValueOnce({
            models: [
              {
                id: 'gpt-5.4',
                display_name: 'Built-in Codex',
                description: '',
                provider: 'anthropic-codex',
              },
              {
                id: 'gpt-5.4',
                display_name: 'Custom Model',
                description: '',
                provider: 'custom:local',
              },
            ],
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.currentModelInfo?.id).toBe('gpt-5.4');
      expect(result.current.currentModelInfo?.provider).toBe('custom:local');
      expect(result.current.currentModelInfo?.name).toBe('Custom Model');
    });

    it('backfills current model info by provider and alias', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'copilot-anthropic-opus',
            currentProvider: 'anthropic-copilot',
            modelInfo: null,
          })
          .mockResolvedValueOnce({
            models: [
              {
                id: 'claude-opus-4.6',
                alias: 'copilot-anthropic-opus',
                display_name: 'Claude Opus 4.6',
                description: '',
                provider: 'anthropic-copilot',
              },
            ],
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.currentModelInfo?.id).toBe('claude-opus-4.6');
      expect(result.current.currentModelInfo?.alias).toBe('copilot-anthropic-opus');
      expect(result.current.currentModelInfo?.provider).toBe('anthropic-copilot');
    });

    it('should classify models by family correctly', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'claude-sonnet-4-20250514',
            modelInfo: null,
          })
          .mockResolvedValueOnce({
            models: [
              { id: 'claude-opus-4-5-20251101', display_name: 'Opus', description: '' },
              { id: 'claude-sonnet-4-20250514', display_name: 'Sonnet', description: '' },
              { id: 'claude-3-5-haiku-20241022', display_name: 'Haiku', description: '' },
              { id: 'glm-4-plus', display_name: 'GLM 4', description: '' },
            ],
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const families = result.current.availableModels.map((m) => m.family);
      expect(families).toContain('opus');
      expect(families).toContain('sonnet');
      expect(families).toContain('haiku');
      expect(families).toContain('glm');
    });

    it('should set glm provider for glm models', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'glm-4-plus',
            modelInfo: null,
          })
          .mockResolvedValueOnce({
            models: [
              { id: 'glm-4-plus', display_name: 'GLM 4 Plus', description: '', provider: 'glm' },
            ],
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const glmModel = result.current.availableModels.find((m) => m.id === 'glm-4-plus');
      expect(glmModel?.provider).toBe('glm');
      expect(glmModel?.family).toBe('glm');
    });

    it('should detect kimi family and provider for Kimi models', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'kimi-for-coding',
            modelInfo: null,
          })
          .mockResolvedValueOnce({
            models: [
              {
                id: 'kimi-for-coding',
                display_name: 'Kimi For Coding',
                description: '',
                provider: 'kimi',
              },
            ],
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const kimiModel = result.current.availableModels.find((m) => m.id === 'kimi-for-coding');
      expect(kimiModel?.provider).toBe('kimi');
      expect(kimiModel?.family).toBe('kimi');
    });

    it('should detect kimi family and provider for new Kimi K3 and high-speed models', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'kimi-k3',
            modelInfo: null,
          })
          .mockResolvedValueOnce({
            models: [
              {
                id: 'kimi-k3',
                display_name: 'Kimi K3',
                description: '',
                provider: 'kimi',
              },
              {
                id: 'kimi-k2.7-code-highspeed',
                display_name: 'Kimi K2.7 Code Highspeed',
                description: '',
                provider: 'kimi',
              },
            ],
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const k3 = result.current.availableModels.find((m) => m.id === 'kimi-k3');
      const highspeed = result.current.availableModels.find(
        (m) => m.id === 'kimi-k2.7-code-highspeed'
      );
      expect(k3?.provider).toBe('kimi');
      expect(k3?.family).toBe('kimi');
      expect(highspeed?.provider).toBe('kimi');
      expect(highspeed?.family).toBe('kimi');
    });

    it('should detect gpt family and anthropic-copilot provider for Copilot GPT models', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'gpt-5.3-codex',
            modelInfo: null,
          })
          .mockResolvedValueOnce({
            models: [
              {
                id: 'gpt-5.3-codex',
                display_name: 'GPT-5.3 Codex (Copilot)',
                description: '',
                provider: 'anthropic-copilot',
              },
            ],
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const gptModel = result.current.availableModels.find((m) => m.id === 'gpt-5.3-codex');
      expect(gptModel?.provider).toBe('anthropic-copilot');
      expect(gptModel?.family).toBe('gpt');
    });

    it('should detect claude family via copilot provider', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'claude-opus-4.6',
            modelInfo: null,
          })
          .mockResolvedValueOnce({
            models: [
              {
                id: 'claude-opus-4.6',
                display_name: 'Claude Opus 4.6 (Copilot)',
                description: '',
                provider: 'anthropic-copilot',
                alias: 'copilot-anthropic-opus',
              },
            ],
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const claudeModel = result.current.availableModels.find((m) => m.id === 'claude-opus-4.6');
      expect(claudeModel?.provider).toBe('anthropic-copilot');
      expect(claudeModel?.family).toBe('opus');
    });

    it('should map OpenRouter models to OpenRouter provider and slash-based families', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'openrouter/auto',
            modelInfo: null,
          })
          .mockResolvedValueOnce({
            models: [
              {
                id: 'openrouter/auto',
                display_name: 'OpenRouter Auto',
                description: '',
                provider: 'openrouter',
              },
              {
                id: 'openai/gpt-5.4',
                display_name: 'GPT-5.4',
                description: '',
                provider: 'openrouter',
              },
              {
                id: 'google/gemini-3-pro-preview',
                display_name: 'Gemini 3 Pro',
                description: '',
                provider: 'openrouter',
              },
              {
                id: 'deepseek/deepseek-r1',
                display_name: 'DeepSeek R1',
                description: '',
                provider: 'openrouter',
              },
            ],
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const auto = result.current.availableModels.find((m) => m.id === 'openrouter/auto');
      const gpt = result.current.availableModels.find((m) => m.id === 'openai/gpt-5.4');
      const gemini = result.current.availableModels.find(
        (m) => m.id === 'google/gemini-3-pro-preview'
      );
      const deepseek = result.current.availableModels.find((m) => m.id === 'deepseek/deepseek-r1');
      expect(auto?.provider).toBe('openrouter');
      expect(auto?.family).toBe('openrouter');
      expect(gpt?.family).toBe('gpt');
      expect(gemini?.family).toBe('openrouter');
      expect(deepseek?.family).toBe('openrouter');
    });

    it('should sort models by family order', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'claude-sonnet-4-20250514',
            modelInfo: null,
          })
          .mockResolvedValueOnce({
            models: [
              { id: 'claude-3-5-haiku-20241022', display_name: 'Haiku', description: '' },
              { id: 'glm-4-plus', display_name: 'GLM', description: '' },
              { id: 'claude-opus-4-5-20251101', display_name: 'Opus', description: '' },
              { id: 'claude-sonnet-4-20250514', display_name: 'Sonnet', description: '' },
            ],
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const families = result.current.availableModels.map((m) => m.family);
      expect(families).toEqual(['opus', 'sonnet', 'haiku', 'glm']);
    });

    it('should handle error during load gracefully', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValue({ acknowledged: true })
          .mockRejectedValue(new Error('Network error')),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });

    it('should handle no hub connection', async () => {
      mockGetHubIfConnected.mockReturnValue(null);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.currentModel).toBe('');
    });
  });

  describe('switchModel', () => {
    it('should show info toast when switching to same model', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'claude-sonnet-4-20250514',
            modelInfo: { id: 'claude-sonnet-4-20250514', name: 'Sonnet', provider: 'anthropic' },
          })
          .mockResolvedValueOnce({ models: [] }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.switchModel({ id: 'claude-sonnet-4-20250514', provider: 'anthropic' });
      });

      expect(mockToastInfo).toHaveBeenCalledWith(expect.stringContaining('Already using'));
    });

    it('should switch model successfully', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'claude-sonnet-4-20250514',
            modelInfo: null,
          })
          .mockResolvedValueOnce({
            models: [
              { id: 'claude-sonnet-4-20250514', display_name: 'Sonnet', description: '' },
              { id: 'claude-opus-4-5-20251101', display_name: 'Opus', description: '' },
            ],
          })
          .mockResolvedValueOnce({
            success: true,
            model: 'claude-opus-4-5-20251101',
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.switchModel({ id: 'claude-opus-4-5-20251101', provider: 'anthropic' });
      });

      expect(result.current.currentModel).toBe('claude-opus-4-5-20251101');
      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining('Switched to'));
    });

    it('should handle switch failure from server', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'claude-sonnet-4-20250514',
            modelInfo: null,
          })
          .mockResolvedValueOnce({ models: [] })
          .mockResolvedValueOnce({
            success: false,
            error: 'Model not available',
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.switchModel({ id: 'claude-opus-4-5-20251101', provider: 'anthropic' });
      });

      expect(mockToastError).toHaveBeenCalledWith('Model not available');
    });

    it('should handle switch failure with default error', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'claude-sonnet-4-20250514',
            modelInfo: null,
          })
          .mockResolvedValueOnce({ models: [] })
          .mockResolvedValueOnce({
            success: false,
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.switchModel({ id: 'claude-opus-4-5-20251101', provider: 'anthropic' });
      });

      expect(mockToastError).toHaveBeenCalledWith('Failed to switch model');
    });

    it('should handle switch error with no connection', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'claude-sonnet-4-20250514',
            modelInfo: null,
          })
          .mockResolvedValueOnce({ models: [] }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      mockGetHubIfConnected.mockReturnValue(null);

      await act(async () => {
        await result.current.switchModel({ id: 'claude-opus-4-5-20251101', provider: 'anthropic' });
      });

      expect(mockToastError).toHaveBeenCalledWith('Not connected to server');
    });

    it('should handle switch exception', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValue({ acknowledged: true })
          .mockImplementation((method: string) => {
            if (method === 'session.model.get') {
              return Promise.resolve({
                currentModel: 'claude-sonnet-4-20250514',
                modelInfo: null,
              });
            }
            if (method === 'models.list') {
              return Promise.resolve({ models: [] });
            }
            if (method === 'session.model.switch') {
              return Promise.reject(new Error('Connection lost'));
            }
            return Promise.resolve({});
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.switchModel({ id: 'claude-opus-4-5-20251101', provider: 'anthropic' });
      });

      expect(mockToastError).toHaveBeenCalledWith('Connection lost');
    });

    it('should set switching state during switch', async () => {
      const switchingStates: boolean[] = [];

      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'claude-sonnet-4-20250514',
            modelInfo: null,
          })
          .mockResolvedValueOnce({ models: [] })
          .mockResolvedValueOnce({
            success: true,
            model: 'claude-opus-4-5-20251101',
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.switching).toBe(false);
      switchingStates.push(result.current.switching);

      await act(async () => {
        await result.current.switchModel({ id: 'claude-opus-4-5-20251101', provider: 'anthropic' });
      });

      expect(result.current.switching).toBe(false);
      switchingStates.push(result.current.switching);

      expect(mockHub.request).toHaveBeenCalledWith('session.model.switch', {
        sessionId: 'session-1',
        model: 'claude-opus-4-5-20251101',
        provider: 'anthropic',
      });
    });

    it('should update currentModelInfo after successful switch', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'claude-sonnet-4-20250514',
            modelInfo: null,
          })
          .mockResolvedValueOnce({
            models: [
              { id: 'claude-sonnet-4-20250514', display_name: 'Sonnet', description: 'Fast' },
              { id: 'claude-opus-4-5-20251101', display_name: 'Opus', description: 'Best' },
            ],
          })
          .mockResolvedValueOnce({
            success: true,
            model: 'claude-opus-4-5-20251101',
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.switchModel({ id: 'claude-opus-4-5-20251101', provider: 'anthropic' });
      });

      expect(result.current.currentModelInfo?.id).toBe('claude-opus-4-5-20251101');
    });
  });

  describe('switchModel - cross-provider', () => {
    it('should match currentModelInfo by provider after cross-provider switch', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'claude-sonnet-4-20250514',
            modelInfo: null,
          })
          .mockResolvedValueOnce({
            models: [
              {
                id: 'claude-sonnet-4-20250514',
                display_name: 'Sonnet (Anthropic)',
                description: '',
                provider: 'anthropic',
              },
              {
                id: 'claude-sonnet-4-20250514',
                display_name: 'Sonnet (Copilot)',
                description: '',
                provider: 'anthropic-copilot',
              },
            ],
          })
          .mockResolvedValueOnce({
            success: true,
            model: 'claude-sonnet-4-20250514',
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.switchModel({
          id: 'claude-sonnet-4-20250514',
          provider: 'anthropic-copilot',
        });
      });

      expect(result.current.currentModelInfo?.provider).toBe('anthropic-copilot');
      expect(result.current.currentModelInfo?.name).toBe('Sonnet (Copilot)');
    });
  });

  describe('switchModel - provider validation', () => {
    it('should show error when provider is missing from model', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'claude-sonnet-4-20250514',
            modelInfo: null,
          })
          .mockResolvedValueOnce({ models: [] }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.switchModel({ id: 'claude-opus-4-5-20251101' });
      });

      expect(mockToastError).toHaveBeenCalledWith('Model provider information is missing');
      expect(mockHub.request).not.toHaveBeenCalledWith('session.model.switch', expect.anything());
    });
  });

  describe('reload', () => {
    it('should reload model info', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'claude-sonnet-4-20250514',
            modelInfo: null,
          })
          .mockResolvedValueOnce({ models: [] })
          .mockResolvedValueOnce({
            currentModel: 'claude-opus-4-5-20251101',
            modelInfo: { id: 'claude-opus-4-5-20251101', name: 'Opus' },
          })
          .mockResolvedValueOnce({ models: [] }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.currentModel).toBe('claude-sonnet-4-20250514');

      await act(async () => {
        await result.current.reload();
      });

      expect(result.current.currentModel).toBe('claude-opus-4-5-20251101');
    });
  });

  describe('sessionId changes', () => {
    it('discards a delayed model backfill from the previous session', async () => {
      let resolveFirstModels!: (value: unknown) => void;
      const firstModels = new Promise((resolve) => {
        resolveFirstModels = resolve;
      });
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi.fn((method, params) => {
          if (method === 'session.model.get') {
            if (params.sessionId === 'session-1') {
              return Promise.resolve({
                currentModel: 'old-alias',
                currentProvider: 'custom:old',
                modelInfo: null,
              });
            }
            return Promise.resolve({
              currentModel: 'new-model',
              currentProvider: 'custom:new',
              modelInfo: null,
            });
          }
          if (mockHub.request.mock.calls.filter((call) => call[0] === 'models.list').length === 1) {
            return firstModels;
          }
          return Promise.resolve({
            models: [
              {
                id: 'new-model',
                display_name: 'New Model',
                description: '',
                provider: 'custom:new',
              },
            ],
          });
        }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result, rerender } = renderHook(({ sessionId }) => useModelSwitcher(sessionId), {
        initialProps: { sessionId: 'session-1' },
      });

      await waitFor(() => {
        expect(mockHub.request).toHaveBeenCalledWith('models.list', { useCache: true });
      });
      rerender({ sessionId: 'session-2' });

      await waitFor(() => {
        expect(result.current.currentModelInfo?.provider).toBe('custom:new');
      });

      await act(async () => {
        resolveFirstModels({
          models: [
            {
              id: 'old-model',
              alias: 'old-alias',
              display_name: 'Old Model',
              description: '',
              provider: 'custom:old',
            },
          ],
        });
        await firstModels;
      });

      expect(result.current.currentModel).toBe('new-model');
      expect(result.current.currentModelInfo?.provider).toBe('custom:new');
      expect(result.current.availableModels[0]?.provider).toBe('custom:new');
    });

    it('should reload when sessionId changes', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'model-1',
            modelInfo: null,
          })
          .mockResolvedValueOnce({ models: [] })
          .mockResolvedValueOnce({
            currentModel: 'model-2',
            modelInfo: null,
          })
          .mockResolvedValueOnce({ models: [] }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result, rerender } = renderHook(({ sessionId }) => useModelSwitcher(sessionId), {
        initialProps: { sessionId: 'session-1' },
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.currentModel).toBe('model-1');

      rerender({ sessionId: 'session-2' });

      await waitFor(() => {
        expect(result.current.currentModel).toBe('model-2');
      });
    });
  });

  describe('providers.changed event', () => {
    it('should reload model info when providers.changed event fires', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'model-1',
            modelInfo: null,
          })
          .mockResolvedValueOnce({
            models: [{ id: 'model-1', display_name: 'Model 1', description: '' }],
          })
          .mockResolvedValueOnce({
            currentModel: 'model-1',
            modelInfo: null,
          })
          .mockResolvedValueOnce({
            models: [
              { id: 'model-1', display_name: 'Model 1', description: '' },
              { id: 'model-2', display_name: 'Model 2', description: '' },
            ],
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.availableModels.length).toBe(1);

      const eventHandler = mockHub.onEvent.mock.results[0]?.value;
      const registeredHandler = mockHub.onEvent.mock.calls.find(
        (call) => call[0] === 'providers.changed'
      )?.[1];
      expect(registeredHandler).toBeDefined();
      await act(async () => {
        registeredHandler();
      });

      await waitFor(() => {
        expect(result.current.availableModels.length).toBe(2);
      });
    });
  });

  describe('function stability', () => {
    it('should return stable reload function on same sessionId', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'claude-sonnet-4-20250514',
            modelInfo: null,
          })
          .mockResolvedValueOnce({ models: [] }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result, rerender } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const firstReload = result.current.reload;

      rerender();

      expect(result.current.reload).toBe(firstReload);
    });
  });

  describe('groupModelsByProvider', () => {
    it('should return an empty map for empty input', () => {
      const result = groupModelsByProvider([]);
      expect(result.size).toBe(0);
    });

    it('should group models by provider', () => {
      const models = [
        { id: 'claude-sonnet-4', provider: 'anthropic', family: 'sonnet', name: 'Sonnet' },
        { id: 'claude-opus-4', provider: 'anthropic', family: 'opus', name: 'Opus' },
        {
          id: 'claude-sonnet-4',
          provider: 'anthropic-copilot',
          family: 'sonnet',
          name: 'Sonnet (Copilot)',
        },
      ];
      const result = groupModelsByProvider(models as any);
      expect(result.size).toBe(2);
      expect(result.get('anthropic')).toHaveLength(2);
      expect(result.get('anthropic-copilot')).toHaveLength(1);
    });

    it('should default to anthropic provider when model has no provider', () => {
      const models = [{ id: 'claude-sonnet-4', family: 'sonnet', name: 'Sonnet' }];
      const result = groupModelsByProvider(models as any);
      expect(result.has('anthropic')).toBe(true);
      expect(result.get('anthropic')).toHaveLength(1);
    });

    it('should preserve all models within each group', () => {
      const models = [
        { id: 'glm-4-plus', provider: 'glm', family: 'glm', name: 'GLM 4 Plus' },
        { id: 'glm-4-flash', provider: 'glm', family: 'glm', name: 'GLM 4 Flash' },
        { id: 'claude-sonnet-4', provider: 'anthropic', family: 'sonnet', name: 'Sonnet' },
      ];
      const result = groupModelsByProvider(models as any);
      expect(result.get('glm')).toHaveLength(2);
      expect(result.get('anthropic')).toHaveLength(1);
    });

    it('should maintain insertion order of models within each group', () => {
      const models = [
        { id: 'claude-opus-4', provider: 'anthropic', family: 'opus', name: 'Opus' },
        { id: 'claude-sonnet-4', provider: 'anthropic', family: 'sonnet', name: 'Sonnet' },
        { id: 'claude-haiku-4', provider: 'anthropic', family: 'haiku', name: 'Haiku' },
      ];
      const result = groupModelsByProvider(models as any);
      const anthropicModels = result.get('anthropic')!;
      expect(anthropicModels[0].id).toBe('claude-opus-4');
      expect(anthropicModels[1].id).toBe('claude-sonnet-4');
      expect(anthropicModels[2].id).toBe('claude-haiku-4');
    });

    it('should handle all supported providers', () => {
      const models = [
        { id: 'm1', provider: 'anthropic', family: 'sonnet', name: 'M1' },
        { id: 'm2', provider: 'anthropic-copilot', family: 'sonnet', name: 'M2' },
        { id: 'm3', provider: 'anthropic-codex', family: 'sonnet', name: 'M3' },
        { id: 'm4', provider: 'glm', family: 'glm', name: 'M4' },
        { id: 'm5', provider: 'minimax', family: 'minimax', name: 'M5' },
      ];
      const result = groupModelsByProvider(models as any);
      expect(result.size).toBe(5);
      expect(result.has('anthropic')).toBe(true);
      expect(result.has('anthropic-copilot')).toBe(true);
      expect(result.has('anthropic-codex')).toBe(true);
      expect(result.has('glm')).toBe(true);
      expect(result.has('minimax')).toBe(true);
    });
  });

  describe('model alias extraction', () => {
    it('should extract alias from model ID', async () => {
      const mockHub = {
        onEvent: vi.fn(() => () => {}),
        request: vi
          .fn()
          .mockResolvedValueOnce({
            currentModel: 'claude-opus-4-5-20251101',
            modelInfo: null,
          })
          .mockResolvedValueOnce({
            models: [
              {
                id: 'claude-opus-4-5-20251101',
                display_name: 'Opus',
                description: '',
                alias: 'copilot-anthropic-opus',
                provider: 'anthropic-copilot',
              },
            ],
          }),
      };
      mockGetHubIfConnected.mockReturnValue(mockHub);

      const { result } = renderHook(() => useModelSwitcher('session-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.availableModels[0].alias).toBe('copilot-anthropic-opus');
    });
  });
});

describe('mapRawModelsToModelInfos', () => {
  it('maps display_name to name and falls back alias to id', () => {
    const result = mapRawModelsToModelInfos([
      { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet', description: '' },
    ]);
    expect(result[0].name).toBe('Claude Sonnet');
    expect(result[0].alias).toBe('claude-sonnet-4-6');
  });

  it('detects opus family', () => {
    const result = mapRawModelsToModelInfos([
      { id: 'claude-opus-4-6', display_name: 'Opus', description: '' },
    ]);
    expect(result[0].family).toBe('opus');
  });

  it('detects gpt family', () => {
    const result = mapRawModelsToModelInfos([
      { id: 'gpt-4o', display_name: 'GPT-4o', description: '' },
    ]);
    expect(result[0].family).toBe('gpt');
  });

  it('defaults provider to anthropic when not provided', () => {
    const result = mapRawModelsToModelInfos([
      { id: 'claude-sonnet-4-6', display_name: 'Sonnet', description: '' },
    ]);
    expect(result[0].provider).toBe('anthropic');
  });

  it('infers glm provider when backend omits the provider field for glm-* ids', () => {
    const result = mapRawModelsToModelInfos([
      { id: 'glm-5', display_name: 'GLM-5', description: '' },
      { id: 'glm-5-turbo', display_name: 'GLM-5-Turbo', description: '' },
    ]);
    expect(result[0].provider).toBe('glm');
    expect(result[1].provider).toBe('glm');
  });

  it('infers kimi/minimax providers when backend omits the provider field', () => {
    const result = mapRawModelsToModelInfos([
      { id: 'kimi-k2', display_name: 'Kimi', description: '' },
      { id: 'MiniMax-M2.5', display_name: 'MiniMax', description: '' },
    ]);
    const byId = Object.fromEntries(result.map((m) => [m.id, m.provider]));
    expect(byId['kimi-k2']).toBe('kimi');
    expect(byId['MiniMax-M2.5']).toBe('minimax');
  });

  it('routes bare k3-256k to kimi and preserves per-model thinkingModes', () => {
    const result = mapRawModelsToModelInfos([
      {
        id: 'k3-256k',
        display_name: 'Kimi K3 (256K)',
        description: '',
        provider: 'kimi',
        thinkingModes: 'granular',
      },
    ]);
    expect(result[0].provider).toBe('kimi');
    expect(result[0].thinkingModes).toBe('granular');
  });

  it('routes openai/gpt-* refs to openrouter, not anthropic-codex', () => {
    const result = mapRawModelsToModelInfos([
      { id: 'openai/gpt-5.4', display_name: 'GPT-5.4 (OR)', description: '' },
    ]);
    expect(result[0].provider).toBe('openrouter');
  });

  it('routes gpt-oss:* (Ollama) to ollama, not anthropic-codex', () => {
    const result = mapRawModelsToModelInfos([
      { id: 'gpt-oss:20b', display_name: 'gpt-oss 20B', description: '' },
      { id: 'gpt-oss:120b-cloud', display_name: 'gpt-oss 120B cloud', description: '' },
    ]);
    const byId = Object.fromEntries(result.map((m) => [m.id, m.provider]));
    expect(byId['gpt-oss:20b']).toBe('ollama');
    expect(byId['gpt-oss:120b-cloud']).toBe('ollama-cloud');
  });

  it('routes colon-tagged kimi/moonshot IDs to ollama, not kimi', () => {
    const result = mapRawModelsToModelInfos([
      { id: 'kimi-k2:latest', display_name: 'Kimi K2 local', description: '' },
    ]);
    expect(result[0].provider).toBe('ollama');
  });

  it('keeps slash-suffixed claude IDs under anthropic', () => {
    const result = mapRawModelsToModelInfos([
      { id: 'claude-sonnet-4.6/preview', display_name: 'Sonnet preview', description: '' },
    ]);
    expect(result[0].provider).toBe('anthropic');
  });

  it('routes slash refs with colon tier suffix to openrouter, not ollama', () => {
    const result = mapRawModelsToModelInfos([
      { id: 'google/gemma-4-31b:free', display_name: 'Gemma 4 31B', description: '' },
      { id: 'meta-llama/llama-3.1-70b:free', display_name: 'Llama 3.1 70B', description: '' },
    ]);
    const byId = Object.fromEntries(result.map((m) => [m.id, m.provider]));
    expect(byId['google/gemma-4-31b:free']).toBe('openrouter');
    expect(byId['meta-llama/llama-3.1-70b:free']).toBe('openrouter');
  });

  it('preserves GPT-5.5 context window metadata from models.list', () => {
    const result = mapRawModelsToModelInfos([
      {
        id: 'gpt-5.5',
        display_name: 'GPT-5.5',
        description: 'Latest Codex model',
        provider: 'anthropic-codex',
        contextWindow: 272000,
      },
    ]);

    expect(result[0].contextWindow).toBe(272000);
  });

  it('does not invent a 200k context window when models.list omits metadata', () => {
    const result = mapRawModelsToModelInfos([
      { id: 'gpt-5.5', display_name: 'GPT-5.5', description: '', provider: 'anthropic-codex' },
    ]);

    expect(result[0].contextWindow).toBe(0);
  });

  it('sorts by PROVIDER_ORDER: anthropic before copilot before codex', () => {
    const result = mapRawModelsToModelInfos([
      { id: 'codex-sonnet', display_name: 'Codex', description: '', provider: 'anthropic-codex' },
      { id: 'claude-sonnet', display_name: 'Sonnet', description: '', provider: 'anthropic' },
      {
        id: 'copilot-sonnet',
        display_name: 'Copilot',
        description: '',
        provider: 'anthropic-copilot',
      },
    ]);
    expect(result[0].provider).toBe('anthropic');
    expect(result[1].provider).toBe('anthropic-copilot');
    expect(result[2].provider).toBe('anthropic-codex');
  });

  it('sorts within provider by family: opus before sonnet before haiku', () => {
    const result = mapRawModelsToModelInfos([
      { id: 'claude-haiku-3', display_name: 'Haiku', description: '', provider: 'anthropic' },
      { id: 'claude-opus-4', display_name: 'Opus', description: '', provider: 'anthropic' },
      { id: 'claude-sonnet-4', display_name: 'Sonnet', description: '', provider: 'anthropic' },
    ]);
    expect(result[0].family).toBe('opus');
    expect(result[1].family).toBe('sonnet');
    expect(result[2].family).toBe('haiku');
  });
});

function makeModel(id: string, provider: string) {
  return {
    id,
    name: id,
    alias: id,
    family: 'sonnet',
    provider,
    contextWindow: 200000,
    description: '',
    releaseDate: '',
    available: true,
  };
}

function makeAuth(id: string, isAuthenticated: boolean, needsRefresh = false) {
  return { id, displayName: id, isAuthenticated, needsRefresh };
}

describe('filterModelsForPicker', () => {
  const anthropicModel = makeModel('claude-sonnet', 'anthropic');
  const copilotModel = makeModel('copilot-sonnet', 'anthropic-copilot');
  const codexModel = makeModel('codex-sonnet', 'anthropic-codex');

  it('shows all models when auth map is empty (optimistic)', () => {
    const result = filterModelsForPicker([anthropicModel, copilotModel, codexModel], new Map());
    expect(result).toHaveLength(3);
  });

  it('hides models from unauthenticated providers', () => {
    const authMap = new Map([
      ['anthropic', makeAuth('anthropic', true)],
      ['anthropic-copilot', makeAuth('anthropic-copilot', false)],
    ]);
    const result = filterModelsForPicker([anthropicModel, copilotModel], authMap);
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe('anthropic');
  });

  it('keeps the current provider when its failure is transient', () => {
    const authMap = new Map([
      ['anthropic-copilot', { ...makeAuth('anthropic-copilot', false), errorKind: 'transient' }],
    ]);
    const result = filterModelsForPicker(
      [anthropicModel, copilotModel],
      authMap,
      'anthropic-copilot'
    );
    expect(result).toHaveLength(2);
  });

  it('shows needsRefresh providers (token expiring but still authenticated)', () => {
    const authMap = new Map([['anthropic-copilot', makeAuth('anthropic-copilot', true, true)]]);
    const result = filterModelsForPicker([copilotModel], authMap);
    expect(result).toHaveLength(1);
  });

  it('hides non-current unauthenticated and keeps only the selected model of the current unauthenticated provider', () => {
    const authMap = new Map([
      ['anthropic', makeAuth('anthropic', false)],
      ['anthropic-copilot', makeAuth('anthropic-copilot', false)],
      ['anthropic-codex', makeAuth('anthropic-codex', true)],
    ]);
    const result = filterModelsForPicker(
      [anthropicModel, copilotModel, codexModel],
      authMap,
      'anthropic',
      'claude-sonnet'
    );
    expect(result.map((m) => m.provider)).toEqual(['anthropic', 'anthropic-codex']);
  });

  it('shows provider absent from auth map optimistically', () => {
    const authMap = new Map([['anthropic', makeAuth('anthropic', true)]]);
    const result = filterModelsForPicker([anthropicModel, copilotModel], authMap);
    expect(result).toHaveLength(2);
  });
});

describe('filterModelsBySearch', () => {
  const anthropicModel = {
    ...makeModel('claude-sonnet-4.6', 'anthropic'),
    name: 'Claude Sonnet 4.6',
    alias: 'sonnet-latest',
  };
  const openRouterModel = {
    ...makeModel('openai/gpt-5.4', 'openrouter'),
    name: 'GPT-5.4',
  };
  const glmModel = {
    ...makeModel('glm-4-plus', 'glm'),
    name: 'GLM 4 Plus',
  };

  it('returns all models for an empty search query', () => {
    const models = [anthropicModel, openRouterModel, glmModel];
    expect(filterModelsBySearch(models, '   ')).toBe(models);
  });

  it('filters by model name, id, alias, and provider label', () => {
    const models = [anthropicModel, openRouterModel, glmModel];

    expect(filterModelsBySearch(models, 'sonnet').map((m) => m.id)).toEqual(['claude-sonnet-4.6']);
    expect(filterModelsBySearch(models, 'openai').map((m) => m.id)).toEqual(['openai/gpt-5.4']);
    expect(filterModelsBySearch(models, 'latest').map((m) => m.id)).toEqual(['claude-sonnet-4.6']);
    expect(filterModelsBySearch(models, 'OpenRouter').map((m) => m.id)).toEqual(['openai/gpt-5.4']);
  });

  it('matches all search terms across searchable fields', () => {
    const models = [anthropicModel, openRouterModel, glmModel];

    expect(filterModelsBySearch(models, 'openrouter gpt').map((m) => m.id)).toEqual([
      'openai/gpt-5.4',
    ]);
    expect(filterModelsBySearch(models, 'openrouter sonnet')).toEqual([]);
  });
});

describe('useFilteredModelsForPicker', () => {
  it('applies auth filtering before search filtering', () => {
    const anthropicModel = {
      ...makeModel('claude-sonnet', 'anthropic'),
      name: 'Claude Sonnet',
    };
    const copilotModel = {
      ...makeModel('copilot-sonnet', 'anthropic-copilot'),
      name: 'Copilot Sonnet',
    };
    const codexModel = {
      ...makeModel('gpt-codex', 'anthropic-codex'),
      name: 'Codex GPT',
    };
    const authMap = new Map([
      ['anthropic', makeAuth('anthropic', true)],
      ['anthropic-copilot', makeAuth('anthropic-copilot', false)],
      ['anthropic-codex', makeAuth('anthropic-codex', true)],
    ]);

    const { result } = renderHook(() =>
      useFilteredModelsForPicker(
        [anthropicModel, copilotModel, codexModel],
        authMap,
        undefined,
        undefined,
        'sonnet'
      )
    );

    expect(result.current.map((model) => model.id)).toEqual(['claude-sonnet']);
  });
});
