// @ts-nocheck
/**
 * Tests for ProvidersSettings Component
 *
 * Tests provider authentication settings UI including:
 * - Loading state
 * - Provider list display
 * - Login/Logout buttons
 * - OAuth flow handling
 * - Polling for auth completion
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/preact';
import type { ProviderAuthStatus, ProviderAuthResponse } from '@neokai/shared/provider';

// Define mocks using vi.hoisted for proper hoisting
const {
  mockListProviderAuthStatus,
  mockLoginProvider,
  mockLogoutProvider,
  mockRefreshProvider,
  mockToastError,
  mockToastSuccess,
} = vi.hoisted(() => ({
  mockListProviderAuthStatus: vi.fn(),
  mockLoginProvider: vi.fn(),
  mockLogoutProvider: vi.fn(),
  mockRefreshProvider: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

// Mock api-helpers module
vi.mock('../../../lib/api-helpers.ts', () => ({
  listProviderAuthStatus: () => mockListProviderAuthStatus(),
  loginProvider: (providerId: string) => mockLoginProvider(providerId),
  logoutProvider: (providerId: string) => mockLogoutProvider(providerId),
  refreshProvider: (providerId: string) => mockRefreshProvider(providerId),
}));

// Mock toast module
vi.mock('../../../lib/toast.ts', () => ({
  toast: {
    error: (msg: string) => mockToastError(msg),
    success: (msg: string) => mockToastSuccess(msg),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

// Mock OAuthModal component
vi.mock('../OAuthModal.tsx', () => ({
  OAuthModal: ({
    providerName,
    authUrl,
    userCode,
    verificationUri,
    onCancel,
    onComplete,
  }: {
    providerName: string;
    authUrl?: string;
    userCode?: string;
    verificationUri?: string;
    onCancel: () => void;
    onComplete: () => void;
  }) => (
    <div data-testid="oauth-modal">
      <span data-testid="oauth-provider-name">{providerName}</span>
      {authUrl && <span data-testid="oauth-auth-url">{authUrl}</span>}
      {userCode && <span data-testid="oauth-user-code">{userCode}</span>}
      {verificationUri && <span data-testid="oauth-verification-uri">{verificationUri}</span>}
      <button data-testid="oauth-cancel-btn" onClick={onCancel}>
        Cancel
      </button>
      <button data-testid="oauth-complete-btn" onClick={onComplete}>
        Complete
      </button>
    </div>
  ),
}));

// Mock SettingsSection component
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

// Mock Button component
vi.mock('../../ui/Button.tsx', () => ({
  Button: ({
    children,
    variant,
    size,
    onClick,
    disabled,
    loading,
  }: {
    children: import('preact').ComponentChildren;
    variant?: string;
    size?: string;
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
  }) => (
    <button
      data-testid={`button-${variant || 'primary'}`}
      data-size={size}
      disabled={disabled || loading}
      onClick={onClick}
    >
      {loading && <span data-testid="button-loading">Loading...</span>}
      {children}
    </button>
  ),
}));

// Import the component after mocks are set up
import { ProvidersSettings } from '../ProvidersSettings.tsx';

// Helper to create mock provider auth status
const createMockProvider = (
  id: string,
  displayName: string,
  overrides: Partial<ProviderAuthStatus> = {}
): ProviderAuthStatus => ({
  id,
  displayName,
  isAuthenticated: false,
  ...overrides,
});

describe('ProvidersSettings', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    // Default mock for listProviderAuthStatus
    mockListProviderAuthStatus.mockResolvedValue({ providers: [] });
    // Default mock for refreshProvider
    mockRefreshProvider.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    cleanup();
  });

  describe('Loading State', () => {
    it('should show loading state initially', async () => {
      // Delay the response to test loading state
      let resolvePromise: (value: { providers: ProviderAuthStatus[] }) => void;
      mockListProviderAuthStatus.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePromise = resolve;
          })
      );

      const { container } = render(<ProvidersSettings />);

      // Should show loading state
      expect(container.textContent).toContain('Loading providers...');

      // Resolve the promise
      resolvePromise!({ providers: [] });

      // Wait for loading to complete
      await waitFor(() => {
        expect(container.textContent).not.toContain('Loading providers...');
      });
    });

    it('should call listProviderAuthStatus on mount', async () => {
      mockListProviderAuthStatus.mockResolvedValue({ providers: [] });

      render(<ProvidersSettings />);

      await waitFor(() => {
        expect(mockListProviderAuthStatus).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Provider List Display', () => {
    it('should load and display providers after mount', async () => {
      const mockProviders = [
        createMockProvider('anthropic', 'Anthropic', { isAuthenticated: true, method: 'api_key' }),
        createMockProvider('openai', 'OpenAI', { isAuthenticated: false }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('Anthropic');
        expect(container.textContent).toContain('OpenAI');
      });
    });

    it('should show "No providers available" when list is empty', async () => {
      mockListProviderAuthStatus.mockResolvedValue({ providers: [] });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('No providers available');
      });
    });

    it('should show provider description text', async () => {
      mockListProviderAuthStatus.mockResolvedValue({ providers: [] });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain(
          'Configure authentication for AI providers. Each provider may use OAuth or API keys.'
        );
      });
    });

    it('should display Ollama Local and Ollama Cloud providers', async () => {
      const mockProviders = [
        createMockProvider('ollama', 'Ollama (Local)', {
          isAuthenticated: true,
          method: 'api_key',
        }),
        createMockProvider('ollama-cloud', 'Ollama Cloud', {
          isAuthenticated: false,
          error: 'Set OLLAMA_CLOUD_API_KEY to enable Ollama Cloud.',
        }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('Ollama (Local)');
        expect(container.textContent).toContain('Ollama Cloud');
        expect(container.textContent).toContain('Set OLLAMA_CLOUD_API_KEY');
      });
    });
  });

  describe('Login Button for Unauthenticated Providers', () => {
    it('should show Login button for unauthenticated provider', async () => {
      const mockProviders = [createMockProvider('openai', 'OpenAI', { isAuthenticated: false })];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('Login');
      });
    });

    it('should call loginProvider when Login button clicked', async () => {
      const mockProviders = [createMockProvider('openai', 'OpenAI', { isAuthenticated: false })];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLoginProvider.mockResolvedValue({
        success: true,
        authUrl: 'https://example.com/oauth',
      } as ProviderAuthResponse);

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('OpenAI');
      });

      // Find and click the Login button
      const loginButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Login')
      );
      loginButton?.click();

      await waitFor(() => {
        expect(mockLoginProvider).toHaveBeenCalledWith('openai');
      });
    });

    it('should show OAuth modal when loginProvider returns authUrl', async () => {
      const mockProviders = [createMockProvider('openai', 'OpenAI', { isAuthenticated: false })];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLoginProvider.mockResolvedValue({
        success: true,
        authUrl: 'https://example.com/oauth',
      } as ProviderAuthResponse);

      const { container, getByTestId } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('OpenAI');
      });

      const loginButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Login')
      );
      loginButton?.click();

      await waitFor(() => {
        expect(getByTestId('oauth-modal')).toBeTruthy();
        expect(getByTestId('oauth-provider-name').textContent).toBe('OpenAI');
        expect(getByTestId('oauth-auth-url').textContent).toBe('https://example.com/oauth');
      });
    });

    it('should show OAuth modal with device flow info when userCode and verificationUri provided', async () => {
      const mockProviders = [
        createMockProvider('github', 'GitHub Copilot', { isAuthenticated: false }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLoginProvider.mockResolvedValue({
        success: true,
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/device',
      } as ProviderAuthResponse);

      const { container, getByTestId } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('GitHub Copilot');
      });

      const loginButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Login')
      );
      loginButton?.click();

      await waitFor(() => {
        expect(getByTestId('oauth-modal')).toBeTruthy();
        expect(getByTestId('oauth-user-code').textContent).toBe('ABCD-1234');
        expect(getByTestId('oauth-verification-uri').textContent).toBe('https://github.com/device');
      });
    });

    it('should show error toast when loginProvider returns success: false', async () => {
      const mockProviders = [createMockProvider('openai', 'OpenAI', { isAuthenticated: false })];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLoginProvider.mockResolvedValue({
        success: false,
        error: 'OAuth not supported',
      } as ProviderAuthResponse);

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('OpenAI');
      });

      const loginButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Login')
      );
      loginButton?.click();

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('OAuth not supported');
      });
    });

    it('should show error toast when loginProvider throws error', async () => {
      const mockProviders = [createMockProvider('openai', 'OpenAI', { isAuthenticated: false })];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLoginProvider.mockRejectedValue(new Error('Network error'));

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('OpenAI');
      });

      const loginButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Login')
      );
      loginButton?.click();

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Network error');
      });
    });

    it('should show generic error when loginProvider throws non-Error', async () => {
      const mockProviders = [createMockProvider('openai', 'OpenAI', { isAuthenticated: false })];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLoginProvider.mockRejectedValue('Unknown error');

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('OpenAI');
      });

      const loginButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Login')
      );
      loginButton?.click();

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Failed to start login');
      });
    });
  });

  describe('Logout Button for Authenticated Providers', () => {
    it('should show Logout button for authenticated provider', async () => {
      const mockProviders = [
        createMockProvider('anthropic', 'Anthropic', { isAuthenticated: true, method: 'api_key' }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('Logout');
      });
    });

    it('should show auth method badge for authenticated provider (API Key)', async () => {
      const mockProviders = [
        createMockProvider('anthropic', 'Anthropic', { isAuthenticated: true, method: 'api_key' }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('API Key');
      });
    });

    it('should show auth method badge for authenticated provider (OAuth)', async () => {
      const mockProviders = [
        createMockProvider('openai', 'OpenAI', { isAuthenticated: true, method: 'oauth' }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('OAuth');
      });
    });

    it('should call logoutProvider when Logout button clicked', async () => {
      const mockProviders = [
        createMockProvider('anthropic', 'Anthropic', { isAuthenticated: true, method: 'api_key' }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLogoutProvider.mockResolvedValue({ success: true });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('Anthropic');
      });

      const logoutButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Logout')
      );
      logoutButton?.click();

      await waitFor(() => {
        expect(mockLogoutProvider).toHaveBeenCalledWith('anthropic');
      });
    });

    it('should show success toast after logout', async () => {
      const mockProviders = [
        createMockProvider('anthropic', 'Anthropic', { isAuthenticated: true, method: 'api_key' }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLogoutProvider.mockResolvedValue({ success: true });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('Anthropic');
      });

      const logoutButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Logout')
      );
      logoutButton?.click();

      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith('Logged out from Anthropic');
      });
    });

    it('should refresh provider list after logout', async () => {
      const mockProviders = [
        createMockProvider('anthropic', 'Anthropic', { isAuthenticated: true, method: 'api_key' }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLogoutProvider.mockResolvedValue({ success: true });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(mockListProviderAuthStatus).toHaveBeenCalledTimes(1);
      });

      const logoutButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Logout')
      );
      logoutButton?.click();

      await waitFor(() => {
        // Called again after logout
        expect(mockListProviderAuthStatus).toHaveBeenCalledTimes(2);
      });
    });

    it('should show error toast when logoutProvider throws error', async () => {
      const mockProviders = [
        createMockProvider('anthropic', 'Anthropic', { isAuthenticated: true, method: 'api_key' }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLogoutProvider.mockRejectedValue(new Error('Logout failed'));

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('Anthropic');
      });

      const logoutButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Logout')
      );
      logoutButton?.click();

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Logout failed');
      });
    });

    it('should show generic error when logoutProvider throws non-Error', async () => {
      const mockProviders = [
        createMockProvider('anthropic', 'Anthropic', { isAuthenticated: true, method: 'api_key' }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLogoutProvider.mockRejectedValue('Unknown error');

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('Anthropic');
      });

      const logoutButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Logout')
      );
      logoutButton?.click();

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Failed to logout');
      });
    });

    it('should show error toast when logoutProvider returns success: false', async () => {
      const mockProviders = [
        createMockProvider('anthropic', 'Anthropic', { isAuthenticated: true, method: 'api_key' }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLogoutProvider.mockResolvedValue({ success: false, error: 'Logout not supported' });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('Anthropic');
      });

      const logoutButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Logout')
      );
      logoutButton?.click();

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Logout not supported');
        // Success toast must NOT be shown
        expect(mockToastSuccess).not.toHaveBeenCalled();
      });
    });

    it('should show fallback error message when logoutProvider returns success: false without error', async () => {
      const mockProviders = [
        createMockProvider('anthropic', 'Anthropic', { isAuthenticated: true, method: 'api_key' }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLogoutProvider.mockResolvedValue({ success: false });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('Anthropic');
      });

      const logoutButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Logout')
      );
      logoutButton?.click();

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Failed to logout from Anthropic');
        expect(mockToastSuccess).not.toHaveBeenCalled();
      });
    });

    it('should show both Refresh Login and Logout buttons when isAuthenticated and needsRefresh are true', async () => {
      const mockProviders = [
        createMockProvider('openai', 'OpenAI', {
          isAuthenticated: true,
          method: 'oauth',
          needsRefresh: true,
        }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('OpenAI');
      });

      const refreshButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Refresh Login')
      );
      const logoutButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Logout')
      );
      expect(refreshButton).toBeDefined();
      expect(logoutButton).toBeDefined();
    });

    it('should show Logout button after refresh failure even when isAuthenticated is false', async () => {
      // refreshFailed path: needsRefresh: true, isAuthenticated: false → after refresh failure
      // the condition (isAuthenticated || (needsRefresh && refreshFailed.has(id))) becomes true
      const mockProviders = [
        createMockProvider('openai', 'OpenAI', {
          isAuthenticated: false,
          needsRefresh: true,
        }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockRefreshProvider.mockResolvedValue({ success: false, error: 'Token expired' });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('OpenAI');
      });

      // Initially no Logout button since isAuthenticated is false and refreshFailed is empty
      expect(
        Array.from(container.querySelectorAll('button')).find((btn) =>
          btn.textContent?.includes('Logout')
        )
      ).toBeUndefined();

      // Click Refresh Login to trigger a failed refresh (adds provider to refreshFailed)
      const refreshButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Refresh Login')
      );
      refreshButton?.click();

      await waitFor(() => {
        expect(mockRefreshProvider).toHaveBeenCalledWith('openai');
        expect(mockToastError).toHaveBeenCalledWith('Token expired');
      });

      // Logout button now visible because refreshFailed contains 'openai'
      await waitFor(() => {
        const logoutButton = Array.from(container.querySelectorAll('button')).find((btn) =>
          btn.textContent?.includes('Logout')
        );
        expect(logoutButton).toBeDefined();
      });
    });
  });

  describe('OAuth Modal', () => {
    it('should show OAuthModal when oauthFlow state is set', async () => {
      const mockProviders = [createMockProvider('openai', 'OpenAI', { isAuthenticated: false })];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLoginProvider.mockResolvedValue({
        success: true,
        authUrl: 'https://example.com/oauth',
      } as ProviderAuthResponse);

      const { container, getByTestId } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('OpenAI');
      });

      const loginButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Login')
      );
      loginButton?.click();

      await waitFor(() => {
        expect(getByTestId('oauth-modal')).toBeTruthy();
      });
    });

    it('should hide OAuthModal when cancel clicked', async () => {
      const mockProviders = [createMockProvider('openai', 'OpenAI', { isAuthenticated: false })];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLoginProvider.mockResolvedValue({
        success: true,
        authUrl: 'https://example.com/oauth',
      } as ProviderAuthResponse);

      const { container, getByTestId, queryByTestId } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('OpenAI');
      });

      const loginButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Login')
      );
      loginButton?.click();

      await waitFor(() => {
        expect(getByTestId('oauth-modal')).toBeTruthy();
      });

      // Click cancel
      getByTestId('oauth-cancel-btn').click();

      await waitFor(() => {
        expect(queryByTestId('oauth-modal')).toBeNull();
      });
    });

    it('should hide OAuthModal when complete clicked', async () => {
      const mockProviders = [createMockProvider('openai', 'OpenAI', { isAuthenticated: false })];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLoginProvider.mockResolvedValue({
        success: true,
        authUrl: 'https://example.com/oauth',
      } as ProviderAuthResponse);

      const { container, getByTestId, queryByTestId } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('OpenAI');
      });

      const loginButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Login')
      );
      loginButton?.click();

      await waitFor(() => {
        expect(getByTestId('oauth-modal')).toBeTruthy();
      });

      // Click complete
      getByTestId('oauth-complete-btn').click();

      await waitFor(() => {
        expect(queryByTestId('oauth-modal')).toBeNull();
      });
    });

    it('should refresh provider list when OAuth cancelled', async () => {
      const mockProviders = [createMockProvider('openai', 'OpenAI', { isAuthenticated: false })];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLoginProvider.mockResolvedValue({
        success: true,
        authUrl: 'https://example.com/oauth',
      } as ProviderAuthResponse);

      const { container, getByTestId } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(mockListProviderAuthStatus).toHaveBeenCalledTimes(1);
      });

      const loginButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Login')
      );
      loginButton?.click();

      await waitFor(() => {
        expect(getByTestId('oauth-modal')).toBeTruthy();
      });

      // Click cancel
      getByTestId('oauth-cancel-btn').click();

      await waitFor(() => {
        expect(mockListProviderAuthStatus).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Polling for Auth Completion', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should poll for auth completion when OAuth flow is active', async () => {
      const mockProviders = [createMockProvider('openai', 'OpenAI', { isAuthenticated: false })];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLoginProvider.mockResolvedValue({
        success: true,
        authUrl: 'https://example.com/oauth',
      } as ProviderAuthResponse);

      const { container, getByTestId, queryByTestId } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('OpenAI');
      });

      const loginButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Login')
      );
      loginButton?.click();

      await waitFor(() => {
        expect(getByTestId('oauth-modal')).toBeTruthy();
      });

      // Clear previous calls
      mockListProviderAuthStatus.mockClear();

      // Simulate auth completed after polling
      mockListProviderAuthStatus.mockResolvedValue({
        providers: [
          createMockProvider('openai', 'OpenAI', { isAuthenticated: true, method: 'oauth' }),
        ],
      });

      // Advance timers to trigger polling (2 second interval)
      await vi.advanceTimersByTimeAsync(2000);

      await waitFor(() => {
        // Should have polled
        expect(mockListProviderAuthStatus).toHaveBeenCalled();
      });

      await waitFor(() => {
        // Modal should be closed after auth completion
        expect(queryByTestId('oauth-modal')).toBeNull();
      });

      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith('OpenAI authenticated successfully');
      });
    });

    it('should continue polling if auth not yet completed', async () => {
      vi.useRealTimers(); // Use real timers for this test

      try {
        const mockProviders = [createMockProvider('openai', 'OpenAI', { isAuthenticated: false })];
        mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
        mockLoginProvider.mockResolvedValue({
          success: true,
          authUrl: 'https://example.com/oauth',
        } as ProviderAuthResponse);

        const { container, getByTestId } = render(<ProvidersSettings />);

        await waitFor(() => {
          expect(container.textContent).toContain('OpenAI');
        });

        const loginButton = Array.from(container.querySelectorAll('button')).find((btn) =>
          btn.textContent?.includes('Login')
        );
        loginButton?.click();

        await waitFor(() => {
          expect(getByTestId('oauth-modal')).toBeTruthy();
        });

        // Clear previous calls
        mockListProviderAuthStatus.mockClear();

        // First poll - still not authenticated
        mockListProviderAuthStatus.mockResolvedValueOnce({
          providers: [createMockProvider('openai', 'OpenAI', { isAuthenticated: false })],
        });

        // Wait for polling to occur (2 second interval + buffer)
        await vi.waitFor(
          () => {
            expect(mockListProviderAuthStatus).toHaveBeenCalled();
          },
          { timeout: 4000 }
        );

        // Modal should still be visible since not authenticated
        expect(getByTestId('oauth-modal')).toBeTruthy();
      } finally {
        vi.useFakeTimers(); // Restore fake timers for other tests
      }
    });

    it('should stop polling when OAuth modal is closed', async () => {
      const mockProviders = [createMockProvider('openai', 'OpenAI', { isAuthenticated: false })];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLoginProvider.mockResolvedValue({
        success: true,
        authUrl: 'https://example.com/oauth',
      } as ProviderAuthResponse);

      const { container, getByTestId, queryByTestId } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('OpenAI');
      });

      const loginButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Login')
      );
      loginButton?.click();

      await waitFor(() => {
        expect(getByTestId('oauth-modal')).toBeTruthy();
      });

      // Click cancel to close modal
      getByTestId('oauth-cancel-btn').click();

      await waitFor(() => {
        expect(queryByTestId('oauth-modal')).toBeNull();
      });

      // Clear previous calls
      mockListProviderAuthStatus.mockClear();

      // Advance timers - should not poll anymore
      await vi.advanceTimersByTimeAsync(5000);

      // Should not have polled since modal is closed
      expect(mockListProviderAuthStatus).not.toHaveBeenCalled();
    });

    it('should handle polling errors gracefully', async () => {
      const mockProviders = [createMockProvider('openai', 'OpenAI', { isAuthenticated: false })];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLoginProvider.mockResolvedValue({
        success: true,
        authUrl: 'https://example.com/oauth',
      } as ProviderAuthResponse);

      const { container, getByTestId } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('OpenAI');
      });

      const loginButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Login')
      );
      loginButton?.click();

      await waitFor(() => {
        expect(getByTestId('oauth-modal')).toBeTruthy();
      });

      // Clear previous calls
      mockListProviderAuthStatus.mockClear();

      // Poll throws an error
      mockListProviderAuthStatus.mockRejectedValueOnce(new Error('Network error'));

      // Advance timers to trigger poll
      await vi.advanceTimersByTimeAsync(2000);

      // Should not show error toast - polling errors are silent
      expect(mockToastError).not.toHaveBeenCalled();

      // Modal should still be visible - polling continues
      expect(getByTestId('oauth-modal')).toBeTruthy();
    });
  });

  describe('API Error Handling', () => {
    it('should show error toast when listProviderAuthStatus fails', async () => {
      mockListProviderAuthStatus.mockRejectedValue(new Error('Failed to load'));

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Failed to load provider statuses');
      });

      // Should show empty state after error
      await waitFor(() => {
        expect(container.textContent).toContain('No providers available');
      });
    });

    it('should clear loading state even when API fails', async () => {
      mockListProviderAuthStatus.mockRejectedValue(new Error('Failed to load'));

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).not.toContain('Loading providers...');
      });
    });
  });

  describe('Needs Refresh Badge', () => {
    it('should show "Refresh Needed" badge when needsRefresh is true', async () => {
      const mockProviders = [
        createMockProvider('anthropic', 'Anthropic', {
          isAuthenticated: true,
          method: 'oauth',
          needsRefresh: true,
        }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('Refresh Needed');
      });
    });

    it('should not show "Refresh Needed" badge when needsRefresh is false', async () => {
      const mockProviders = [
        createMockProvider('anthropic', 'Anthropic', {
          isAuthenticated: true,
          method: 'oauth',
          needsRefresh: false,
        }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('Anthropic');
      });

      expect(container.textContent).not.toContain('Refresh Needed');
    });
  });

  describe('Provider Error Display', () => {
    it('should show provider error message when present', async () => {
      const mockProviders = [
        createMockProvider('anthropic', 'Anthropic', {
          isAuthenticated: false,
          error: 'API key invalid',
        }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('API key invalid');
      });
    });

    it('should show expiration date for authenticated providers', async () => {
      const expiresAt = Date.now() + 3600000; // 1 hour from now
      const mockProviders = [
        createMockProvider('anthropic', 'Anthropic', {
          isAuthenticated: true,
          method: 'oauth',
          expiresAt,
        }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('Expires:');
      });
    });
  });

  describe('Button States', () => {
    it('should disable buttons for other providers when one is pending', async () => {
      const mockProviders = [
        createMockProvider('anthropic', 'Anthropic', { isAuthenticated: false }),
        createMockProvider('openai', 'OpenAI', { isAuthenticated: false }),
      ];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });

      // Slow down login to test pending state
      let resolveLogin: (value: ProviderAuthResponse) => void;
      mockLoginProvider.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveLogin = resolve;
          })
      );

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('Anthropic');
        expect(container.textContent).toContain('OpenAI');
      });

      // Click Login for Anthropic
      const loginButtons = Array.from(container.querySelectorAll('button')).filter((btn) =>
        btn.textContent?.includes('Login')
      );
      loginButtons[0]?.click();

      await waitFor(() => {
        // All buttons should be disabled
        const allButtons = container.querySelectorAll('button');
        allButtons.forEach((btn) => {
          expect(btn.hasAttribute('disabled')).toBe(true);
        });
      });

      // Resolve the login
      resolveLogin!({ success: true, authUrl: 'https://example.com/oauth' });

      await waitFor(() => {
        // Buttons should be enabled again
        const allButtons = container.querySelectorAll('button');
        const enabledButtons = Array.from(allButtons).filter(
          (btn) => !btn.hasAttribute('disabled')
        );
        expect(enabledButtons.length).toBeGreaterThan(0);
      });
    });

    it('should show loading state on login button when pending', async () => {
      const mockProviders = [createMockProvider('openai', 'OpenAI', { isAuthenticated: false })];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });

      // Slow down login
      let resolveLogin: (value: ProviderAuthResponse) => void;
      mockLoginProvider.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveLogin = resolve;
          })
      );

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('OpenAI');
      });

      const loginButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Login')
      );
      loginButton?.click();

      await waitFor(() => {
        expect(container.querySelector('[data-testid="button-loading"]')).toBeTruthy();
      });

      // Resolve the login
      resolveLogin!({ success: true, authUrl: 'https://example.com/oauth' });
    });
  });

  describe('window.open for OAuth', () => {
    it('should open auth URL in new tab when authUrl is provided', async () => {
      const mockOpen = vi.fn();
      vi.stubGlobal('open', mockOpen);

      const mockProviders = [createMockProvider('openai', 'OpenAI', { isAuthenticated: false })];
      mockListProviderAuthStatus.mockResolvedValue({ providers: mockProviders });
      mockLoginProvider.mockResolvedValue({
        success: true,
        authUrl: 'https://example.com/oauth',
      } as ProviderAuthResponse);

      const { container } = render(<ProvidersSettings />);

      await waitFor(() => {
        expect(container.textContent).toContain('OpenAI');
      });

      const loginButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Login')
      );
      loginButton?.click();

      await waitFor(() => {
        expect(mockOpen).toHaveBeenCalledWith('https://example.com/oauth', '_blank');
      });

      vi.unstubAllGlobals();
    });
  });
});
