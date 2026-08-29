import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager.ts';
import { toast } from '../../lib/toast.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/Button.tsx';
import { Spinner } from '../ui/Spinner.tsx';

export type GitHubHealthEventTypeKey =
  | 'status'
  | 'review_thread'
  | 'deployment'
  | 'check_suite'
  | 'merge_group'
  | 'branch_protection';

export interface GitHubHealthSnapshot {
  source: 'github';
  spaceId: string;
  timestamp: number;
  token: {
    configured: boolean;
    source: 'keychain' | 'env' | 'none';
    login?: string;
    error?: string;
    authRejected?: boolean;
    autoRegisteredHookCount?: number;
  };
  polling: {
    globallyEnabled: boolean;
    intervalMs: number;
    active: boolean;
    pollingRepoCount: number;
    inaccessibleRepoCount: number;
    partialErrorRepoCount: number;
    neverPolledRepoCount: number;
    stalePollingRepoCount: number;
    lastPollAt: number | null;
  };
  rateLimit: {
    limited: boolean;
    until: number;
    fromRetryAfter: boolean;
    remaining: number | null;
    resetAt: number | null;
    observedAt: number;
  };
  webhook: {
    total: number;
    configured: number;
    active: number;
    inactive: number;
    unknown: number;
    deliveryEnabled: boolean;
    lastWebhookAt: number | null;
    lastCheckedAt: number | null;
    errors: Array<{ owner: string; repo: string; error: string; at: number | null }>;
  };
  reactions: {
    trackedPullRequests: number;
    lastActivityAt: number | null;
    staleRepoCount: number;
  };
  recentErrors: Array<{
    eventId: string;
    deliveryKey: string;
    topic: string;
    agentName: string | null;
    failureReason: string | null;
    updatedAt: number;
    occurredAt: number;
  }>;
  recentErrorTotal: number;
  eventTypes: Array<{
    type: GitHubHealthEventTypeKey;
    label: string;
    count: number;
    lastAt: number | null;
  }>;
  repositories: Array<{
    owner: string;
    repo: string;
    enabled: boolean;
    webhookEnabled: boolean;
    webhookActive: boolean | null;
    webhookAutoRegistered: boolean;
    pollingEnabled: boolean;
    lastWebhookAt: number | null;
    webhookLastCheckedAt: number | null;
    lastPollAt: number | null;
    webhookLastError: string | null;
    lastPollError: string | null;
    lastPartialPollError: string | null;
    reactionTrackedPullRequests: number;
  }>;
}

interface GitHubHealthPanelProps {
  spaceId: string;
  pollingCapabilityEnabled: boolean;
  webhooksCapabilityEnabled: boolean;
  disabled?: boolean;
  refreshNonce?: number;
  onAfterAction?: () => void | Promise<void>;
  onBusyChange?: (busy: 'poll' | 'reregister' | null) => void;
}

type HealthStatus = 'healthy' | 'degraded' | 'down';

function formatTimestamp(value: number | null): string {
  if (!value) return 'never';
  return new Date(value).toLocaleString();
}

