import { signal } from '@preact/signals';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetHubIfConnected, mockRequest, mockListProviderAuthStatus } = vi.hoisted(() => ({
  mockGetHubIfConnected: vi.fn(),
  mockRequest: vi.fn(),
  mockListProviderAuthStatus: vi.fn(),
}));

vi.mock('../../../lib/state.ts', () => ({
  globalSettings: { value: null },
  connectionState: signal('connected'),
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
});
