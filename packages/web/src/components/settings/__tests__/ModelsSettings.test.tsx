import { MODEL_LIST_REQUEST_TIMEOUT_MS } from '@hyperneo/shared/provider';
import { MessageHub } from '@hyperneo/shared/message-hub/message-hub';
import { createResponseMessage, MessageType } from '@hyperneo/shared/message-hub/protocol';
import type { HubMessage, IMessageTransport } from '@hyperneo/shared/message-hub/types';
import { signal } from '@preact/signals';
import { render, cleanup, screen, waitFor, fireEvent, act } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConnectionState = signal<'connected' | 'disconnected'>('connected');

const { mockGetHubIfConnected, mockRequest, mockListProviderAuthStatus } = vi.hoisted(() => ({
  mockGetHubIfConnected: vi.fn(),
  mockRequest: vi.fn(),
  mockListProviderAuthStatus: vi.fn(),
}));

vi.mock('../../../lib/state.ts', () => ({
  globalSettings: { value: null },
  get connectionState() {
    return mockConnectionState;
  },
}));

vi.mock('../../../lib/api-helpers.ts', () => ({
  updateGlobalSettings: vi.fn(async () => {}),
  listProviderAuthStatus: () => mockListProviderAuthStatus(),
}));

vi.mock('../../../lib/toast.ts', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => mockGetHubIfConnected(),
  },
}));

import { ModelsSettings } from '../ModelsSettings.tsx';
import { globalSettings } from '../../../lib/state.ts';
import { updateGlobalSettings } from '../../../lib/api-helpers.ts';

