import { signal } from '@preact/signals';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/preact';
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
    expect(mockRequest).toHaveBeenCalledWith('models.list', { useCache: true });
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
    expect(mockRequest).toHaveBeenCalledWith('models.list', { useCache: true });
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
      expect(mockRequest).toHaveBeenLastCalledWith('models.list', { forceRefresh: true });
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
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockRequest).toHaveBeenLastCalledWith('models.list', { useCache: true });
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
    expect(mockRequest).toHaveBeenLastCalledWith('models.list', { forceRefresh: true });

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
    expect(mockRequest).toHaveBeenLastCalledWith('models.list', { forceRefresh: true });
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
});
