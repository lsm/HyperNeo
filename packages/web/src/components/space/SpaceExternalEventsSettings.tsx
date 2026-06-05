/**
 * SpaceExternalEventsSettings — external event source configuration for a Space.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager.ts';
import {
  spaceStore,
  type ExternalEventDeliveryStatus,
  type SpaceExternalEventDeliveryLogRecord,
} from '../../lib/space-store.ts';
import { toast } from '../../lib/toast.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/Button.tsx';
import { CopyButton } from '../ui/CopyButton.tsx';
import { Spinner } from '../ui/Spinner.tsx';

interface SpaceExternalEventsSettingsProps {
  spaceId: string;
  disabled?: boolean;
}

interface ExtensionConfig {
  source: string;
  globallyEnabled: boolean;
  capabilities: {
    webhooks?: boolean;
    polling?: boolean;
    rpcConfig?: boolean;
  };
  settings?: Record<string, unknown>;
}

interface ExtensionStatus {
  source: string;
  status: 'started' | 'stopped';
  config: ExtensionConfig;
}

interface GitHubWatchedRepo {
  id: string;
  owner: string;
  repo: string;
  enabled: boolean;
  webhookEnabled: boolean;
  pollingEnabled: boolean;
  webhookSecret: 'configured' | null;
  webhookRemoteId: number | null;
  webhookUrl: string | null;
  webhookAutoRegistered: boolean;
  webhookActive: boolean | null;
  webhookLastCheckedAt: number | null;
  webhookLastError: string | null;
  webhookConfiguredAt: number | null;
  lastWebhookAt: number | null;
  lastPollAt: number | null;
}

interface GitHubSpaceConfig {
  spaceId: string;
  source: 'github';
  enabled: boolean;
  settings: Record<string, unknown>;
}

const WEBHOOK_PATH = '/webhook/github/space';
const DELIVERY_STATUSES: Array<ExternalEventDeliveryStatus | ''> = [
  '',
  'pending',
  'delivered',
  'failed',
];

function getWebhookUrl(): string {
  if (typeof window === 'undefined') return WEBHOOK_PATH;
  return new URL(WEBHOOK_PATH, window.location.origin).toString();
}

function formatCapabilities(capabilities: ExtensionConfig['capabilities']): string[] {
  return [
    capabilities.webhooks !== false ? 'webhooks' : null,
    capabilities.polling ? 'polling' : null,
    capabilities.rpcConfig ? 'RPC config' : null,
  ].filter(Boolean) as string[];
}

function formatTimestamp(value: number | null): string {
  if (!value) return 'never';
  return new Date(value).toLocaleString();
}

function formatJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '{}';
  }
}

function splitRepoInput(value: string): { owner: string; repo: string } | null {
  const trimmed = value.trim().replace(/^https:\/\/github\.com\//, '');
  const [owner, repo] = trimmed.split('/');
  if (!owner || !repo) return null;
  return { owner, repo: repo.replace(/\.git$/, '') };
}

export function SpaceExternalEventsSettings({
  spaceId,
  disabled = false,
}: SpaceExternalEventsSettingsProps) {
  const [extensions, setExtensions] = useState<ExtensionStatus[]>([]);
  const [repos, setRepos] = useState<GitHubWatchedRepo[]>([]);
  const [spaceConfig, setSpaceConfig] = useState<GitHubSpaceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [deliveryLoading, setDeliveryLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
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

  async function refresh(): Promise<void> {
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
        toast.error('Not connected to server');
        setLoading(false);
        setDeliveryLoading(false);
      }
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
    }
  }

  useEffect(() => {
    void refresh();
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
      if (!secret && !githubPollingEnabled && !autoConfigure) {
        setFormError('Webhook secret is required because polling is disabled for GitHub');
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
              pollingEnabled: !secret,
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
        toast.error(`GitHub webhook is inactive for ${repo.owner}/${repo.repo}`);
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
      <div>
        <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          External event sources
        </h3>
        <p class="mt-1 text-xs text-gray-400">
          Enable source extensions globally, then choose which repositories can trigger work in this
          space.
        </p>
      </div>

      {loading ? (
        <div class="flex items-center gap-2 py-2 text-xs text-gray-400">
          <Spinner size="sm" />
          Loading external event sources…
        </div>
      ) : (
        <div class="space-y-4">
          <div class="space-y-2">
            {extensions.length === 0 ? (
              <div class="rounded-lg border border-dark-700 bg-dark-800 px-3 py-3 text-sm text-gray-400">
                No external event extensions registered.
              </div>
            ) : (
              extensions.map((extension) => (
                <ExtensionCard
                  key={extension.source}
                  extension={extension}
                  disabled={disabled || busy === `global:${extension.source}`}
                  onToggle={(enabled) => setGlobalEnabled(extension.source, enabled)}
                />
              ))
            )}
          </div>

          <div class="rounded-lg border border-dark-700 bg-dark-800 px-3 py-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div class="text-sm font-medium text-gray-200">GitHub repositories</div>
                <p class="mt-0.5 text-xs text-gray-400">
                  Watch pull request and review activity for this space.
                </p>
              </div>
              <label
                class={cn(
                  'flex items-center gap-2 text-xs text-gray-300',
                  disabled && 'opacity-60'
                )}
              >
                <input
                  type="checkbox"
                  checked={githubSpaceEnabled}
                  disabled={disabled || !githubControlsEnabled || busy === 'space:github'}
                  onChange={() => setSpaceEnabled(!githubSpaceEnabled)}
                  class="h-4 w-4 rounded border-dark-500 bg-dark-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
                />
                Enabled for this space
              </label>
            </div>

            <div class="mt-3 rounded-lg border border-white/10 bg-dark-850 px-3 py-2">
              <div class="text-[11px] uppercase tracking-wider text-gray-400">Webhook endpoint</div>
              <div class="mt-1 flex items-center gap-2">
                <code class="min-w-0 flex-1 truncate text-xs text-gray-300">{webhookUrl}</code>
                <CopyButton text={webhookUrl} label="Copy webhook URL" />
              </div>
              <p class="mt-1 text-xs text-gray-400">
                Use a public HTTPS tunnel for local development. Configure GitHub webhooks for
                pull_request, issue_comment, pull_request_review, and pull_request_review_comment
                events.
              </p>
            </div>

            <form
              onSubmit={(event) => addRepo(event)}
              class="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]"
            >
              <input
                type="text"
                value={repoInput}
                onInput={(event) => setRepoInput((event.target as HTMLInputElement).value)}
                placeholder="owner/repository"
                disabled={disabled || !githubControlsEnabled}
                class="rounded-lg border border-white/10 bg-dark-850 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
              />
              <input
                type="password"
                value={webhookSecret}
                onInput={(event) => setWebhookSecret((event.target as HTMLInputElement).value)}
                placeholder="Webhook secret (optional)"
                disabled={disabled || !githubControlsEnabled}
                class="rounded-lg border border-white/10 bg-dark-850 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
              />
              <Button
                type="submit"
                size="sm"
                loading={busy === 'repo:add'}
                disabled={disabled || !githubControlsEnabled || busy === 'repo:add'}
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
                  busy === 'repo:add:auto'
                }
                onClick={() => addRepo(undefined, true)}
              >
                Auto-configure
              </Button>
            </form>
            {formError && <p class="mt-2 text-xs text-red-300">{formError}</p>}

            <div class="mt-3 space-y-2">
              {repos.length === 0 ? (
                <p class="rounded-lg border border-dashed border-dark-600 px-3 py-3 text-sm text-gray-400">
                  No repositories watched yet.
                </p>
              ) : (
                repos.map((repo) => (
                  <GitHubRepoRow
                    key={repo.id}
                    repo={repo}
                    disabled={
                      disabled ||
                      busy === `repo:${repo.id}` ||
                      busy === `webhook:${repo.id}` ||
                      !githubControlsEnabled
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
        </div>
      )}
    </section>
  );
}

interface DeliveryLogSectionProps {
  deliveries: SpaceExternalEventDeliveryLogRecord[];
  loading: boolean;
  status: ExternalEventDeliveryStatus | '';
  agentFilter: string;
  selectedDelivery: SpaceExternalEventDeliveryLogRecord | null;
  onStatusChange: (status: ExternalEventDeliveryStatus | '') => void;
  onAgentFilterChange: (value: string) => void;
  onApplyAgentFilter: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onSelect: (delivery: SpaceExternalEventDeliveryLogRecord | null) => void;
}

function DeliveryLogSection({
  deliveries,
  loading,
  status,
  agentFilter,
  selectedDelivery,
  onStatusChange,
  onAgentFilterChange,
  onApplyAgentFilter,
  onRefresh,
  onSelect,
}: DeliveryLogSectionProps) {
  return (
    <div class="rounded-lg border border-dark-700 bg-dark-800 px-3 py-3">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div class="text-sm font-medium text-gray-200">Event delivery log</div>
          <p class="mt-0.5 text-xs text-gray-400">
            Inspect external events, matched agents, delivery state, and payloads.
          </p>
        </div>
        <Button type="button" size="sm" loading={loading} onClick={onRefresh}>
          Refresh
        </Button>
      </div>

      <div class="mt-3 flex flex-wrap gap-2">
        <select
          value={status}
          onChange={(event) =>
            onStatusChange((event.target as HTMLSelectElement).value as typeof status)
          }
          class="rounded-lg border border-white/10 bg-dark-850 px-3 py-2 text-xs text-gray-100 focus:border-blue-500 focus:outline-none"
          aria-label="Delivery status"
        >
          {DELIVERY_STATUSES.map((deliveryStatus) => (
            <option key={deliveryStatus || 'all'} value={deliveryStatus}>
              {deliveryStatus || 'all statuses'}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={agentFilter}
          onInput={(event) => onAgentFilterChange((event.target as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void onApplyAgentFilter();
          }}
          placeholder="filter agent"
          class="rounded-lg border border-white/10 bg-dark-850 px-3 py-2 text-xs text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
        />
        <Button type="button" size="sm" onClick={onApplyAgentFilter}>
          Apply
        </Button>
      </div>

      <div class="mt-3 overflow-x-auto rounded-lg border border-dark-600">
        <table class="min-w-full divide-y divide-dark-600 text-left text-xs">
          <thead class="bg-dark-850 text-gray-400">
            <tr>
              <th class="px-3 py-2 font-medium">Event</th>
              <th class="px-3 py-2 font-medium">Target</th>
              <th class="px-3 py-2 font-medium">Status</th>
              <th class="px-3 py-2 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-dark-700">
            {loading ? (
              <tr>
                <td colSpan={4} class="px-3 py-4 text-gray-400">
                  <span class="inline-flex items-center gap-2">
                    <Spinner size="sm" /> Loading deliveries…
                  </span>
                </td>
              </tr>
            ) : deliveries.length === 0 ? (
              <tr>
                <td colSpan={4} class="px-3 py-4 text-gray-400">
                  No event deliveries recorded yet.
                </td>
              </tr>
            ) : (
              deliveries.map((delivery) => (
                <DeliveryRow
                  key={delivery.deliveryKey}
                  delivery={delivery}
                  selected={selectedDelivery?.deliveryKey === delivery.deliveryKey}
                  onSelect={() => onSelect(delivery)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {selectedDelivery && (
        <DeliveryDetail delivery={selectedDelivery} onClose={() => onSelect(null)} />
      )}
    </div>
  );
}

function DeliveryRow({
  delivery,
  selected,
  onSelect,
}: {
  delivery: SpaceExternalEventDeliveryLogRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <tr
      class={cn('cursor-pointer hover:bg-white/5', selected && 'bg-blue-500/10')}
      onClick={onSelect}
    >
      <td class="max-w-[24rem] px-3 py-2">
        <div class="truncate font-mono text-gray-200">{delivery.event.topic}</div>
        <div class="mt-0.5 truncate text-gray-400">{delivery.event.summary || 'No summary'}</div>
      </td>
      <td class="px-3 py-2 text-gray-300">
        <div>{delivery.agentName}</div>
        <div class="mt-0.5 font-mono text-[11px] text-gray-500">{delivery.workflowRunId}</div>
      </td>
      <td class="px-3 py-2">
        <span
          class={cn(
            'rounded-full px-2 py-0.5 text-[11px]',
            delivery.state === 'delivered' && 'bg-green-500/10 text-green-300',
            delivery.state === 'pending' && 'bg-yellow-500/10 text-yellow-300',
            delivery.state === 'failed' && 'bg-red-500/10 text-red-300'
          )}
        >
          {delivery.state}
        </span>
        {delivery.failureReason && (
          <div class="mt-1 max-w-[16rem] truncate text-[11px] text-red-300">
            {delivery.failureReason}
          </div>
        )}
      </td>
      <td class="px-3 py-2 text-gray-400">{formatTimestamp(delivery.updatedAt)}</td>
    </tr>
  );
}

function DeliveryDetail({
  delivery,
  onClose,
}: {
  delivery: SpaceExternalEventDeliveryLogRecord;
  onClose: () => void;
}) {
  return (
    <div class="mt-3 rounded-lg border border-dark-600 bg-dark-850 px-3 py-3">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-sm font-medium text-gray-200">Event detail</div>
          <div class="mt-1 font-mono text-xs text-gray-400">{delivery.event.id}</div>
        </div>
        <button type="button" onClick={onClose} class="text-xs text-gray-400 hover:text-gray-200">
          Close
        </button>
      </div>
      <dl class="mt-3 grid gap-2 text-xs md:grid-cols-2">
        <DetailItem label="Topic" value={delivery.event.topic} />
        <DetailItem label="Source" value={delivery.event.source} />
        <DetailItem label="Event state" value={delivery.eventState} />
        <DetailItem label="Delivery key" value={delivery.deliveryKey} />
        <DetailItem label="Target agent" value={delivery.agentName} />
        <DetailItem label="Workflow run" value={delivery.workflowRunId} />
        <DetailItem label="Task" value={delivery.taskId} />
        <DetailItem label="Node" value={delivery.nodeId} />
        <DetailItem label="Occurred" value={formatTimestamp(delivery.event.occurredAt)} />
        <DetailItem label="Ingested" value={formatTimestamp(delivery.event.ingestedAt)} />
        <DetailItem label="Delivered" value={formatTimestamp(delivery.deliveredAt)} />
        <DetailItem label="Updated" value={formatTimestamp(delivery.updatedAt)} />
      </dl>
      {delivery.failureReason && (
        <div class="mt-3 rounded border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {delivery.failureReason}
        </div>
      )}
      <div class="mt-3">
        <div class="mb-1 text-[11px] uppercase tracking-wider text-gray-400">Payload</div>
        <pre class="max-h-72 overflow-auto rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-gray-300">
          {formatJson(delivery.event.payload)}
        </pre>
      </div>
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt class="text-[11px] uppercase tracking-wider text-gray-500">{label}</dt>
      <dd class="mt-0.5 break-all text-gray-300">{value}</dd>
    </div>
  );
}

interface ExtensionCardProps {
  extension: ExtensionStatus;
  disabled: boolean;
  onToggle: (enabled: boolean) => Promise<void>;
}

function ExtensionCard({ extension, disabled, onToggle }: ExtensionCardProps) {
  const capabilities = formatCapabilities(extension.config.capabilities);
  return (
    <label
      class={cn(
        'flex items-start gap-3 rounded-lg border border-dark-700 bg-dark-800 px-3 py-2.5',
        disabled && 'opacity-60'
      )}
    >
      <input
        type="checkbox"
        checked={extension.config.globallyEnabled}
        disabled={disabled}
        onChange={() => onToggle(!extension.config.globallyEnabled)}
        class="mt-0.5 h-4 w-4 rounded border-dark-500 bg-dark-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
      />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm font-medium text-gray-200 capitalize">{extension.source}</span>
          <span
            class={cn(
              'rounded-full px-2 py-0.5 text-[11px]',
              extension.status === 'started'
                ? 'bg-green-500/10 text-green-300'
                : 'bg-gray-500/10 text-gray-400'
            )}
          >
            {extension.status}
          </span>
        </div>
        <div class="mt-1 flex flex-wrap gap-1">
          {capabilities.map((capability) => (
            <span
              key={capability}
              class="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-gray-400"
            >
              {capability}
            </span>
          ))}
          {capabilities.length === 0 && (
            <span class="text-xs text-gray-400">No capabilities enabled</span>
          )}
        </div>
      </div>
    </label>
  );
}

interface GitHubRepoRowProps {
  repo: GitHubWatchedRepo;
  disabled: boolean;
  webhookBusy: boolean;
  webhooksEnabled: boolean;
  pollingEnabled: boolean;
  onUpdate: (patch: Partial<GitHubWatchedRepo>) => Promise<void>;
  onAutoConfigureWebhook: () => Promise<void>;
  onCheckWebhook: () => Promise<void>;
  onRemove: () => Promise<void>;
}

function GitHubRepoRow({
  repo,
  disabled,
  webhookBusy,
  webhooksEnabled,
  pollingEnabled,
  onUpdate,
  onAutoConfigureWebhook,
  onCheckWebhook,
  onRemove,
}: GitHubRepoRowProps) {
  return (
    <div
      class={cn(
        'rounded-lg border border-dark-600 bg-dark-850 px-3 py-2.5',
        disabled && 'opacity-60'
      )}
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="truncate font-mono text-sm text-gray-200">
            {repo.owner}/{repo.repo}
          </div>
          <div class="mt-1 flex flex-wrap gap-2 text-[11px] text-gray-400">
            <span>secret {repo.webhookSecret ? 'configured' : 'missing'}</span>
            <WebhookStatus repo={repo} />
            <span>last webhook {formatTimestamp(repo.lastWebhookAt)}</span>
            <span>last poll {formatTimestamp(repo.lastPollAt)}</span>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            loading={webhookBusy}
            disabled={disabled || webhookBusy || !webhooksEnabled}
            onClick={onAutoConfigureWebhook}
          >
            Auto-configure webhook
          </Button>
          {repo.webhookRemoteId && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              loading={false}
              disabled={disabled || webhookBusy}
              onClick={onCheckWebhook}
            >
              Check webhook
            </Button>
          )}
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            class="text-xs text-red-400 hover:text-red-300 disabled:cursor-not-allowed disabled:text-red-900"
          >
            Remove
          </button>
        </div>
      </div>
      <div class="mt-3 flex flex-wrap gap-4">
        <label class="flex items-center gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            checked={repo.enabled}
            disabled={disabled}
            onChange={() => onUpdate({ enabled: !repo.enabled })}
            class="h-4 w-4 rounded border-dark-500 bg-dark-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
          />
          Enabled
        </label>
        <label class="flex items-center gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            checked={repo.webhookEnabled}
            disabled={disabled}
            onChange={() => onUpdate({ webhookEnabled: !repo.webhookEnabled })}
            class="h-4 w-4 rounded border-dark-500 bg-dark-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
          />
          Webhooks
        </label>
        <label class="flex items-center gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            checked={repo.pollingEnabled}
            disabled={disabled || !pollingEnabled}
            onChange={() => onUpdate({ pollingEnabled: !repo.pollingEnabled })}
            class="h-4 w-4 rounded border-dark-500 bg-dark-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
          />
          Polling
        </label>
      </div>
    </div>
  );
}

function WebhookStatus({ repo }: { repo: GitHubWatchedRepo }) {
  if (!repo.webhookRemoteId) {
    return <span>webhook manual</span>;
  }
  if (repo.webhookActive === true) {
    return <span class="text-green-300">webhook active</span>;
  }
  if (repo.webhookActive === false) {
    return <span class="text-red-300">webhook inactive</span>;
  }
  return <span>webhook status unknown</span>;
}