describe('ModelsSettings — load failure surfacing', () => {
  beforeEach(() => {
    cleanup();
    mockConnectionState.value = 'connected';
    mockGetHubIfConnected.mockReset().mockReturnValue(null);
    mockRequest.mockReset();
    mockListProviderAuthStatus.mockReset().mockResolvedValue({ providers: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps fallback controls in a closed Advanced section until opened without saving', async () => {
    vi.mocked(updateGlobalSettings).mockClear();
    render(<ModelsSettings />);
    await screen.findByRole('alert');

    const advanced = screen.getByText('Advanced').closest('details');
    expect(advanced).toBeTruthy();
    expect(advanced?.open).toBe(false);
    expect(advanced?.textContent).toContain('Default Fallback Chain');
    expect(advanced?.textContent).toContain('Model-Specific Overrides');
    fireEvent.click(screen.getByText('Advanced'));
    expect(advanced?.open).toBe(true);
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'waits for delayed discovery through the real hub, forced=%s',
    async (forced) => {
      vi.useFakeTimers();
      const hub = new MessageHub();
      let receive: (message: HubMessage) => void = () => {};
      const transport = {
        name: 'delayed-models',
        isReady: () => true,
        getState: () => 'connected',
        initialize: async () => {},
        close: async () => {},
        onMessage: (handler: (message: HubMessage) => void) => {
          receive = handler;
          return () => {};
        },
        onConnectionChange: () => () => {},
        send: async (message: HubMessage) => {
          if (message.type !== MessageType.REQUEST) return;
          const refresh = (message.data as { forceRefresh?: boolean }).forceRefresh;
          const delay = forced ? (refresh ? 60000 : 0) : 15000;
          const models =
            forced && !refresh
              ? []
              : [{ id: 'cold-sdk', display_name: 'Cold SDK model', provider: 'anthropic' }];
          setTimeout(
            () =>
              receive(
                createResponseMessage({
                  method: message.method,
                  sessionId: message.sessionId,
                  requestId: message.id,
                  data: { models },
                })
              ),
            delay
          );
        },
      } as IMessageTransport;
      hub.registerTransport(transport);
      mockGetHubIfConnected.mockReturnValue(hub);
      try {
        render(<ModelsSettings />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        if (forced) fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10001);
        });
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.queryByText('Cold SDK model')).toBeNull();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(forced ? 50000 : 5000);
        });
        expect(screen.queryByRole('alert')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Change', exact: true }));
        expect(screen.getAllByText('Cold SDK model').length).toBeGreaterThan(0);
      } finally {
        cleanup();
        hub.cleanup();
        vi.useRealTimers();
      }
    }
  );

  it('shows a durable error with Retry instead of a silent empty state when the hub is missing', async () => {
    render(<ModelsSettings />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Not connected to server');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText('Loading models...')).toBeNull();
    });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('clears the error after Retry once the hub is connected', async () => {
    render(<ModelsSettings />);
    await screen.findByRole('alert');

    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue({
      models: [{ id: 'claude-sonnet-5', display_name: 'Sonnet', description: '' }],
    });

    const retry = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    await waitFor(() => {
      expect(retry.disabled).toBe(false);
    });
    fireEvent.click(retry);

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(mockRequest).toHaveBeenCalledWith(
      'models.list',
      { useCache: true },
      { timeout: MODEL_LIST_REQUEST_TIMEOUT_MS }
    );
  });

  it('keeps the error state when Retry runs while the hub is still missing', async () => {
    render(<ModelsSettings />);
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Not connected to server');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('records the error message when the models.list request rejects', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockRejectedValue(new Error('models list failed'));

    render(<ModelsSettings />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('models list failed');
  });

  it('auto-retries the load when the connection becomes ready', async () => {
    mockConnectionState.value = 'disconnected';
    render(<ModelsSettings />);
    await screen.findByRole('alert');

    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue({ models: [] });
    mockConnectionState.value = 'connected';

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(mockRequest).toHaveBeenCalledWith(
      'models.list',
      { useCache: true },
      { timeout: MODEL_LIST_REQUEST_TIMEOUT_MS }
    );
  });

  it('retries with forceRefresh after a failed explicit refresh', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValueOnce({ models: [] });

    render(<ModelsSettings />);
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });
    const refresh = screen.getByRole('button', { name: 'Refresh models' }) as HTMLButtonElement;
    await waitFor(() => {
      expect(refresh.disabled).toBe(false);
    });

    mockRequest.mockRejectedValueOnce(new Error('refresh failed'));
    fireEvent.click(refresh);
    await screen.findByRole('alert');

    const retry = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    await waitFor(() => {
      expect(retry.disabled).toBe(false);
    });
    mockRequest.mockResolvedValueOnce({ models: [] });
    fireEvent.click(retry);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenLastCalledWith(
        'models.list',
        { forceRefresh: true },
        { timeout: MODEL_LIST_REQUEST_TIMEOUT_MS }
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('disables Retry while the retry request is in flight', async () => {
    render(<ModelsSettings />);
    await screen.findByRole('alert');

    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    let resolveRequest: (value: { models: unknown[] }) => void = () => {};
    mockRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      })
    );

    const retry = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    await waitFor(() => {
      expect(retry.disabled).toBe(false);
    });
    fireEvent.click(retry);

    await waitFor(() => {
      expect(retry.disabled).toBe(true);
    });
    resolveRequest({ models: [] });
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('auto-retries once when a load error lands while already connected', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest
      .mockRejectedValueOnce(new Error('request timed out'))
      .mockResolvedValue({ models: [] });

    render(<ModelsSettings />);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });
    expect(mockRequest).toHaveBeenLastCalledWith(
      'models.list',
      { useCache: true },
      { timeout: MODEL_LIST_REQUEST_TIMEOUT_MS }
    );
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('disables Retry while an explicit Refresh models is in flight', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockRejectedValue(new Error('load failed'));

    render(<ModelsSettings />);
    await screen.findByRole('alert');
    const refresh = screen.getByRole('button', { name: 'Refresh models' }) as HTMLButtonElement;
    await waitFor(() => {
      expect(refresh.disabled).toBe(false);
    });

    let resolveRequest: (value: { models: unknown[] }) => void = () => {};
    mockRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      })
    );

    fireEvent.click(refresh);
    const retry = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    await waitFor(() => {
      expect(retry.disabled).toBe(true);
    });
    expect(mockRequest).toHaveBeenLastCalledWith(
      'models.list',
      { forceRefresh: true },
      { timeout: MODEL_LIST_REQUEST_TIMEOUT_MS }
    );

    resolveRequest({ models: [] });
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('re-auto-retries a recurring error after a successful recovery', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockRejectedValue(new Error('boom'));

    render(<ModelsSettings />);
    await screen.findByRole('alert');
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    mockRequest.mockResolvedValueOnce({ models: [] });
    const retry = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    await waitFor(() => {
      expect(retry.disabled).toBe(false);
    });
    fireEvent.click(retry);
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });

    const refresh = screen.getByRole('button', { name: 'Refresh models' }) as HTMLButtonElement;
    await waitFor(() => {
      expect(refresh.disabled).toBe(false);
    });
    mockRequest.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ models: [] });
    fireEvent.click(refresh);
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(5);
    });
    expect(mockRequest).toHaveBeenLastCalledWith(
      'models.list',
      { forceRefresh: true },
      { timeout: MODEL_LIST_REQUEST_TIMEOUT_MS }
    );
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('does not start another load while one is already in flight', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockRejectedValue(new Error('boom'));

    render(<ModelsSettings />);
    await screen.findByRole('alert');
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    let resolveRequest: (value: { models: unknown[] }) => void = () => {};
    mockRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      })
    );

    const retry = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    await waitFor(() => {
      expect(retry.disabled).toBe(false);
    });
    fireEvent.click(retry);
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(3);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save OpenRouter allowlist' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(mockRequest).toHaveBeenCalledTimes(3);

    resolveRequest({ models: [] });
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('stops auto-retrying when failure messages alternate within one episode', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest
      .mockRejectedValueOnce(new Error('alpha'))
      .mockRejectedValueOnce(new Error('beta'))
      .mockRejectedValueOnce(new Error('alpha'));

    render(<ModelsSettings />);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(3);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(mockRequest).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('alert').textContent).toContain('alpha');
  });

  it('runs a deferred force refresh, holding loading, when the allowlist save lands during an active load', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockRejectedValue(new Error('boom'));

    render(<ModelsSettings />);
    await screen.findByRole('alert');
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    const resolvers: Array<(value: { models: unknown[] }) => void> = [];
    mockRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );

    const retry = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    await waitFor(() => {
      expect(retry.disabled).toBe(false);
    });
    fireEvent.click(retry);
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(3);
    });

    const refresh = screen.getByRole('button', { name: 'Refresh models' }) as HTMLButtonElement;
    fireEvent.click(screen.getByRole('button', { name: 'Save OpenRouter allowlist' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(mockRequest).toHaveBeenCalledTimes(3);

    resolvers[0]({ models: [] });
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(4);
    });
    expect(mockRequest).toHaveBeenLastCalledWith(
      'models.list',
      { forceRefresh: true },
      { timeout: MODEL_LIST_REQUEST_TIMEOUT_MS }
    );
    await waitFor(() => {
      expect(refresh.disabled).toBe(true);
    });

    resolvers[1]({ models: [] });
    await waitFor(() => {
      expect(refresh.disabled).toBe(false);
    });
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('disables Retry while the allowlist-save refresh is in flight and clears loading after', async () => {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockRejectedValue(new Error('boom'));

    render(<ModelsSettings />);
    await screen.findByRole('alert');
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    const resolvers: Array<(value: { models: unknown[] }) => void> = [];
    mockRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );

    const retry = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    await waitFor(() => {
      expect(retry.disabled).toBe(false);
    });
    const refresh = screen.getByRole('button', { name: 'Refresh models' }) as HTMLButtonElement;

    fireEvent.click(screen.getByRole('button', { name: 'Save OpenRouter allowlist' }));
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(retry.disabled).toBe(true);
    });

    resolvers[0]({ models: [] });
    await waitFor(() => {
      expect(refresh.disabled).toBe(false);
    });
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});

