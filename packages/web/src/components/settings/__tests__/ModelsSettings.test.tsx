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

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

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
    mockRequest
      .mockResolvedValueOnce({ models: [] })
      .mockRejectedValueOnce(new Error('refresh failed'));

    render(<ModelsSettings />);
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
    await screen.findByRole('alert');

    mockRequest.mockResolvedValue({ models: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

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
    fireEvent.click(retry);

    await waitFor(() => {
      expect(retry.disabled).toBe(true);
    });
    resolveRequest({ models: [] });
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});