function relativeFromNow(target: number): string {
  if (!target) return '';
  const delta = target - Date.now();
  if (delta <= 0) return 'now';
  const seconds = Math.round(delta / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function relativeAgo(timestamp: number): string {
  if (!timestamp) return '';
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'just now';
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatInterval(ms: number): string {
  if (ms <= 0) return 'disabled';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`;
}

const POLLING_STALE_INTERVALS = 3;
const POLLING_STALE_MIN_MS = 5 * 60 * 1000;
const HEALTH_REFRESH_INTERVAL_MS = 60 * 1000;
const POLL_ONCE_TIMEOUT_MS = 5 * 60 * 1000;
const STALE_AFTER_SILENT_FAILURES = 3;
const WEBHOOK_CONFIGURE_TIMEOUT_MS = 90 * 1000;
const WEBHOOK_EVIDENCE_STALE_MS = 30 * 24 * 60 * 60 * 1000;

function pollingIsStale(snapshot: GitHubHealthSnapshot): boolean {
  const { lastPollAt, intervalMs } = snapshot.polling;
  if (lastPollAt === null || intervalMs <= 0) return false;
  const window = Math.max(intervalMs * POLLING_STALE_INTERVALS, POLLING_STALE_MIN_MS);
  return snapshot.timestamp - lastPollAt > window;
}

function reactionsAreStale(snapshot: GitHubHealthSnapshot): boolean {
  return snapshot.reactions.staleRepoCount > 0;
}

function webhookEvidenceStale(snapshot: GitHubHealthSnapshot): boolean {
  return snapshot.repositories.some((r) => {
    if (!r.enabled || !r.webhookEnabled) return false;
    const lastCheck = r.webhookLastCheckedAt ?? null;
    if (r.lastWebhookAt === null && lastCheck === null) {
      return r.webhookActive === null;
    }
    const deliveryFresh =
      r.lastWebhookAt !== null && snapshot.timestamp - r.lastWebhookAt <= WEBHOOK_EVIDENCE_STALE_MS;
    if (deliveryFresh) return false;
    const checkFresh =
      r.webhookActive === true &&
      lastCheck !== null &&
      snapshot.timestamp - lastCheck <= WEBHOOK_EVIDENCE_STALE_MS;
    return !checkFresh;
  });
}

function deriveStatus(snapshot: GitHubHealthSnapshot): HealthStatus {
  const pollingLive =
    snapshot.polling.globallyEnabled &&
    snapshot.polling.intervalMs > 0 &&
    snapshot.polling.pollingRepoCount - snapshot.polling.inaccessibleRepoCount > 0 &&
    snapshot.polling.lastPollAt !== null &&
    !snapshot.token.authRejected &&
    !pollingIsStale(snapshot) &&
    snapshot.polling.neverPolledRepoCount === 0;
  const webhookLive =
    snapshot.webhook.deliveryEnabled &&
    snapshot.repositories.some(
      (r) =>
        r.enabled &&
        r.webhookEnabled &&
        (r.webhookActive === true || (r.webhookActive === null && r.lastWebhookAt !== null))
    );
  if (!(pollingLive || webhookLive)) {
    if (
      snapshot.rateLimit.limited &&
      snapshot.polling.globallyEnabled &&
      snapshot.polling.intervalMs > 0 &&
      !snapshot.token.authRejected &&
      snapshot.polling.pollingRepoCount - snapshot.polling.inaccessibleRepoCount > 0
    ) {
      return 'degraded';
    }
    return 'down';
  }
  const pollingActive = snapshot.polling.globallyEnabled && snapshot.polling.intervalMs > 0;
  if (
    (snapshot.rateLimit.limited && pollingLive) ||
    (snapshot.webhook.deliveryEnabled &&
      (snapshot.webhook.inactive > 0 ||
        snapshot.webhook.errors.length > 0 ||
        webhookEvidenceStale(snapshot))) ||
    (pollingActive &&
      (snapshot.polling.inaccessibleRepoCount > 0 ||
        snapshot.polling.partialErrorRepoCount > 0 ||
        snapshot.polling.stalePollingRepoCount > 0 ||
        snapshot.polling.neverPolledRepoCount > 0 ||
        reactionsAreStale(snapshot) ||
        (Boolean(snapshot.token.error) && snapshot.polling.pollingRepoCount > 0))) ||
    snapshot.recentErrorTotal > 0
  ) {
    return 'degraded';
  }
  return 'healthy';
}

const STATUS_STYLES: Record<HealthStatus, { label: string; class: string }> = {
  healthy: { label: 'Healthy', class: 'bg-success/10 text-success-soft' },
  degraded: { label: 'Degraded', class: 'bg-warning/10 text-warning-soft' },
  down: { label: 'Down', class: 'bg-danger/10 text-danger-soft' },
};

export function GitHubHealthPanel({
  spaceId,
  pollingCapabilityEnabled,
  webhooksCapabilityEnabled,
  disabled = false,
  refreshNonce,
  onAfterAction,
  onBusyChange,
}: GitHubHealthPanelProps) {
  const [snapshot, setSnapshot] = useState<GitHubHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'poll' | 'reregister' | null>(null);
  const [snapshotStale, setSnapshotStale] = useState(false);
  const spaceIdRef = useRef(spaceId);
  spaceIdRef.current = spaceId;
  const refreshGenRef = useRef(0);
  const foregroundInFlightRef = useRef(0);
  const skippedFirstNonceRef = useRef(false);
  const silentFailuresRef = useRef(0);

  async function refreshHealth(silent = false): Promise<void> {
    if (silent && foregroundInFlightRef.current > 0) return;
    const refreshSpaceId = spaceIdRef.current;
    const refreshGen = ++refreshGenRef.current;
    if (!silent) foregroundInFlightRef.current += 1;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      if (!silent) {
        foregroundInFlightRef.current = Math.max(0, foregroundInFlightRef.current - 1);
        setSnapshot(null);
        setError('Not connected to server');
        setLoading(false);
        setSnapshotStale(true);
      } else {
        silentFailuresRef.current += 1;
        if (silentFailuresRef.current >= STALE_AFTER_SILENT_FAILURES) {
          setSnapshotStale(true);
        }
      }
      return;
    }
    try {
      if (!silent) setLoading(true);
      const result = await hub.request<GitHubHealthSnapshot>(
        'space.github.health',
        silent ? { spaceId: refreshSpaceId, lightweight: true } : { spaceId: refreshSpaceId }
      );
      if (spaceIdRef.current !== refreshSpaceId || refreshGenRef.current !== refreshGen) return;
      setSnapshot(result);
      setError(null);
      setSnapshotStale(false);
      silentFailuresRef.current = 0;
    } catch (err) {
      if (spaceIdRef.current !== refreshSpaceId || refreshGenRef.current !== refreshGen) return;
      if (!silent) {
        setSnapshot(null);
        setError(err instanceof Error ? err.message : String(err));
      } else {
        silentFailuresRef.current += 1;
        if (silentFailuresRef.current >= STALE_AFTER_SILENT_FAILURES) {
          setSnapshotStale(true);
        }
      }
    } finally {
      if (!silent) {
        foregroundInFlightRef.current = Math.max(0, foregroundInFlightRef.current - 1);
        if (spaceIdRef.current === refreshSpaceId && refreshGenRef.current === refreshGen) {
          setLoading(false);
        }
      }
    }
  }

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    void refreshHealth();
  }, [spaceId]);

  useEffect(() => {
    if (!skippedFirstNonceRef.current) {
      skippedFirstNonceRef.current = true;
      return;
    }
    setSnapshotStale(true);
    void refreshHealth();
  }, [refreshNonce]);

  const rateLimitUntil = snapshot?.rateLimit.until ?? 0;
  const rateLimitActive = snapshot?.rateLimit.limited === true;
  const snapshotTimestamp = snapshot?.timestamp ?? 0;
  useEffect(() => {
    if (!rateLimitActive || rateLimitUntil <= 0 || snapshotTimestamp <= 0) return;
    const delay = rateLimitUntil - snapshotTimestamp;
    if (delay <= 0) return;
    const timer = setTimeout(() => {
      void refreshHealth();
    }, delay);
    return () => clearTimeout(timer);
  }, [rateLimitActive, rateLimitUntil, snapshotTimestamp]);

  useEffect(() => {
    if (busy) return;
    const id = setInterval(() => {
      void refreshHealth(true);
    }, HEALTH_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [busy, spaceId]);

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(null);
  }, [busy, onBusyChange]);

  async function pollNow(): Promise<void> {
    const actionSpaceId = spaceIdRef.current;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    try {
      setBusy('poll');
      onBusyChange?.('poll');
      const result = await hub.request<{ count: number; skipped?: string; errors?: number }>(
        'space.github.pollOnce',
        { spaceId: actionSpaceId },
        { timeout: POLL_ONCE_TIMEOUT_MS }
      );
      if (spaceIdRef.current !== actionSpaceId) return;
      if (result.skipped === 'rate-limited') {
        if (result.count > 0) {
          toast.success(
            `Poll partial: ${result.count} event(s) published, some skipped (rate-limited)`
          );
        } else {
          toast.error('Poll skipped: GitHub rate-limited (retry after the cooldown)');
        }
      } else if (result.errors && result.errors > 0) {
        toast.error(
          `Poll partial: ${result.count} event(s) published, ${result.errors} repo(s) with errors`
        );
      } else {
        toast.success(`Poll complete: ${result.count} event(s) published`);
      }
      await (onAfterAction ? onAfterAction() : refreshHealth());
    } catch (err) {
      if (spaceIdRef.current !== actionSpaceId) return;
      toast.error(`Poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function reRegisterWebhooks(): Promise<void> {
    const actionSpaceId = spaceIdRef.current;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    if (snapshotStale) {
      toast.error('Refreshing after a change — try again in a moment');
      return;
    }
    const targets =
      snapshot?.spaceId === actionSpaceId
        ? (snapshot.repositories ?? []).filter(
            (repo) => repo.webhookEnabled && repo.webhookAutoRegistered
          )
        : [];
    if (targets.length === 0) {
      toast.error('No auto-managed webhooks to re-register');
      return;
    }
    try {
      setBusy('reregister');
      onBusyChange?.('reregister');
      let succeeded = 0;
      let failed = 0;
      for (const target of targets) {
        try {
          await hub.request(
            'space.github.autoConfigureWebhook',
            {
              spaceId: actionSpaceId,
              owner: target.owner,
              repo: target.repo,
            },
            { timeout: WEBHOOK_CONFIGURE_TIMEOUT_MS }
          );
          succeeded++;
        } catch {
          failed++;
        }
      }
      if (spaceIdRef.current !== actionSpaceId) return;
      if (failed === 0) {
        toast.success(`Re-registered ${succeeded} webhook(s)`);
      } else {
        toast.error(`Re-registered ${succeeded}, failed ${failed} webhook(s)`);
      }
      await (onAfterAction ? onAfterAction() : refreshHealth());
    } finally {
      setBusy(null);
    }
  }

  const derivedStatusResult = snapshot ? deriveStatus(snapshot) : null;
  const status =
    derivedStatusResult && snapshotStale && derivedStatusResult === 'healthy'
      ? 'degraded'
      : derivedStatusResult;
  const reregisterTargets =
    snapshot?.spaceId === spaceId
      ? (snapshot.repositories ?? []).filter((r) => r.webhookEnabled && r.webhookAutoRegistered)
          .length
      : 0;
  const pollingIntervalEnabled = (snapshot?.polling.intervalMs ?? 0) > 0;
  const hasPollingRepos =
    snapshot?.spaceId === spaceId && (snapshot?.polling.pollingRepoCount ?? 0) > 0;
  const rateLimited = snapshot?.rateLimit.limited === true;

  return (
    <div
      class="rounded-lg border border-line bg-surface-raised px-3 py-3"
      data-testid="github-health-panel"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <div class="text-sm font-medium text-fg-soft">GitHub integration health</div>
          {status && (
            <span
              class={cn('rounded-full px-2 py-0.5 text-[11px]', STATUS_STYLES[status].class)}
              data-testid="github-health-status"
            >
              {STATUS_STYLES[status].label}
            </span>
          )}
        </div>
        <div class="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            loading={busy === 'poll'}
            disabled={
              disabled ||
              !pollingCapabilityEnabled ||
              !pollingIntervalEnabled ||
              !hasPollingRepos ||
              rateLimited ||
              busy !== null ||
              snapshotStale
            }
            onClick={() => pollNow()}
            title={
              disabled
                ? 'Settings are locked'
                : !pollingCapabilityEnabled
                  ? 'Polling capability is disabled'
                  : !pollingIntervalEnabled
                    ? 'Polling is disabled (interval is 0)'
                    : !hasPollingRepos
                      ? 'No polling repositories in this Space'
                      : rateLimited
                        ? 'Rate-limited — polling resumes after the cooldown'
                        : 'Poll GitHub now and publish any new events'
            }
          >
            Poll now
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            loading={busy === 'reregister'}
            disabled={
              disabled ||
              !webhooksCapabilityEnabled ||
              reregisterTargets === 0 ||
              busy !== null ||
              snapshotStale
            }
            onClick={() => reRegisterWebhooks()}
            title={
              disabled
                ? 'Settings are locked'
                : !webhooksCapabilityEnabled
                  ? 'Webhook capability is disabled'
                  : reregisterTargets === 0
                    ? 'No auto-managed webhooks'
                    : `Re-register ${reregisterTargets} webhook(s)`
            }
          >
            Re-register webhooks
          </Button>
          <Button
            type="button"
            size="sm"
            loading={loading}
            disabled={disabled || busy !== null}
            onClick={() => refreshHealth()}
          >
            Refresh
          </Button>
        </div>
      </div>

      {loading && !snapshot ? (
        <div class="mt-3 flex items-center gap-2 py-2 text-xs text-fg-muted">
          <Spinner size="sm" /> Loading integration health…
        </div>
      ) : error ? (
        <p class="mt-3 text-xs text-danger-soft">Failed to load health: {error}</p>
      ) : snapshot ? (
        <div class="mt-3 space-y-3">
          <dl class="grid gap-2 text-xs md:grid-cols-2" data-testid="github-health-metrics">
            <Metric label="Token">
              <TokenStatusBadge snapshot={snapshot} />
            </Metric>
            <Metric label="Polling">
              <PollingStatus snapshot={snapshot} />
            </Metric>
            <Metric label="Rate limit">
              <RateLimitStatus snapshot={snapshot} />
            </Metric>
            <Metric label="Webhooks">
              <WebhookStatus snapshot={snapshot} />
            </Metric>
            <Metric label="Reaction polling">
              <ReactionStatus snapshot={snapshot} />
            </Metric>
            <Metric label="Recent delivery errors">
              <span class="text-fg-soft">{snapshot.recentErrorTotal}</span>
              {snapshot.recentErrors.length > 0 && (
                <span class="ml-2 text-fg-faint">
                  latest {formatTimestamp(snapshot.recentErrors[0].updatedAt)}
                </span>
              )}
            </Metric>
          </dl>

          <EventTypeBreakdown snapshot={snapshot} />

          {(snapshot.webhook.errors.length > 0 || snapshot.recentErrors.length > 0) && (
            <div class="space-y-2 rounded-lg border border-line bg-surface-overlay px-3 py-2">
              {snapshot.webhook.errors.length > 0 && (
                <ErrorList
                  heading="Webhook errors"
                  rows={snapshot.webhook.errors.map((entry) => ({
                    key: `wh:${entry.owner}/${entry.repo}`,
                    primary: `${entry.owner}/${entry.repo}`,
                    detail: entry.error,
                    at: entry.at,
                  }))}
                />
              )}
              {snapshot.recentErrors.length > 0 && (
                <ErrorList
                  heading="Failed deliveries"
                  rows={snapshot.recentErrors.map((entry) => ({
                    key: `err:${entry.eventId}:${entry.deliveryKey}`,
                    primary: entry.topic,
                    detail: entry.failureReason ?? undefined,
                    agent: entry.agentName ?? undefined,
                    at: entry.updatedAt,
                  }))}
                />
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="rounded-lg border border-line bg-surface-overlay px-3 py-2">
      <dt class="text-[11px] uppercase tracking-wider text-fg-faint">{label}</dt>
      <dd class="mt-1 text-fg-soft">{children}</dd>
    </div>
  );
}

function TokenStatusBadge({ snapshot }: { snapshot: GitHubHealthSnapshot }) {
  const { token } = snapshot;
  if (!token.configured) {
    return (
      <span>
        <span class="text-danger-soft">Not configured</span>
        {token.error && <div class="text-danger-soft">{token.error}</div>}
      </span>
    );
  }
  const sourceLabel = token.source === 'keychain' ? 'keychain' : 'env var';
  return (
    <span>
      <span class="text-fg-soft">{token.login ?? 'configured'}</span>{' '}
      <span class="text-fg-faint">({sourceLabel})</span>
      {token.error && <div class="text-danger-soft">{token.error}</div>}
    </span>
  );
}

function PollingStatus({ snapshot }: { snapshot: GitHubHealthSnapshot }) {
  const { polling } = snapshot;
  if (!polling.globallyEnabled || polling.intervalMs <= 0) {
    return <span class="text-fg-muted">Disabled</span>;
  }
  return (
    <span>
      <span class="text-fg-soft">{formatInterval(polling.intervalMs)}</span>{' '}
      <span class="text-fg-faint">
        {polling.active ? 'active' : 'idle'}, {polling.pollingRepoCount} repo(s)
      </span>
      <div class="text-fg-faint">last poll {formatTimestamp(polling.lastPollAt)}</div>
    </span>
  );
}

function RateLimitStatus({ snapshot }: { snapshot: GitHubHealthSnapshot }) {
  const { rateLimit } = snapshot;
  if (rateLimit.limited) {
    return (
      <span>
        <span class="text-warning-soft">Cooling down</span>{' '}
        <span class="text-fg-faint">resets in {relativeFromNow(rateLimit.until)}</span>
      </span>
    );
  }
  if (rateLimit.remaining === null) {
    return <span class="text-fg-muted">Unknown (no poll yet)</span>;
  }
  return (
    <span>
      <span class="text-fg-soft">{rateLimit.remaining.toLocaleString()}</span>{' '}
      <span class="text-fg-faint">remaining</span>
      {rateLimit.resetAt && (
        <div class="text-fg-faint">resets in {relativeFromNow(rateLimit.resetAt)}</div>
      )}
    </span>
  );
}

function WebhookStatus({ snapshot }: { snapshot: GitHubHealthSnapshot }) {
  const { webhook } = snapshot;
  if (webhook.total === 0) return <span class="text-fg-muted">No repositories</span>;
  if (!webhook.deliveryEnabled) {
    return (
      <span>
        <span class="text-fg-muted">Delivery disabled</span>
        <div class="text-fg-faint">
          {webhook.active > 0
            ? `${webhook.active} hook(s) registered but not accepting events`
            : 'No active hooks'}
        </div>
      </span>
    );
  }
  return (
    <span>
      <span class="text-success-soft">{webhook.active} active</span>
      {webhook.inactive > 0 && <span class="text-danger-soft"> · {webhook.inactive} inactive</span>}
      {webhook.unknown > 0 && <span class="text-fg-faint"> · {webhook.unknown} unchecked</span>}
      <div class="text-fg-faint">
        last webhook {formatTimestamp(webhook.lastWebhookAt)}
        {webhook.lastCheckedAt ? ` · checked ${relativeAgo(webhook.lastCheckedAt)}` : ''}
      </div>
    </span>
  );
}

function ReactionStatus({ snapshot }: { snapshot: GitHubHealthSnapshot }) {
  const { reactions } = snapshot;
  if (reactions.trackedPullRequests === 0) {
    return <span class="text-fg-muted">No PRs tracked</span>;
  }
  return (
    <span>
      <span class="text-fg-soft">{reactions.trackedPullRequests} PR(s)</span>{' '}
      <span class="text-fg-faint">tracked</span>
      <div class="text-fg-faint">last activity {formatTimestamp(reactions.lastActivityAt)}</div>
    </span>
  );
}

function EventTypeBreakdown({ snapshot }: { snapshot: GitHubHealthSnapshot }) {
  return (
    <div
      class="rounded-lg border border-line bg-surface-overlay px-3 py-2"
      data-testid="github-health-event-types"
    >
      <div class="text-[11px] uppercase tracking-wider text-fg-faint">Recent events</div>
      <dl class="mt-2 grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {snapshot.eventTypes.map((entry) => (
          <div
            key={entry.type}
            class="flex items-baseline justify-between gap-2"
            data-testid={`github-health-event-type-${entry.type}`}
          >
            <dt class="truncate text-fg-soft" title={entry.label}>
              {entry.label}
            </dt>
            <dd class="shrink-0 text-fg-faint">
              {entry.count > 0 ? (
                <>
                  <span class="text-fg-soft">{entry.count.toLocaleString()}</span> ·{' '}
                  {relativeAgo(entry.lastAt as number)}
                </>
              ) : (
                <span class="text-fg-faint">0</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

interface ErrorListRow {
  key: string;
  primary: string;
  detail?: string;
  agent?: string;
  at: number | null;
}

function ErrorList({ heading, rows }: { heading: string; rows: ErrorListRow[] }) {
  return (
    <div>
      <div class="text-[11px] uppercase tracking-wider text-fg-faint">{heading}</div>
      <ul class="mt-1 space-y-1">
        {rows.map((row) => (
          <li key={row.key} class="text-xs">
            <div class="truncate font-mono text-fg-soft">{row.primary}</div>
            <div class="truncate text-danger-soft">
              {row.detail ?? 'unknown error'}
              {row.agent && <span class="text-fg-faint"> · {row.agent}</span>}
            </div>
            {row.at && <div class="text-[11px] text-fg-faint">{formatTimestamp(row.at)}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
