import { useEffect, useState } from 'preact/hooks';
import { toast } from '../../lib/toast.ts';
import type { ProviderAuthStatus, ProviderAuthResponse } from '@neokai/shared/provider';
import {
  listProviderAuthStatus,
  loginProvider,
  logoutProvider,
  refreshProvider,
} from '../../lib/api-helpers.ts';
import { SettingsSection } from './SettingsSection.tsx';
import { OAuthModal } from './OAuthModal.tsx';
import { Button } from '../ui/Button.tsx';

interface OAuthFlowState {
  providerId: string;
  providerName: string;
  authUrl?: string;
  userCode?: string;
  verificationUri?: string;
}

export function ProvidersSettings() {
  const [providers, setProviders] = useState<ProviderAuthStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [oauthFlow, setOauthFlow] = useState<OAuthFlowState | null>(null);
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState<Set<string>>(new Set());

  // Load provider auth statuses
  const loadProviders = async () => {
    try {
      const response = await listProviderAuthStatus();
      setProviders(response.providers);
    } catch {
      toast.error('Failed to load provider statuses');
      // Failed to load providers
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProviders();
  }, []);

  // Poll for auth completion when OAuth flow is active
  useEffect(() => {
    if (!oauthFlow) return;

    const pollInterval = setInterval(async () => {
      try {
        const response = await listProviderAuthStatus();
        const provider = response.providers.find((p) => p.id === oauthFlow.providerId);

        if (provider?.isAuthenticated) {
          // Auth completed successfully
          setOauthFlow(null);
          setProviders(response.providers);
          toast.success(`${oauthFlow.providerName} authenticated successfully`);
        }
      } catch {
        // Polling error - will retry
      }
    }, 2000);

    return () => clearInterval(pollInterval);
  }, [oauthFlow]);

  const handleLogin = async (providerId: string, providerName: string) => {
    setPendingProvider(providerId);

    try {
      const response: ProviderAuthResponse = await loginProvider(providerId);

      if (!response.success) {
        toast.error(response.error || 'Failed to start OAuth flow');
        return;
      }

      // Open auth URL in new tab if provided
      if (response.authUrl) {
        window.open(response.authUrl, '_blank');
      }

      // Show OAuth modal with instructions
      setOauthFlow({
        providerId,
        providerName,
        authUrl: response.authUrl,
        userCode: response.userCode,
        verificationUri: response.verificationUri,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start login');
    } finally {
      setPendingProvider(null);
    }
  };

  const handleLogout = async (providerId: string, providerName: string) => {
    setPendingProvider(providerId);
    try {
      const response = await logoutProvider(providerId);
      if (!response.success) {
        toast.error(response.error || `Failed to logout from ${providerName}`);
        return;
      }
      toast.success(`Logged out from ${providerName}`);
      // Clear refresh failure state for this provider
      setRefreshFailed((prev) => {
        const next = new Set(prev);
        next.delete(providerId);
        return next;
      });
      // Refresh provider list
      await loadProviders();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to logout');
    } finally {
      setPendingProvider(null);
    }
  };

  const handleRefresh = async (providerId: string, providerName: string) => {
    setPendingProvider(providerId);
    try {
      const response = await refreshProvider(providerId);
      if (response.success) {
        toast.success(`Token refreshed for ${providerName}`);
        setRefreshFailed((prev) => {
          const next = new Set(prev);
          next.delete(providerId);
          return next;
        });
        await loadProviders();
      } else {
        toast.error(response.error || 'Failed to refresh token');
        setRefreshFailed((prev) => new Set(prev).add(providerId));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to refresh token');
      setRefreshFailed((prev) => new Set(prev).add(providerId));
    } finally {
      setPendingProvider(null);
    }
  };

  const handleOAuthCancel = () => {
    setOauthFlow(null);
    // Refresh to get current state
    loadProviders();
  };

  const handleOAuthComplete = () => {
    setOauthFlow(null);
    loadProviders();
  };

  if (loading) {
    return (
      <SettingsSection title="Providers">
        <div class="text-gray-400 text-sm">Loading providers...</div>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection title="Providers">
        <div class="space-y-4">
          <p class="text-sm text-gray-400 mb-4">
            Configure authentication for AI providers. Each provider may use OAuth or API keys.
          </p>

          {providers.length === 0 && (
            <div class="text-gray-500 text-sm">No providers available</div>
          )}
          {providers.length > 0 && (
            <div class="space-y-3">
              {providers.map((provider) => (
                <div
                  key={provider.id}
                  class="flex items-center justify-between p-3 bg-dark-800 rounded-lg border border-dark-700"
                >
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="text-sm font-medium text-gray-200">{provider.displayName}</span>
                      {provider.isAuthenticated && (
                        <span class="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full bg-green-900/50 text-green-400">
                          {provider.method === 'api_key' ? 'API Key' : 'OAuth'}
                        </span>
                      )}
                      {provider.needsRefresh && (
                        <span class="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full bg-yellow-900/50 text-yellow-400">
                          Refresh Needed
                        </span>
                      )}
                    </div>
                    {provider.error && <p class="text-xs text-red-400 mt-1">{provider.error}</p>}
                    {provider.expiresAt && provider.isAuthenticated && (
                      <p class="text-xs text-gray-500 mt-1">
                        Expires: {new Date(provider.expiresAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <div class="flex-shrink-0 ml-4 flex items-center gap-2">
                    {provider.needsRefresh && (
                      <Button
                        variant="warning"
                        size="sm"
                        onClick={() => handleRefresh(provider.id, provider.displayName)}
                        loading={pendingProvider === provider.id}
                        disabled={!!pendingProvider}
                      >
                        Refresh Login
                      </Button>
                    )}
                    {/* Show Logout for authenticated providers */}
                    {(provider.isAuthenticated ||
                      (provider.needsRefresh && refreshFailed.has(provider.id))) && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleLogout(provider.id, provider.displayName)}
                        loading={pendingProvider === provider.id}
                        disabled={!!pendingProvider}
                      >
                        Logout
                      </Button>
                    )}
                    {/* Show Login for unauthenticated providers */}
                    {!provider.isAuthenticated && !provider.needsRefresh && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => handleLogin(provider.id, provider.displayName)}
                        loading={pendingProvider === provider.id}
                        disabled={!!pendingProvider}
                      >
                        Login
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingsSection>

      {/* OAuth Modal */}
      {oauthFlow && (
        <OAuthModal
          providerName={oauthFlow.providerName}
          authUrl={oauthFlow.authUrl}
          userCode={oauthFlow.userCode}
          verificationUri={oauthFlow.verificationUri}
          onCancel={handleOAuthCancel}
          onComplete={handleOAuthComplete}
        />
      )}
    </>
  );
}