describe('ModelsSettings — default model', () => {
  beforeEach(() => {
    cleanup();
    mockConnectionState.value = 'connected';
    mockGetHubIfConnected.mockReset().mockReturnValue({ request: mockRequest });
    mockRequest.mockReset().mockResolvedValue({
      models: [
        { id: 'opus', display_name: 'Claude Opus', description: '', provider: 'anthropic' },
        { id: 'kimi-k3', display_name: 'Kimi K3', description: '', provider: 'kimi' },
      ],
    });
    mockListProviderAuthStatus.mockReset().mockResolvedValue({ providers: [] });
    (globalSettings as { value: unknown }).value = { model: 'opus', modelProvider: 'anthropic' };
  });

  afterEach(() => {
    (globalSettings as { value: unknown }).value = null;
    cleanup();
  });

  it('shows the saved default and saves a new one with its provider', async () => {
    render(<ModelsSettings />);
    await screen.findByText(/^Claude Opus · /);
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Kimi K3' }));
    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenCalledWith({ model: 'kimi-k3', modelProvider: 'kimi' })
    );
  });

  it('says when the saved default is not available', async () => {
    (globalSettings as { value: unknown }).value = { model: 'gone', modelProvider: 'anthropic' };
    render(<ModelsSettings />);
    expect(await screen.findByText('gone (not available)')).toBeTruthy();
  });
});

