/**
 * Tests for ProvidersSettings (unified provider registry view)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/preact';
import type { ProviderRecord } from '@neokai/shared';
import type { ProviderAuthStatus } from '@neokai/shared/provider';

const {
  mockListProviders,
  mockListProviderAuthStatus,
  mockUpdateProvider,
  mockDeleteProvider,
  mockSetDefaultProvider,
  mockTestProvider,
  mockLoginProvider,
  mockLogoutProvider,
  mockRefreshProvider,
  mockCreateProvider,
  mockToastError,
  mockToastSuccess,
} = vi.hoisted(() => ({
  mockListProviders: vi.fn(),
  mockListProviderAuthStatus: vi.fn(),
  mockUpdateProvider: vi.fn(),
  mockDeleteProvider: vi.fn(),
  mockSetDefaultProvider: vi.fn(),
  mockTestProvider: vi.fn(),
  mockLoginProvider: vi.fn(),
  mockLogoutProvider: vi.fn(),
  mockRefreshProvider: vi.fn(),
  mockCreateProvider: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock('../../../lib/api-helpers.ts', () => ({
  listProviders: () => mockListProviders(),
  listProviderAuthStatus: () => mockListProviderAuthStatus(),
  updateProvider: (id: string, params: unknown, creds?: unknown) =>
    mockUpdateProvider(id, params, creds),
  deleteProvider: (id: string) => mockDeleteProvider(id),
  setDefaultProvider: (id: string) => mockSetDefaultProvider(id),
  testProvider: (id: string) => mockTestProvider(id),
  loginProvider: (providerId: string) => mockLoginProvider(providerId),
  logoutProvider: (providerId: string) => mockLogoutProvider(providerId),
  refreshProvider: (providerId: string) => mockRefreshProvider(providerId),
  createProvider: (params: unknown, creds?: unknown) => mockCreateProvider(params, creds),
}));

vi.mock('../../../lib/toast.ts', () => ({
  toast: {
    error: (msg: string) => mockToastError(msg),
    success: (msg: string) => mockToastSuccess(msg),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../OAuthModal.tsx', () => ({
  OAuthModal: ({
    providerName,
    onCancel,
    onComplete,
  }: {
    providerName: string;
    onCancel: () => void;
    onComplete: () => void;
  }) => (
    <div data-testid="oauth-modal">
      <span data-testid="oauth-provider-name">{providerName}</span>
      <button data-testid="oauth-cancel-btn" onClick={onCancel}>
        Cancel
      </button>
      <button data-testid="oauth-complete-btn" onClick={onComplete}>
        Complete
      </button>
    </div>
  ),
}));

vi.mock('../AddProviderModal.tsx', () => ({
  AddProviderModal: ({
    onClose,
    onProviderAdded,
  }: {
    onClose: () => void;
    onProviderAdded: () => void;
  }) => (
    <div data-testid="add-provider-modal">
      <button data-testid="add-modal-close" onClick={onClose}>
        Close
      </button>
      <button
        data-testid="add-modal-done"
        onClick={() => {
          onProviderAdded();
          onClose();
        }}
      >
        Done
      </button>
    </div>
  ),
}));

vi.mock('../SettingsSection.tsx', () => ({
  SettingsSection: ({
    title,
    children,
  }: {
    title: string;
    children: import('preact').ComponentChildren;
  }) => (
    <div data-testid="settings-section">
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  ),
}));

vi.mock('../../ui/Button.tsx', () => ({
  Button: ({
    children,
    variant,
    size,
    onClick,
    disabled,
    loading,
    fullWidth,
  }: {
    children: import('preact').ComponentChildren;
    variant?: string;
    size?: string;
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
    fullWidth?: boolean;
  }) => (
    <button
      data-testid={`button-${variant || 'primary'}`}
      data-size={size}
      data-fullwidth={fullWidth ? 'true' : undefined}
      disabled={disabled || loading}
      onClick={onClick}
    >
      {loading && <span data-testid="button-loading">Loading...</span>}
      {children}
    </button>
  ),
}));

// Mock CustomEndpointEditor to avoid pulling in heavy deps
vi.mock('../CustomEndpointEditor.tsx', () => ({
  EditorModal: () => <div data-testid="editor-modal">Editor</div>,
  PresetPicker: () => <div data-testid="preset-picker">Presets</div>,
  presetToEditor: vi.fn(),
  editorToConfig: vi.fn(),
  validateEditor: vi.fn(() => null),
  existingToEditor: vi.fn(),
}));

import { ProvidersSettings } from '../ProvidersSettings.tsx';

function createMockProvider(
  id: string,
  providerId: string,
  overrides: Partial<ProviderRecord & { available: boolean }> = {}
): ProviderRecord & { available: boolean } {
  return {
    id,
    providerId,
    displayName: providerId,
    kind: 'built_in',
    authType: 'api_key',
    isEnabled: true,
    isDefault: false,
    sortOrder: 0,
    healthStatus: 'unknown',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    available: false,
    ...overrides,
  };
}

describe('ProvidersSettings', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockListProviders.mockResolvedValue({ providers: [] });
    mockListProviderAuthStatus.mockResolvedValue({ providers: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows loading state initially', async () => {
    let resolvePromise: (value: { providers: (ProviderRecord & { available: boolean })[] }) => void;
    mockListProviders.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePromise = resolve;
        })
    );
    mockListProviderAuthStatus.mockResolvedValue({ providers: [] });

    const { container } = render(<ProvidersSettings />);
    expect(container.textContent).toContain('Loading providers...');

    resolvePromise!({ providers: [] });
    await waitFor(() => {
      expect(container.textContent).not.toContain('Loading providers...');
    });
  });

  it('shows empty state when no providers', async () => {
    mockListProviders.mockResolvedValue({ providers: [] });
    mockListProviderAuthStatus.mockResolvedValue({ providers: [] });

    const { container } = render(<ProvidersSettings />);
    await waitFor(() => {
      expect(container.textContent).toContain('No providers configured');
    });
  });

  it('renders provider list with badges', async () => {
    const providers = [
      createMockProvider('1', 'anthropic', {
        displayName: 'Anthropic',
        healthStatus: 'healthy',
        available: true,
      }),
      createMockProvider('2', 'custom:lm', {
        displayName: 'LM Studio',
        kind: 'custom_endpoint',
        healthStatus: 'unhealthy',
      }),
    ];
    mockListProviders.mockResolvedValue({ providers });
    mockListProviderAuthStatus.mockResolvedValue({ providers: [] });

    const { container } = render(<ProvidersSettings />);
    await waitFor(() => {
      expect(container.textContent).toContain('Anthropic');
      expect(container.textContent).toContain('LM Studio');
      expect(container.textContent).toContain('Built-in');
      expect(container.textContent).toContain('Custom');
      expect(container.textContent).toContain('API Key');
    });
  });

  it('expands provider row on click', async () => {
    const providers = [
      createMockProvider('1', 'anthropic', { displayName: 'Anthropic', authType: 'api_key' }),
    ];
    mockListProviders.mockResolvedValue({ providers });
    mockListProviderAuthStatus.mockResolvedValue({ providers: [] });

    const { container } = render(<ProvidersSettings />);
    await waitFor(() => expect(container.textContent).toContain('Anthropic'));

    // Initially no auth section
    expect(container.textContent).not.toContain('Authentication');

    // Click to expand
    const row = container.querySelector('[class*="cursor-pointer"]');
    if (row) fireEvent.click(row);

    await waitFor(() => {
      expect(container.textContent).toContain('Authentication');
      expect(container.textContent).toContain('Health');
    });
  });

  it('toggles provider enabled state', async () => {
    const providers = [
      createMockProvider('1', 'anthropic', { displayName: 'Anthropic', isEnabled: true }),
    ];
    mockListProviders.mockResolvedValue({ providers });
    mockListProviderAuthStatus.mockResolvedValue({ providers: [] });
    mockUpdateProvider.mockResolvedValue({ success: true });

    const { container } = render(<ProvidersSettings />);
    await waitFor(() => expect(container.textContent).toContain('Anthropic'));

    // Find and click the toggle (role=switch)
    const toggle = container.querySelector('[role="switch"]');
    if (toggle) fireEvent.click(toggle);

    await waitFor(() => {
      expect(mockUpdateProvider).toHaveBeenCalledWith('1', { isEnabled: false }, undefined);
    });
  });

  it('sets provider as default', async () => {
    const providers = [
      createMockProvider('1', 'anthropic', { displayName: 'Anthropic', isDefault: false }),
    ];
    mockListProviders.mockResolvedValue({ providers });
    mockListProviderAuthStatus.mockResolvedValue({ providers: [] });
    mockSetDefaultProvider.mockResolvedValue({ success: true });

    const { container } = render(<ProvidersSettings />);
    await waitFor(() => expect(container.textContent).toContain('Anthropic'));

    // Click the star button
    const starButton = container.querySelector('button[title="Set as default"]');
    if (starButton) fireEvent.click(starButton);

    await waitFor(() => {
      expect(mockSetDefaultProvider).toHaveBeenCalledWith('1');
    });
  });

  it('deletes provider after confirm', async () => {
    const providers = [createMockProvider('1', 'anthropic', { displayName: 'Anthropic' })];
    mockListProviders.mockResolvedValue({ providers });
    mockListProviderAuthStatus.mockResolvedValue({ providers: [] });
    mockDeleteProvider.mockResolvedValue({ success: true });
    vi.stubGlobal('confirm', () => true);

    const { container } = render(<ProvidersSettings />);
    await waitFor(() => expect(container.textContent).toContain('Anthropic'));

    // Expand row first
    const row = container.querySelector('[class*="cursor-pointer"]');
    if (row) fireEvent.click(row);
    await waitFor(() => expect(container.textContent).toContain('Delete'));

    const deleteButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Delete')
    );
    if (deleteButton) fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(mockDeleteProvider).toHaveBeenCalledWith('1');
    });

    vi.unstubAllGlobals();
  });

  it('tests provider connection', async () => {
    const providers = [createMockProvider('1', 'anthropic', { displayName: 'Anthropic' })];
    mockListProviders.mockResolvedValue({ providers });
    mockListProviderAuthStatus.mockResolvedValue({ providers: [] });
    mockTestProvider.mockResolvedValue({ healthy: true });

    const { container } = render(<ProvidersSettings />);
    await waitFor(() => expect(container.textContent).toContain('Anthropic'));

    // Expand row
    const row = container.querySelector('[class*="cursor-pointer"]');
    if (row) fireEvent.click(row);
    await waitFor(() => expect(container.textContent).toContain('Test connection'));

    const testButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Test connection')
    );
    if (testButton) fireEvent.click(testButton);

    await waitFor(() => {
      expect(mockTestProvider).toHaveBeenCalledWith('1');
    });
  });

  it('updates API key for provider', async () => {
    const providers = [
      createMockProvider('1', 'anthropic', { displayName: 'Anthropic', authType: 'api_key' }),
    ];
    mockListProviders.mockResolvedValue({ providers });
    mockListProviderAuthStatus.mockResolvedValue({ providers: [] });
    mockUpdateProvider.mockResolvedValue({ success: true });

    const { container } = render(<ProvidersSettings />);
    await waitFor(() => expect(container.textContent).toContain('Anthropic'));

    // Expand row
    const row = container.querySelector('[class*="cursor-pointer"]');
    if (row) fireEvent.click(row);
    await waitFor(() => expect(container.textContent).toContain('Set key'));

    // Type API key
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'sk-test' } });

    const setKeyButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Set key')
    );
    if (setKeyButton) fireEvent.click(setKeyButton);

    await waitFor(() => {
      expect(mockUpdateProvider).toHaveBeenCalledWith('1', {}, { apiKey: 'sk-test' });
    });
  });

  it('shows OAuth login button for unauthenticated OAuth provider', async () => {
    const providers = [
      createMockProvider('1', 'anthropic-copilot', {
        displayName: 'Copilot',
        authType: 'oauth',
        available: false,
      }),
    ];
    mockListProviders.mockResolvedValue({ providers });
    mockListProviderAuthStatus.mockResolvedValue({
      providers: [
        {
          id: 'anthropic-copilot',
          displayName: 'Copilot',
          isAuthenticated: false,
          method: 'oauth',
        },
      ],
    });
    mockLoginProvider.mockResolvedValue({ success: true, authUrl: 'https://example.com/oauth' });

    const { container } = render(<ProvidersSettings />);
    await waitFor(() => expect(container.textContent).toContain('Copilot'));

    // Expand row
    const row = container.querySelector('[class*="cursor-pointer"]');
    if (row) fireEvent.click(row);
    await waitFor(() => expect(container.textContent).toContain('Login'));

    const loginButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Login')
    );
    if (loginButton) fireEvent.click(loginButton);

    await waitFor(() => {
      expect(mockLoginProvider).toHaveBeenCalledWith('anthropic-copilot');
    });
  });

  it('shows OAuth logout button for authenticated OAuth provider', async () => {
    const providers = [
      createMockProvider('1', 'anthropic-copilot', {
        displayName: 'Copilot',
        authType: 'oauth',
        available: true,
      }),
    ];
    mockListProviders.mockResolvedValue({ providers });
    mockListProviderAuthStatus.mockResolvedValue({
      providers: [
        { id: 'anthropic-copilot', displayName: 'Copilot', isAuthenticated: true, method: 'oauth' },
      ],
    });
    mockLogoutProvider.mockResolvedValue({ success: true });

    const { container } = render(<ProvidersSettings />);
    await waitFor(() => expect(container.textContent).toContain('Copilot'));

    // Expand row
    const row = container.querySelector('[class*="cursor-pointer"]');
    if (row) fireEvent.click(row);
    await waitFor(() => expect(container.textContent).toContain('Logout'));

    const logoutButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Logout')
    );
    if (logoutButton) fireEvent.click(logoutButton);

    await waitFor(() => {
      expect(mockLogoutProvider).toHaveBeenCalledWith('anthropic-copilot');
    });
  });

  it('opens Add Provider modal when button clicked', async () => {
    mockListProviders.mockResolvedValue({ providers: [] });
    mockListProviderAuthStatus.mockResolvedValue({ providers: [] });

    const { container, getByTestId } = render(<ProvidersSettings />);
    await waitFor(() => expect(container.textContent).toContain('Add Provider'));

    const addButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add Provider')
    );
    if (addButton) fireEvent.click(addButton);

    await waitFor(() => {
      expect(getByTestId('add-provider-modal')).toBeTruthy();
    });
  });

  it('shows refresh needed badge when auth status indicates it', async () => {
    const providers = [
      createMockProvider('1', 'openai', {
        displayName: 'OpenAI',
        authType: 'oauth',
        available: true,
      }),
    ];
    mockListProviders.mockResolvedValue({ providers });
    mockListProviderAuthStatus.mockResolvedValue({
      providers: [
        {
          id: 'openai',
          displayName: 'OpenAI',
          isAuthenticated: true,
          method: 'oauth',
          needsRefresh: true,
        },
      ],
    });

    const { container } = render(<ProvidersSettings />);
    await waitFor(() => {
      expect(container.textContent).toContain('Refresh Needed');
    });
  });

  it('shows error toast when listProviders fails', async () => {
    mockListProviders.mockRejectedValue(new Error('Network error'));
    mockListProviderAuthStatus.mockResolvedValue({ providers: [] });

    render(<ProvidersSettings />);
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Failed to load providers');
    });
  });
});
