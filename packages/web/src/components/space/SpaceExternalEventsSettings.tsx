import { useState, useCallback, useRef, useMemo, useEffect } from 'preact/hooks';
import type {
  ExtensionStatus,
  GitHubWatchedRepo,
  GitHubSpaceConfig,
  GitHubTokenStatus,
} from './space-external-event-types.ts';
import type {
  SpaceExternalEventDeliveryLogRecord,
  ExternalEventDeliveryStatus,
} from '../../lib/space-store.ts';
import { getWebhookUrl, splitRepoInput } from './space-external-event-values.ts';
import { spaceStore } from '../../lib/space-store.ts';
import { toast } from '../../lib/toast.ts';
import { connectionManager } from '../../lib/connection-manager.ts';
import { Spinner } from '../ui/Spinner.tsx';
import { ExtensionCard } from './SpaceExternalEventExtension.tsx';
import { GitHubConnectionCard } from './SpaceExternalEventGitHubConnection.tsx';
import { GitHubHealthPanel } from './GitHubHealthPanel.tsx';
import { SettingsToggle } from '../settings/SettingsSection.tsx';
import { CopyButton } from '../ui/CopyButton.tsx';
import { cn } from '../../lib/utils.ts';
import { FORM_CHECKBOX_CLASS, FORM_CONTROL_CLASS } from '../ui/FormField';
import { Button } from '../ui/Button.tsx';
import { GitHubRepoRow } from './SpaceExternalEventGitHubRepo.tsx';
import { DeliveryLogSection } from './SpaceExternalEventDeliveryLog.tsx';
import { QueueHealthSummary } from './QueueHealthSummary.tsx';

interface SpaceExternalEventsSettingsProps {
  spaceId: string;
  disabled?: boolean;
}