describe('ModelsSettings — default thinking beside the default model', () => {
  const settingsRef = globalSettings as { value: unknown };

  function serveModels(models: unknown[]) {
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue({ models });
  }

  beforeEach(() => {
    cleanup();
    mockConnectionState.value = 'connected';
    mockRequest.mockReset();
    mockListProviderAuthStatus.mockReset().mockResolvedValue({ providers: [] });
    vi.mocked(updateGlobalSettings)
      .mockReset()
      .mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    cleanup();
    settingsRef.value = null;
  });

  it('shows the saved global thinking level and writes nothing on open', async () => {
    settingsRef.value = {
      model: 'claude-sonnet-5',
      modelProvider: 'anthropic',
      thinkingLevel: 'think24k',
    };
    serveModels([
      {
        id: 'claude-sonnet-5',
        display_name: 'Sonnet',
        description: '',
        provider: 'anthropic',
        thinkingModes: 'granular',
      },
    ]);
    render(<ModelsSettings />);

    const select = (await screen.findByLabelText('Default thinking')) as HTMLSelectElement;
    await waitFor(() => expect(screen.getByText(/Sonnet · /)).toBeTruthy());
    expect(select.value).toBe('think24k');
    expect([...select.options].map((option) => option.value)).toEqual([
      'off',
      'think8k',
      'think16k',
      'think24k',
      'think32k',
      'think48k',
      'think64k',
    ]);
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });

  it('saves only the global thinkingLevel key when changed', async () => {
    settingsRef.value = {
      model: 'claude-sonnet-5',
      modelProvider: 'anthropic',
      thinkingLevel: 'off',
    };
    serveModels([
      {
        id: 'claude-sonnet-5',
        display_name: 'Sonnet',
        description: '',
        provider: 'anthropic',
        thinkingModes: 'granular',
      },
    ]);
    render(<ModelsSettings />);

    const select = (await screen.findByLabelText('Default thinking')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'think16k' } });

    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenCalledWith({ thinkingLevel: 'think16k' })
    );
  });

  it('offers only Off for a model without thinking, keeping an unsupported saved value as is', async () => {
    settingsRef.value = {
      model: 'minimax-m3',
      modelProvider: 'minimax',
      thinkingLevel: 'think32k',
    };
    serveModels([
      {
        id: 'minimax-m3',
        display_name: 'MiniMax M3',
        description: '',
        provider: 'minimax',
        thinkingModes: 'off',
      },
    ]);
    render(<ModelsSettings />);

    await waitFor(() => expect(screen.getByText(/MiniMax M3 · /)).toBeTruthy());
    const select = screen.getByLabelText('Default thinking') as HTMLSelectElement;
    expect(select.value).toBe('think32k');
    expect([...select.options].map((option) => option.value)).toEqual(['off', 'think32k']);
    expect(screen.getByText(/not supported by this model/)).toBeTruthy();
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });

  it('uses the provider thinking capability when the model carries none', async () => {
    settingsRef.value = { model: 'llama-4', modelProvider: 'ollama', thinkingLevel: 'off' };
    serveModels([{ id: 'llama-4', display_name: 'Llama 4', description: '', provider: 'ollama' }]);
    render(<ModelsSettings />);

    await waitFor(() => expect(screen.getByText(/Llama 4 · /)).toBeTruthy());
    const select = screen.getByLabelText('Default thinking') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['off']);
    expect(screen.queryByText(/support for this model is unknown/)).toBeNull();
  });

  it('claims no unknown thinking support while the catalog is loading', async () => {
    settingsRef.value = {
      model: 'claude-sonnet-5',
      modelProvider: 'anthropic',
      thinkingLevel: 'off',
    };
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockReturnValue(new Promise(() => {}));
    render(<ModelsSettings />);

    await screen.findAllByText('Loading models...');
    expect(screen.getByLabelText('Default thinking')).toBeTruthy();
    expect(screen.queryByText(/support for this model is unknown/)).toBeNull();
  });

  it('rolls the control back to the saved value when the save fails', async () => {
    settingsRef.value = {
      model: 'claude-sonnet-5',
      modelProvider: 'anthropic',
      thinkingLevel: 'think8k',
    };
    serveModels([
      {
        id: 'claude-sonnet-5',
        display_name: 'Sonnet',
        description: '',
        provider: 'anthropic',
        thinkingModes: 'granular',
      },
    ]);
    vi.mocked(updateGlobalSettings).mockRejectedValueOnce(new Error('nope'));
    render(<ModelsSettings />);

    const select = (await screen.findByLabelText('Default thinking')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'think64k' } });

    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(select.value).toBe('think8k'));
  });
});

