import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/preact';
import type { ProviderRecord } from '@hyperneo/shared';
import type { ProviderAuthStatus } from '@hyperneo/shared/provider';

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
  mockToastWarning,
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
  mockToastWarning: vi.fn(),
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
  listCustomEndpointModels: vi.fn(),
}));

vi.mock('../../../lib/toast.ts', () => ({
  toast: {
    error: (msg: string) => mockToastError(msg),
    success: (msg: string) => mockToastSuccess(msg),
    info: vi.fn(),
    warning: (msg: string) => mockToastWarning(msg),
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

vi.mock('../CustomEndpointEditor.tsx', () => ({
  EditorModal: () => <div data-testid="editor-modal">Editor</div>,
  PresetPicker: () => <div data-testid="preset-picker">Presets</div>,
  presetToEditor: vi.fn(),
  editorToConfig: vi.fn(),
  validateEditor: vi.fn(() => null),
  existingToEditor: vi.fn(() => ({
    mode: 'edit',
    id: 'lm',
    type: 'openai-chat',
    name: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    apiKey: '',
    headersText: '',
    defaultModelId: '',
    models: [],
  })),
  testCustomEndpoint: vi.fn(),
}));

import { ProvidersSettings } from '../ProvidersSettings.tsx';
import { globalStore } from '../../../lib/global-store.ts';

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
    globalStore.systemState.value = null;
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

  it('shows keychain unavailable banner without DB fallback copy', async () => {
    globalStore.systemState.value = {
      credentialStore: {
        backend: 'keychain-unavailable',
        keychainAvailable: false,
        warning:
          'macOS Keychain is locked or unavailable. Run `security unlock-keychain`, launch HyperNeo from Desktop/Terminal with a GUI session, or configure credentials via environment variables.',
      },
    } as never;

    const { container } = render(<ProvidersSettings />);

    await waitFor(() => {
      expect(container.textContent).toContain('macOS Keychain unavailable');
      expect(container.textContent).toContain('security unlock-keychain');
      expect(container.textContent).toContain('environment variables');
      expect(container.textContent).not.toContain('database fallback');
      expect(container.textContent).not.toContain('local encrypted DB');
    });
  });

  it('does not show keychain banner for non-darwin database store', async () => {
    globalStore.systemState.value = {
      credentialStore: { backend: 'database', keychainAvailable: false },
    } as never;

    const { container } = render(<ProvidersSettings />);

    await waitFor(() => {
      expect(container.textContent).not.toContain('macOS Keychain unavailable');
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

    expect(container.textContent).not.toContain('Authentication');

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
    mockUpdateProvider.mockResolvedValue({ success: true, provider: providers[0] });

    const { container } = render(<ProvidersSettings />);
    await waitFor(() => expect(container.textContent).toContain('Anthropic'));

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
    mockUpdateProvider.mockResolvedValue({ success: true, provider: providers[0] });

    const { container } = render(<ProvidersSettings />);
    await waitFor(() => expect(container.textContent).toContain('Anthropic'));

    const row = container.querySelector('[class*="cursor-pointer"]');
    if (row) fireEvent.click(row);
    await waitFor(() => expect(container.textContent).toContain('Set key'));

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

  it('shows success toast on full logout (no warning field)', async () => {
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

    const row = container.querySelector('[class*="cursor-pointer"]');
    if (row) fireEvent.click(row);
    await waitFor(() => expect(container.textContent).toContain('Logout'));

    const logoutButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Logout')
    );
    if (logoutButton) fireEvent.click(logoutButton);

    await waitFor(() => {
      expect(mockLogoutProvider).toHaveBeenCalledWith('anthropic-copilot');
      expect(mockToastSuccess).toHaveBeenCalledTimes(1);
      expect(mockToastSuccess).toHaveBeenCalledWith('Logged out from Copilot');
      expect(mockToastWarning).not.toHaveBeenCalled();
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

  it('shows warning toast when auth status fails', async () => {
    mockListProviders.mockResolvedValue({
      providers: [createMockProvider('1', 'anthropic', { displayName: 'Anthropic' })],
    });
    mockListProviderAuthStatus.mockRejectedValue(new Error('Auth timeout'));

    render(<ProvidersSettings />);
    await waitFor(() => {
      expect(mockToastWarning).toHaveBeenCalledWith(
        'Auth status unavailable — showing cached state'
      );
    });
  });

  it('opens EditorModal when custom endpoint edit is clicked', async () => {
    const providers = [
      createMockProvider('1', 'custom:lm', {
        displayName: 'LM Studio',
        kind: 'custom_endpoint',
        baseUrl: 'http://localhost:1234/v1',
        customEndpointConfigJson: JSON.stringify({
          id: 'lm',
          type: 'openai-chat',
          name: 'LM Studio',
          baseUrl: 'http://localhost:1234/v1',
          models: [{ id: 'qwen' }],
        }),
      }),
    ];
    mockListProviders.mockResolvedValue({ providers });
    mockListProviderAuthStatus.mockResolvedValue({ providers: [] });

    const { container } = render(<ProvidersSettings />);
    await waitFor(() => expect(container.textContent).toContain('LM Studio'));

    const row = container.querySelector('[class*="cursor-pointer"]');
    if (row) fireEvent.click(row);
    await waitFor(() => expect(container.textContent).toContain('Edit'));

    const editButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Edit')
    );
    if (editButton) fireEvent.click(editButton);

    await waitFor(() => {
      expect(screen.getByTestId('editor-modal')).toBeTruthy();
    });
  });

  it('polls auth status and closes OAuth modal on authentication', async () => {
    vi.useFakeTimers();
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

    const row = container.querySelector('[class*="cursor-pointer"]');
    if (row) fireEvent.click(row);
    await waitFor(() => expect(container.textContent).toContain('Login'));

    const loginButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Login')
    );
    if (loginButton) fireEvent.click(loginButton);

    await waitFor(() => {
      expect(screen.getByTestId('oauth-modal')).toBeTruthy();
    });

    mockListProviderAuthStatus.mockResolvedValue({
      providers: [
        { id: 'anthropic-copilot', displayName: 'Copilot', isAuthenticated: true, method: 'oauth' },
      ],
    });

    vi.advanceTimersByTime(2500);

    await waitFor(() => {
      expect(screen.queryByTestId('oauth-modal')).toBeNull();
    });

    vi.useRealTimers();
  });
});