export function SpaceExternalEventsSettings({
  spaceId,
  disabled = false,
}: SpaceExternalEventsSettingsProps) {
  const [extensions, setExtensions] = useState<ExtensionStatus[]>([]);
  const [repos, setRepos] = useState<GitHubWatchedRepo[]>([]);
  const [spaceConfig, setSpaceConfig] = useState<GitHubSpaceConfig | null>(null);
  const [tokenStatus, setTokenStatus] = useState<GitHubTokenStatus | null>(null);
  const [tokenStatusError, setTokenStatusError] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [deliveryLoading, setDeliveryLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [panelBusy, setPanelBusy] = useState(false);
  const handlePanelBusyChange = useCallback((panelActionBusy: 'poll' | 'reregister' | null) => {
    setPanelBusy(panelActionBusy !== null);
  }, []);
  const [healthNonce, setHealthNonce] = useState(0);
  const [repoInput, setRepoInput] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<SpaceExternalEventDeliveryLogRecord[]>([]);
  const [deliveryStatus, setDeliveryStatus] = useState<ExternalEventDeliveryStatus | ''>('');
  const [deliveryAgent, setDeliveryAgent] = useState('');
  const [selectedDelivery, setSelectedDelivery] =
    useState<SpaceExternalEventDeliveryLogRecord | null>(null);
  const refreshTokenRef = useRef(0);
  const deliveryRefreshTokenRef = useRef(0);
  const spaceIdRef = useRef(spaceId);
  spaceIdRef.current = spaceId;

  const githubExtension = extensions.find((extension) => extension.source === 'github');
  const githubGloballyEnabled = githubExtension?.config.globallyEnabled ?? false;
  const githubRpcConfigEnabled = githubExtension?.config.capabilities.rpcConfig ?? false;
  const githubPollingEnabled = githubExtension?.config.capabilities.polling === true;
  const githubWebhooksEnabled = githubExtension?.config.capabilities.webhooks !== false;
  const githubControlsEnabled = githubGloballyEnabled && githubRpcConfigEnabled;
  const githubSpaceEnabled = spaceConfig?.enabled ?? true;
  const spacePollingIntent =
    (spaceConfig?.settings as { pollingIntent?: boolean } | undefined)?.pollingIntent === true;
  const spaceFilterCurrentUser =
    (spaceConfig?.settings as { filterCurrentUser?: boolean } | undefined)?.filterCurrentUser !==
    false;
  const spacePollingActive = githubPollingEnabled && spacePollingIntent;
  const webhookUrl = useMemo(getWebhookUrl, []);

  async function refreshDeliveries(): Promise<void> {
    const refreshToken = refreshTokenRef.current;
    const deliveryRefreshToken = deliveryRefreshTokenRef.current + 1;
    deliveryRefreshTokenRef.current = deliveryRefreshToken;
    const refreshSpaceId = spaceIdRef.current;
    const statusFilter = deliveryStatus;
    const agentFilter = deliveryAgent.trim() || undefined;
    const isCurrentRefresh = () =>
      refreshTokenRef.current === refreshToken &&
      deliveryRefreshTokenRef.current === deliveryRefreshToken &&
      refreshSpaceId === spaceIdRef.current;
    try {
      setDeliveryLoading(true);
      const rows = await spaceStore.listExternalEventDeliveries({
        spaceId: refreshSpaceId,
        status: statusFilter,
        agentName: agentFilter,
      });
      if (!isCurrentRefresh()) return;
      setDeliveries(rows);
      setSelectedDelivery((current) => {
        if (!current) return null;
        return rows.find((row) => row.deliveryKey === current.deliveryKey) ?? null;
      });
    } catch (err) {
      if (!isCurrentRefresh()) return;
      setDeliveries([]);
      setSelectedDelivery(null);
      toast.error(
        `Failed to load event deliveries: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      if (isCurrentRefresh()) setDeliveryLoading(false);
    }
  }

  async function refresh({
    bumpHealthNonce = true,
  }: {
    bumpHealthNonce?: boolean;
  } = {}): Promise<void> {
    const refreshToken = refreshTokenRef.current + 1;
    refreshTokenRef.current = refreshToken;
    const refreshSpaceId = spaceIdRef.current;
    const isCurrentRefresh = () =>
      refreshTokenRef.current === refreshToken && refreshSpaceId === spaceIdRef.current;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      if (isCurrentRefresh()) {
        setSpaceConfig(null);
        setRepos([]);
        setDeliveries([]);
        setTokenStatus(null);
        setTokenStatusError(null);
        toast.error('Not connected to server');
        setLoading(false);
        setDeliveryLoading(false);
      }
      if (bumpHealthNonce) setHealthNonce((n) => n + 1);
      return;
    }
    try {
      setLoading(true);
      const extensionResult = await hub.request<{ extensions: ExtensionStatus[] }>(
        'externalEvents.extensions.list',
        {}
      );
      if (!isCurrentRefresh()) return;
      setExtensions(extensionResult.extensions);
      await refreshDeliveries();

      const github = extensionResult.extensions.find((extension) => extension.source === 'github');
      if (!github?.config.globallyEnabled || !github.config.capabilities.rpcConfig) {
        setSpaceConfig(null);
        setRepos([]);
        setTokenStatus(null);
        setTokenStatusError(null);
        return;
      }

      const [configResult, repoResult] = await Promise.all([
        hub.request<GitHubSpaceConfig | null>('space.github.listConfig', {
          spaceId: refreshSpaceId,
        }),
        hub.request<{ repositories: GitHubWatchedRepo[] }>('space.github.listWatchedRepos', {
          spaceId: refreshSpaceId,
        }),
      ]);
      if (!isCurrentRefresh()) return;
      setSpaceConfig(configResult);
      setRepos(repoResult.repositories);
      setTokenStatus(null);
      setTokenStatusError(null);
      void (async () => {
        try {
          const tokenResult = await hub.request<GitHubTokenStatus>(
            'space.github.getTokenStatus',
            {}
          );
          if (!isCurrentRefresh()) return;
          setTokenStatus(tokenResult);
          setTokenStatusError(null);
        } catch (err) {
          if (!isCurrentRefresh()) return;
          setTokenStatus(null);
          setTokenStatusError(err instanceof Error ? err.message : String(err));
        }
      })();
    } catch (err) {
      if (!isCurrentRefresh()) return;
      setSpaceConfig(null);
      setRepos([]);
      setDeliveries([]);
      toast.error(
        `Failed to load external event sources: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      if (isCurrentRefresh()) setLoading(false);
      if (bumpHealthNonce) setHealthNonce((n) => n + 1);
    }
  }

  useEffect(() => {
    void refresh({ bumpHealthNonce: false });
  }, [spaceId]);

  useEffect(() => {
    void refreshDeliveries();
  }, [deliveryStatus]);

  function isActionCurrent(actionSpaceId: string): boolean {
    return spaceIdRef.current === actionSpaceId;
  }

  async function setGlobalEnabled(source: string, enabled: boolean): Promise<void> {
    const actionSpaceId = spaceIdRef.current;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    try {
      setBusy(`global:${source}`);
      await hub.request('externalEvents.extensions.setGlobalEnabled', { source, enabled });
      if (!isActionCurrent(actionSpaceId)) return;
      toast.success(`${source} ${enabled ? 'enabled' : 'disabled'} globally`);
      await refresh();
    } catch (err) {
      if (!isActionCurrent(actionSpaceId)) return;
      toast.error(
        `Failed to update ${source}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setBusy(null);
    }
  }

  async function setSpaceEnabled(enabled: boolean): Promise<void> {
    const actionSpaceId = spaceIdRef.current;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    try {
      setBusy('space:github');
      await hub.request(enabled ? 'space.github.enable' : 'space.github.disable', {
        spaceId: actionSpaceId,
      });
      if (!isActionCurrent(actionSpaceId)) return;
      toast.success(`GitHub events ${enabled ? 'enabled' : 'disabled'} for this space`);
      await refresh();
    } catch (err) {
      if (!isActionCurrent(actionSpaceId)) return;
      toast.error(
        `Failed to update GitHub events: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setBusy(null);
    }
  }

  async function saveToken(): Promise<void> {
    const actionSpaceId = spaceIdRef.current;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    const token = tokenInput.trim();
    if (!token) return;
    if (
      tokenStatus?.configured === true &&
      tokenStatus.source === 'keychain' &&
      !window.confirm('Replace the existing daemon-wide GitHub token?')
    ) {
      return;
    }
    if (
      tokenStatus?.configured === true &&
      (tokenStatus.source === 'env' || tokenStatus.source === 'gh') &&
      !window.confirm(
        `The ${tokenStatus.source === 'gh' ? 'authenticated gh CLI' : 'GH_TOKEN / GITHUB_TOKEN env'} is currently in use. Saving a keychain token will shadow it across every space. Continue?`
      )
    ) {
      return;
    }
    try {
      setBusy('github:token');
      await hub.request('space.github.setToken', { token });
      if (!isActionCurrent(actionSpaceId)) return;
      setTokenInput('');
      toast.success('GitHub token saved to keychain');
      await refresh();
    } catch (err) {
      if (!isActionCurrent(actionSpaceId)) return;
      toast.error(
        `Failed to save GitHub token: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setBusy(null);
    }
  }

  async function clearToken(): Promise<void> {
    const actionSpaceId = spaceIdRef.current;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    const autoRegisteredCount = tokenStatus?.autoRegisteredHookCount ?? 0;
    const message =
      autoRegisteredCount > 0
        ? `Remove the daemon-wide GitHub token from the keychain? ${autoRegisteredCount} auto-registered webhook(s) across all spaces may become unmanageable until a token is restored.`
        : 'Remove the daemon-wide GitHub token from the keychain?';
    if (!window.confirm(message)) {
      return;
    }
    try {
      setBusy('github:token');
      await hub.request('space.github.clearToken', {});
      if (!isActionCurrent(actionSpaceId)) return;
      toast.success('GitHub token removed');
      await refresh();
    } catch (err) {
      if (!isActionCurrent(actionSpaceId)) return;
      toast.error(
        `Failed to remove GitHub token: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setBusy(null);
    }
  }

  async function setPollingCapability(enabled: boolean): Promise<void> {
    const actionSpaceId = spaceIdRef.current;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    try {
      setBusy('github:polling');
      await hub.request('space.github.setPollingEnabled', {
        spaceId: actionSpaceId,
        enabled,
      });
      if (!isActionCurrent(actionSpaceId)) return;
      toast.success(`GitHub polling ${enabled ? 'enabled' : 'disabled'} (daemon-wide capability)`);
      await refresh();
    } catch (err) {
      if (!isActionCurrent(actionSpaceId)) return;
      toast.error(
        `Failed to update GitHub polling: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setBusy(null);
    }
  }

  async function setFilterCurrentUser(enabled: boolean): Promise<void> {
    const actionSpaceId = spaceIdRef.current;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    try {
      setBusy('github:self-echo');
      await hub.request('space.github.setFilterCurrentUser', {
        spaceId: actionSpaceId,
        enabled,
      });
      if (!isActionCurrent(actionSpaceId)) return;
      toast.success(
        `Filtering events by current login user ${enabled ? 'enabled' : 'disabled'} for this space`
      );
      await refresh();
    } catch (err) {
      if (!isActionCurrent(actionSpaceId)) return;
      toast.error(
        `Failed to update login filtering: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setBusy(null);
    }
  }

  async function addRepo(event?: Event, autoConfigure = false): Promise<void> {
    event?.preventDefault();
    const actionSpaceId = spaceIdRef.current;
    const parsed = splitRepoInput(repoInput);
    if (!parsed) {
      setFormError('Enter a repository as owner/name or https://github.com/owner/name');
      return;
    }
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    try {
      setBusy(autoConfigure ? 'repo:add:auto' : 'repo:add');
      setFormError(null);
      const secret = webhookSecret.trim();
      if (!secret && !spacePollingActive && !autoConfigure) {
        setFormError('Webhook secret is required because polling is disabled for this space');
        return;
      }
      await hub.request(
        autoConfigure ? 'space.github.autoConfigureWebhook' : 'space.github.watchRepo',
        autoConfigure
          ? {
              spaceId: actionSpaceId,
              owner: parsed.owner,
              repo: parsed.repo,
            }
          : {
              spaceId: actionSpaceId,
              owner: parsed.owner,
              repo: parsed.repo,
              webhookSecret: secret || undefined,
              webhookEnabled: Boolean(secret),
              pollingEnabled: !secret && spacePollingActive,
            }
      );
      if (!isActionCurrent(actionSpaceId)) return;
      setRepoInput('');
      setWebhookSecret('');
      toast.success(
        autoConfigure
          ? `Configured GitHub webhook for ${parsed.owner}/${parsed.repo}`
          : `Watching ${parsed.owner}/${parsed.repo}`
      );
      await refresh();
    } catch (err) {
      if (!isActionCurrent(actionSpaceId)) return;
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function updateRepo(
    repo: GitHubWatchedRepo,
    patch: Partial<GitHubWatchedRepo>
  ): Promise<void> {
    const actionSpaceId = spaceIdRef.current;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    const nextWebhookEnabled = patch.webhookEnabled ?? repo.webhookEnabled;
    const nextPollingEnabled = patch.pollingEnabled ?? repo.pollingEnabled;
    if (nextPollingEnabled && !githubPollingEnabled) {
      toast.error('GitHub polling capability is disabled');
      return;
    }
    if (!nextPollingEnabled && (!nextWebhookEnabled || !repo.webhookSecret)) {
      toast.error('Repository watch needs webhooks with a secret or polling enabled');
      return;
    }
    try {
      setBusy(`repo:${repo.id}`);
      await hub.request('space.github.watchRepo', {
        spaceId: actionSpaceId,
        owner: repo.owner,
        repo: repo.repo,
        enabled: patch.enabled ?? repo.enabled,
        webhookEnabled: nextWebhookEnabled,
        pollingEnabled: nextPollingEnabled,
      });
      if (!isActionCurrent(actionSpaceId)) return;
      await refresh();
    } catch (err) {
      if (!isActionCurrent(actionSpaceId)) return;
      toast.error(
        `Failed to update ${repo.owner}/${repo.repo}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setBusy(null);
    }
  }

  async function autoConfigureWebhook(repo: GitHubWatchedRepo): Promise<void> {
    const actionSpaceId = spaceIdRef.current;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    try {
      setBusy(`webhook:${repo.id}`);
      await hub.request('space.github.autoConfigureWebhook', {
        spaceId: actionSpaceId,
        owner: repo.owner,
        repo: repo.repo,
      });
      if (!isActionCurrent(actionSpaceId)) return;
      toast.success(`Configured GitHub webhook for ${repo.owner}/${repo.repo}`);
      await refresh();
    } catch (err) {
      if (!isActionCurrent(actionSpaceId)) return;
      toast.error(
        `Failed to configure webhook for ${repo.owner}/${repo.repo}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setBusy(null);
    }
  }

  async function checkWebhook(repo: GitHubWatchedRepo): Promise<void> {
    const actionSpaceId = spaceIdRef.current;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    try {
      setBusy(`webhook:${repo.id}`);
      const result = await hub.request<{ watchedRepo?: GitHubWatchedRepo }>(
        'space.github.checkWebhook',
        {
          spaceId: actionSpaceId,
          owner: repo.owner,
          repo: repo.repo,
        }
      );
      if (!isActionCurrent(actionSpaceId)) return;
      if (result.watchedRepo?.webhookActive === false) {
        toast.error(
          result.watchedRepo.webhookLastError
            ? `GitHub webhook is inactive for ${repo.owner}/${repo.repo}: ${result.watchedRepo.webhookLastError}`
            : `GitHub webhook is inactive for ${repo.owner}/${repo.repo}`
        );
      } else if (result.watchedRepo?.webhookLastError?.includes('uncertain')) {
        toast.error(
          `GitHub webhook is active but uncertain for ${repo.owner}/${repo.repo}: ${result.watchedRepo.webhookLastError}`
        );
      } else {
        toast.success(`GitHub webhook is active for ${repo.owner}/${repo.repo}`);
      }
      await refresh();
    } catch (err) {
      if (!isActionCurrent(actionSpaceId)) return;
      toast.error(
        `Failed to check webhook for ${repo.owner}/${repo.repo}: ${err instanceof Error ? err.message : String(err)}`
      );
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function removeRepo(repo: GitHubWatchedRepo): Promise<void> {
    const actionSpaceId = spaceIdRef.current;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    try {
      setBusy(`repo:${repo.id}`);
      await hub.request('space.github.unwatchRepo', {
        spaceId: actionSpaceId,
        owner: repo.owner,
        repo: repo.repo,
      });
      if (!isActionCurrent(actionSpaceId)) return;
      toast.success(`Stopped watching ${repo.owner}/${repo.repo}`);
      await refresh();
    } catch (err) {
      if (!isActionCurrent(actionSpaceId)) return;
      toast.error(
        `Failed to remove ${repo.owner}/${repo.repo}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section class="space-y-4" data-testid="space-external-events-settings">
      {loading ? (
        <div class="flex items-center gap-2 py-2 text-xs text-fg-muted">
          <Spinner size="sm" />
          Loading external event sources…
        </div>
      ) : (
        <div class="space-y-4">
          <div class="st-sec-head">
            <div class="min-w-0">
              <h3 class="st-sec-title">Extensions</h3>
              <p class="st-sec-desc">
                External event sources registered on the daemon. The switch turns a source on or off
                daemon-wide — spaces only receive events from enabled sources.
              </p>
            </div>
          </div>
          <div class="st-group">
            {extensions.length === 0 ? (
              <div class="st-empty">
                <p class="st-empty-title">No external event extensions registered.</p>
              </div>
            ) : (
              extensions.map((extension) => (
                <ExtensionCard
                  key={extension.source}
                  extension={extension}
                  disabled={
                    disabled ||
                    busy === `global:${extension.source}` ||
                    (panelBusy && extension.source === 'github')
                  }
                  onToggle={(enabled) => setGlobalEnabled(extension.source, enabled)}
                />
              ))
            )}
          </div>

          {githubControlsEnabled && (
            <div class="st-sec-head">
              <div class="min-w-0">
                <h3 class="st-sec-title">GitHub connection</h3>
                <p class="st-sec-desc">
                  Daemon-wide token and delivery settings for the GitHub extension.
                </p>
              </div>
            </div>
          )}
          {githubControlsEnabled && (
            <GitHubConnectionCard
              tokenStatus={tokenStatus}
              tokenStatusError={tokenStatusError}
              tokenStatusUnknown={!tokenStatus && !tokenStatusError}
              tokenInput={tokenInput}
              onTokenInputChange={setTokenInput}
              busy={busy === 'github:token' || busy === 'github:polling'}
              disabled={disabled || panelBusy}
              pollingEnabled={spacePollingActive}
              pollingCapabilityDisabled={!githubPollingEnabled}
              onSaveToken={saveToken}
              onClearToken={clearToken}
              onTogglePolling={setPollingCapability}
            />
          )}

          {githubControlsEnabled && (
            <GitHubHealthPanel
              spaceId={spaceId}
              pollingCapabilityEnabled={githubPollingEnabled}
              webhooksCapabilityEnabled={githubWebhooksEnabled}
              disabled={disabled || busy !== null || !githubSpaceEnabled}
              refreshNonce={healthNonce}
              onAfterAction={refresh}
              onBusyChange={handlePanelBusyChange}
            />
          )}

          <div class="st-sec-head">
            <div class="min-w-0">
              <h3 class="st-sec-title">GitHub repositories</h3>
              <p class="st-sec-desc">Watch pull request and review activity for this space.</p>
            </div>
          </div>
          <div class="st-group">
            <div class="st-row">
              <div class="st-row-label">Enabled for this space</div>
              <SettingsToggle
                checked={githubSpaceEnabled}
                disabled={
                  disabled || !githubControlsEnabled || busy === 'space:github' || panelBusy
                }
                onChange={(next) => setSpaceEnabled(next)}
                data-testid="github-space-enabled-toggle"
              />
            </div>

            <div class="st-row">
              <div class="st-row-label">
                Webhook endpoint
                <div class="st-row-desc">
                  Use a public HTTPS tunnel for local development. Configure GitHub webhooks for
                  pull_request, issue_comment, pull_request_review, pull_request_review_comment,
                  pull_request_review_thread, check_run, and check_suite events.
                </div>
              </div>
              <div class="st-row-ctl flex min-w-0 items-center gap-2">
                <code class="min-w-0 truncate text-xs text-fg-soft">{webhookUrl}</code>
                <CopyButton text={webhookUrl} label="Copy webhook URL" />
              </div>
            </div>

            <div class="st-row">
              <label
                class={cn(
                  'st-row-label flex items-center gap-2 text-xs',
                  (disabled ||
                    !githubControlsEnabled ||
                    busy === 'github:self-echo' ||
                    panelBusy) &&
                    'opacity-60'
                )}
              >
                <input
                  type="checkbox"
                  checked={spaceFilterCurrentUser}
                  disabled={
                    disabled || !githubControlsEnabled || busy === 'github:self-echo' || panelBusy
                  }
                  onChange={() => setFilterCurrentUser(!spaceFilterCurrentUser)}
                  class={FORM_CHECKBOX_CLASS}
                />
                Filter events by current login user
              </label>
              {tokenStatus?.login && (
                <span class="text-xs text-fg-muted">current login: {tokenStatus.login}</span>
              )}
            </div>

            <form
              onSubmit={(event) => addRepo(event)}
              class="st-addrow grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]"
            >
              <input
                type="text"
                value={repoInput}
                onInput={(event) => setRepoInput((event.target as HTMLInputElement).value)}
                placeholder="owner/repository"
                disabled={disabled || !githubControlsEnabled || panelBusy}
                class={FORM_CONTROL_CLASS}
              />
              <input
                type="password"
                value={webhookSecret}
                onInput={(event) => setWebhookSecret((event.target as HTMLInputElement).value)}
                placeholder="Webhook secret (optional)"
                disabled={disabled || !githubControlsEnabled || panelBusy}
                class={FORM_CONTROL_CLASS}
              />
              <Button
                type="submit"
                size="sm"
                loading={busy === 'repo:add'}
                disabled={disabled || !githubControlsEnabled || busy === 'repo:add' || panelBusy}
              >
                Add watch
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                loading={busy === 'repo:add:auto'}
                disabled={
                  disabled ||
                  !githubControlsEnabled ||
                  !githubWebhooksEnabled ||
                  busy === 'repo:add:auto' ||
                  panelBusy
                }
                onClick={() => addRepo(undefined, true)}
              >
                Auto-configure
              </Button>
              {formError && <p class="mt-2 text-xs text-danger-soft">{formError}</p>}
            </form>

            {repos.length === 0 ? (
              <div class="st-trow">
                <span class="st-trow-desc">No repositories watched yet.</span>
              </div>
            ) : (
              repos.map((repo) => (
                <GitHubRepoRow
                  key={repo.id}
                  repo={repo}
                  disabled={
                    disabled ||
                    busy === `repo:${repo.id}` ||
                    busy === `webhook:${repo.id}` ||
                    !githubControlsEnabled ||
                    panelBusy
                  }
                  webhookBusy={busy === `webhook:${repo.id}`}
                  webhooksEnabled={githubWebhooksEnabled}
                  pollingEnabled={githubPollingEnabled}
                  onUpdate={(patch) => updateRepo(repo, patch)}
                  onAutoConfigureWebhook={() => autoConfigureWebhook(repo)}
                  onCheckWebhook={() => checkWebhook(repo)}
                  onRemove={() => removeRepo(repo)}
                />
              ))
            )}
          </div>

          <DeliveryLogSection
            deliveries={deliveries}
            loading={deliveryLoading}
            status={deliveryStatus}
            agentFilter={deliveryAgent}
            selectedDelivery={selectedDelivery}
            onStatusChange={setDeliveryStatus}
            onAgentFilterChange={setDeliveryAgent}
            onApplyAgentFilter={refreshDeliveries}
            onRefresh={refreshDeliveries}
            onSelect={setSelectedDelivery}
          />

          <QueueHealthSummary />
        </div>
      )}
    </section>
  );
}