describe('ModelsSettings — default fallback chain thinking', () => {
  const settingsRef = globalSettings as { value: unknown };
  const models = [
    {
      id: 'claude-opus-5',
      display_name: 'Opus',
      description: '',
      provider: 'anthropic',
      thinkingModes: 'granular',
    },
    {
      id: 'claude-sonnet-5',
      display_name: 'Sonnet',
      description: '',
      provider: 'anthropic',
      thinkingModes: 'granular',
    },
    {
      id: 'minimax-m3',
      display_name: 'MiniMax M3',
      description: '',
      provider: 'minimax',
      thinkingModes: 'off',
    },
    { id: 'custom-1', display_name: 'Custom', description: '', provider: 'custom-endpoint' },
  ];
  const chain = [
    { model: 'claude-opus-5', provider: 'anthropic', thinkingLevel: 'think24k' },
    { model: 'claude-sonnet-5', provider: 'anthropic' },
  ];

  async function open(fallbackModels: unknown[]) {
    settingsRef.value = { model: 'claude-opus-5', modelProvider: 'anthropic', fallbackModels };
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue({ models });
    render(<ModelsSettings />);
    await screen.findByLabelText('Fallback 1 thinking');
    await waitFor(() => expect(screen.getByText(/Opus · /)).toBeTruthy());
  }
  const row = (index: number) =>
    screen.getByLabelText(`Fallback ${index} thinking`) as HTMLSelectElement;

  beforeEach(() => {
    cleanup();
    mockConnectionState.value = 'connected';
    mockRequest.mockReset();
    mockListProviderAuthStatus.mockReset().mockResolvedValue({ providers: [] });
    vi.mocked(updateGlobalSettings)
      .mockReset()
      .mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    cleanup();
    settingsRef.value = null;
  });

  it('shows each saved level, keeps unset rows on Use default and writes nothing on open', async () => {
    await open(chain);

    expect(row(1).value).toBe('think24k');
    expect(row(2).value).toBe('');
    expect(row(2).options[0]?.textContent).toBe('Use default');
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });

  it('saves the chosen level on its own row and leaves the others as they were', async () => {
    await open(chain);

    fireEvent.change(row(2), { target: { value: 'think8k' } });

    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenCalledWith({
        fallbackModels: [chain[0], { ...chain[1], thinkingLevel: 'think8k' }],
      })
    );
  });

  it('removes the saved level when a row goes back to Use default', async () => {
    await open(chain);

    fireEvent.change(row(1), { target: { value: '' } });

    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(updateGlobalSettings).mock.calls[0]?.[0].fallbackModels;
    expect(saved?.[0]).toEqual({ model: 'claude-opus-5', provider: 'anthropic' });
    expect(saved?.[1]).toEqual(chain[1]);
  });

  it('moves model, provider and thinking together when reordering', async () => {
    await open(chain);

    fireEvent.click(screen.getAllByTitle('Move down')[0] as HTMLElement);

    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenCalledWith({ fallbackModels: [chain[1], chain[0]] })
    );
    await waitFor(() => expect(row(2).value).toBe('think24k'));
    expect(row(1).value).toBe('');
  });

  it('offers what the row model supports and keeps an unsupported saved level with a warning', async () => {
    await open([{ model: 'minimax-m3', provider: 'minimax', thinkingLevel: 'think32k' }]);

    expect(row(1).value).toBe('think32k');
    expect([...row(1).options].map((option) => option.value)).toEqual(['', 'off', 'think32k']);
    expect(screen.getByText(/not supported by this model/)).toBeTruthy();
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });

  it('says when a row model has no known thinking support', async () => {
    await open([{ model: 'custom-1', provider: 'custom-endpoint' }]);

    expect(screen.getByText(/support for this model is unknown/)).toBeTruthy();
    expect(row(1).options.length).toBe(8);
  });

  it('puts the row back when the save fails', async () => {
    vi.mocked(updateGlobalSettings).mockRejectedValue(new Error('offline'));
    await open(chain);

    fireEvent.change(row(1), { target: { value: 'think8k' } });

    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(row(1).value).toBe('think24k'));
  });
});

describe('ModelsSettings — override fallback thinking', () => {
  const settingsRef = globalSettings as { value: unknown };
  const models = [
    {
      id: 'claude-opus-5',
      display_name: 'Opus',
      description: '',
      provider: 'anthropic',
      thinkingModes: 'granular',
    },
    {
      id: 'claude-sonnet-5',
      display_name: 'Sonnet',
      description: '',
      provider: 'anthropic',
      thinkingModes: 'granular',
    },
    {
      id: 'minimax-m3',
      display_name: 'MiniMax M3',
      description: '',
      provider: 'minimax',
      thinkingModes: 'off',
    },
  ];
  const key = 'anthropic/claude-opus-5';
  const other = { 'anthropic/claude-sonnet-5': [{ model: 'minimax-m3', provider: 'minimax' }] };
  const chain = [
    { model: 'claude-sonnet-5', provider: 'anthropic', thinkingLevel: 'think24k' },
    { model: 'minimax-m3', provider: 'minimax' },
  ];

  async function edit(overrideChain: unknown[] = chain) {
    settingsRef.value = {
      model: 'claude-opus-5',
      modelProvider: 'anthropic',
      modelFallbackMap: { [key]: overrideChain, ...other },
    };
    mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
    mockRequest.mockResolvedValue({ models });
    render(<ModelsSettings />);
    await waitFor(() => expect(screen.getByText(/Opus · /)).toBeTruthy());
    fireEvent.click(screen.getAllByTitle('Edit')[0] as HTMLElement);
    await screen.findByLabelText('Override fallback 1 thinking');
  }
  const row = (index: number) =>
    screen.getByLabelText(`Override fallback ${index} thinking`) as HTMLSelectElement;
  const save = () => fireEvent.click(screen.getByText('Save'));

  beforeEach(() => {
    cleanup();
    mockConnectionState.value = 'connected';
    mockRequest.mockReset();
    mockListProviderAuthStatus.mockReset().mockResolvedValue({ providers: [] });
    vi.mocked(updateGlobalSettings)
      .mockReset()
      .mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    cleanup();
    settingsRef.value = null;
  });

  it('shows each saved level and writes nothing on open', async () => {
    await edit();

    expect(row(1).value).toBe('think24k');
    expect(row(2).value).toBe('');
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });

  it('saves the chosen level on Save and leaves other overrides alone', async () => {
    await edit();

    fireEvent.change(row(1), { target: { value: 'think8k' } });
    expect(updateGlobalSettings).not.toHaveBeenCalled();
    save();

    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenCalledWith({
        modelFallbackMap: {
          [key]: [{ ...chain[0], thinkingLevel: 'think8k' }, chain[1]],
          ...other,
        },
      })
    );
  });

  it('drops an edit on Cancel', async () => {
    await edit();

    fireEvent.change(row(1), { target: { value: 'think8k' } });
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getAllByTitle('Edit')[0] as HTMLElement);

    await screen.findByLabelText('Override fallback 1 thinking');
    expect(row(1).value).toBe('think24k');
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });

  it('keeps each level with its model when reordering', async () => {
    await edit();

    fireEvent.click(screen.getAllByTitle('Move down')[0] as HTMLElement);
    await waitFor(() => expect(row(2).value).toBe('think24k'));
    save();

    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenCalledWith({
        modelFallbackMap: { [key]: [chain[1], chain[0]], ...other },
      })
    );
  });

  it('removes the saved level when a row goes back to Use default', async () => {
    await edit();

    fireEvent.change(row(1), { target: { value: '' } });
    save();

    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(updateGlobalSettings).mock.calls[0]?.[0].modelFallbackMap;
    expect(saved?.[key]?.[0]).toEqual({ model: 'claude-sonnet-5', provider: 'anthropic' });
  });

  it('keeps an unsupported saved level with a warning', async () => {
    await edit([{ model: 'minimax-m3', provider: 'minimax', thinkingLevel: 'think32k' }]);

    expect(row(1).value).toBe('think32k');
    expect([...row(1).options].map((option) => option.value)).toEqual(['', 'off', 'think32k']);
    expect(screen.getByText(/not supported by this model/)).toBeTruthy();
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });
});
