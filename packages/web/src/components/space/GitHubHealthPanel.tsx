/**
 * GitHubHealthPanel — consolidated GitHub integration health summary for a Space.
 *
 * Fetches a single `space.github.health` snapshot and renders token, polling,
 * rate-limit, webhook, reaction, and recent-delivery-error status at a glance,
 * plus actions to test event delivery (poll now) and re-register webhooks.
 */

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager.ts';
import { toast } from '../../lib/toast.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/Button.tsx';
import { Spinner } from '../ui/Spinner.tsx';

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
  repositories: Array<{
    owner: string;
    repo: string;
    enabled: boolean;
    webhookEnabled: boolean;
    webhookActive: boolean | null;
    webhookAutoRegistered: boolean;
    pollingEnabled: boolean;
    lastWebhookAt: number | null;
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
  /**
   * Mirrors the parent settings `disabled` state (e.g. while a space setting is
   * saving). Locks the health-panel actions so polling/webhook requests cannot
   * race a save that is meant to freeze the settings UI.
   */
  disabled?: boolean;
  /**
   * Incremented by the parent after sibling settings mutations (token save,
   * polling toggle, repo add/remove, …) so this panel re-fetches its snapshot.
   * The panel's own effect only keys on spaceId, so without this it would show
   * stale data until the next manual refresh.
   */
  refreshNonce?: number;
  /** Notified after a destructive/test action so sibling panels can refresh. */
  onAfterAction?: () => void | Promise<void>;
}

type HealthStatus = 'healthy' | 'degraded' | 'down';

function formatTimestamp(value: number | null): string {
  if (!value) return 'never';
  return new Date(value).toLocaleString();
}

/** Compact relative countdown to a future epoch (e.g. rate-limit reset). */
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

/** Elapsed-time phrase for a past epoch (e.g. a webhook check timestamp). */
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

/**
 * Derive an aggregate health label so an operator can spot a broken subsystem
 * without scanning every row.
 *
 * "down" = no working delivery path. A path is live only when it reflects real
 * delivery semantics, not just configured rows:
 *   - Polling is live when the capability is on, the interval is nonzero, there
 *     are polling repos, AND a token is configured (polling needs the GitHub
 *     API token; configured rows survive a 0 interval / missing token without
 *     actually delivering).
 *   - Webhooks are live when delivery is globally enabled (capability on) AND
 *     at least one hook is confirmed active OR has successfully delivered
 *     (the latter covers manual hooks, which never get a remote active status).
 * A token is required only for the polling path — inbound webhook delivery
 * verifies the stored secret and never uses the token.
 *
 * "degraded" = a recoverable issue worth attention (rate-limited, inactive
 * hook, webhook error, invalid token, recent delivery failures).
 */
/** Polling is considered stale (path not live) once the last poll is older than
 * this many intervals (floored so short intervals do not flap sub-minute). */
const POLLING_STALE_INTERVALS = 3;
const POLLING_STALE_MIN_MS = 5 * 60 * 1000;

function pollingIsStale(snapshot: GitHubHealthSnapshot): boolean {
  // Only flagged when a poll has happened and is now ancient — a freshly
  // enabled space (lastPollAt null) is not stale, just not-yet-polled.
  const { lastPollAt, intervalMs } = snapshot.polling;
  if (lastPollAt === null || intervalMs <= 0) return false;
  const window = Math.max(intervalMs * POLLING_STALE_INTERVALS, POLLING_STALE_MIN_MS);
  // Compare against the snapshot's own server-stamped timestamp (when the
  // daemon assembled it), not the browser clock — lastPollAt is a server epoch.
  return snapshot.timestamp - lastPollAt > window;
}

function reactionsAreStale(snapshot: GitHubHealthSnapshot): boolean {
  // Reactions are skipped while the rate-limit budget is tight (remaining <
  // 100) even though primary polling continues (threshold 10). If a Space
  // tracks reaction targets but has not observed any reaction activity for
  // well past an interval, flag it so the badge reflects that approvals are
  // not being polled (Degraded, not Down — primary events still deliver).
  const { trackedPullRequests, lastActivityAt } = snapshot.reactions;
  if (trackedPullRequests <= 0 || lastActivityAt === null) return false;
  const intervalMs = snapshot.polling.intervalMs;
  if (intervalMs <= 0) return false;
  const window = Math.max(intervalMs * POLLING_STALE_INTERVALS, POLLING_STALE_MIN_MS);
  return snapshot.timestamp - lastActivityAt > window;
}

function deriveStatus(snapshot: GitHubHealthSnapshot): HealthStatus {
  // Polling is live when configured to run, at least one repo is accessible,
  // the token (if any) is not rejected, AND the last poll is reasonably fresh
  // (a stalled scheduled request leaves an ancient lastPollAt with no further
  // delivery). No token is fine for public repos; private repos without a token
  // surface as inaccessible via the poll-access tracking.
  const pollingLive =
    snapshot.polling.globallyEnabled &&
    snapshot.polling.intervalMs > 0 &&
    snapshot.polling.pollingRepoCount - snapshot.polling.inaccessibleRepoCount > 0 &&
    // Only a definitive credential rejection (HTTP 401/403) drops the polling
    // path to Down. A transient /user validation outage (timeout/network) sets
    // token.error (→ Degraded) but recent accessible polls may still prove the
    // credential works, so it must not flip a polling-only space to Down.
    !snapshot.token.authRejected &&
    !pollingIsStale(snapshot);
  // A hook is live per-repo: a webhook-enabled repo with a confirmed-active
  // remote hook, OR an unchecked/unknown-status hook (manual) that has itself
  // delivered. Evaluated per-row (not via independently-aggregated counts) so a
  // remotely confirmed-INACTIVE hook's stale lastWebhookAt cannot revive an
  // unrelated unchecked hook.
  const webhookLive =
    snapshot.webhook.deliveryEnabled &&
    snapshot.repositories.some(
      (r) =>
        // The rollup includes disabled rows for diagnostics; only an enabled
        // repo's hook counts as a live path (a disabled space accepts no events).
        r.enabled &&
        r.webhookEnabled &&
        (r.webhookActive === true || (r.webhookActive === null && r.lastWebhookAt !== null))
    );
  if (!(pollingLive || webhookLive)) return 'down';
  if (
    // The daemon-wide GitHub API cooldown only degrades Spaces that actually
    // use the polling path; a webhook-only Space's inbound deliveries do not
    // touch the API and keep working while it is rate-limited.
    (snapshot.rateLimit.limited && pollingLive) ||
    snapshot.webhook.inactive > 0 ||
    snapshot.webhook.errors.length > 0 ||
    snapshot.polling.inaccessibleRepoCount > 0 ||
    snapshot.polling.partialErrorRepoCount > 0 ||
    // Reaction polling persistently not observed despite tracked targets
    // (e.g. skipped for budget across many cycles).
    reactionsAreStale(snapshot) ||
    snapshot.recentErrors.length > 0 ||
    Boolean(snapshot.token.error)
  ) {
    return 'degraded';
  }
  return 'healthy';
}

const STATUS_STYLES: Record<HealthStatus, { label: string; class: string }> = {
  healthy: { label: 'Healthy', class: 'bg-green-500/10 text-green-300' },
  degraded: { label: 'Degraded', class: 'bg-yellow-500/10 text-yellow-300' },
  down: { label: 'Down', class: 'bg-red-500/10 text-red-300' },
};

export function GitHubHealthPanel({
  spaceId,
  pollingCapabilityEnabled,
  webhooksCapabilityEnabled,
  disabled = false,
  refreshNonce,
  onAfterAction,
}: GitHubHealthPanelProps) {
  const [snapshot, setSnapshot] = useState<GitHubHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'poll' | 'reregister' | null>(null);
  const spaceIdRef = useRef(spaceId);
  spaceIdRef.current = spaceId;
  // Monotonic per-refresh generation so a slow, older same-space refresh cannot
  // overwrite a newer snapshot (which can race the mount and nonce effects, or
  // two overlapping manual refreshes).
  const refreshGenRef = useRef(0);
  // The parent always passes a numeric healthNonce, so the nonce effect would
  // fire on mount too — duplicating the spaceId effect's initial fetch (and the
  // parent's own getTokenStatus, i.e. 3 /user validations). Skip the first run.
  const skippedFirstNonceRef = useRef(false);

  async function refreshHealth(): Promise<void> {
    const refreshSpaceId = spaceIdRef.current;
    const refreshGen = ++refreshGenRef.current;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      setSnapshot(null);
      setError('Not connected to server');
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const result = await hub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: refreshSpaceId,
      });
      if (spaceIdRef.current !== refreshSpaceId || refreshGenRef.current !== refreshGen) return;
      setSnapshot(result);
      setError(null);
    } catch (err) {
      if (spaceIdRef.current !== refreshSpaceId || refreshGenRef.current !== refreshGen) return;
      setSnapshot(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (spaceIdRef.current === refreshSpaceId && refreshGenRef.current === refreshGen) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    // Drop the previous space's snapshot before fetching the new one so the
    // brief loading window cannot surface stale repos to the actions below
    // (re-register would otherwise target the old space's hooks against the
    // new spaceId). Manual Refresh calls refreshHealth() directly and skips
    // this clear to avoid a flash.
    setSnapshot(null);
    setError(null);
    void refreshHealth();
  }, [spaceId]);

  useEffect(() => {
    // Sibling settings mutated (token save, polling toggle, repo add/remove…).
    // Re-fetch without clearing the snapshot so the same-space refresh does not
    // flash. Skip the first invocation: the spaceId effect already fetched on
    // mount, and the parent always passes a numeric nonce, so firing here too
    // would duplicate the initial health RPC (and a redundant /user validation).
    if (!skippedFirstNonceRef.current) {
      skippedFirstNonceRef.current = true;
      return;
    }
    void refreshHealth();
  }, [refreshNonce]);

  async function pollNow(): Promise<void> {
    const actionSpaceId = spaceIdRef.current;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    try {
      setBusy('poll');
      const result = await hub.request<{ count: number }>('space.github.pollOnce', {
        spaceId: actionSpaceId,
      });
      if (spaceIdRef.current !== actionSpaceId) return;
      toast.success(`Poll complete: ${result.count} event(s) published`);
      await Promise.all([refreshHealth(), Promise.resolve(onAfterAction?.())]);
    } catch (err) {
      if (spaceIdRef.current !== actionSpaceId) return;
      toast.error(`Poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Always release the action lock: the same component instance is reused
      // across spaces, so skipping this on a mid-action navigation would leave
      // the new space's panel permanently disabled. Stale toasts/refresh are
      // already suppressed by the guards above.
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
    // Only re-register daemon-managed (auto-registered) hooks. autoConfigureWebhook
    // creates a fresh remote hook and replaces the stored secret, so running it on
    // a manually-configured repo would orphan the user's original hook behind a
    // secret the daemon no longer accepts. The snapshot must also belong to the
    // current space — a stale snapshot from a just-navigated-away space must not
    // contribute targets that would be reconfigured against the new spaceId.
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
      let succeeded = 0;
      let failed = 0;
      for (const target of targets) {
        try {
          await hub.request('space.github.autoConfigureWebhook', {
            spaceId: actionSpaceId,
            owner: target.owner,
            repo: target.repo,
          });
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
      await Promise.all([refreshHealth(), Promise.resolve(onAfterAction?.())]);
    } finally {
      setBusy(null);
    }
  }

  const status = snapshot ? deriveStatus(snapshot) : null;
  // Re-register targets are only valid when the snapshot belongs to the current
  // space; otherwise (e.g. while a new space's snapshot loads) the button stays
  // disabled so stale repos cannot be re-registered against the wrong space.
  const reregisterTargets =
    snapshot?.spaceId === spaceId
      ? (snapshot.repositories ?? []).filter((r) => r.webhookEnabled && r.webhookAutoRegistered)
          .length
      : 0;
  // Poll now requires a nonzero poll interval: 0 means polling is disabled
  // globally, and the server rejects a manual poll in that state too.
  const pollingIntervalEnabled = (snapshot?.polling.intervalMs ?? 0) > 0;
  // With no polling repositories a manual poll iterates nothing and reports a
  // misleading "0 events" success; keep the action disabled until one exists.
  const hasPollingRepos = (snapshot?.polling.pollingRepoCount ?? 0) > 0;
  // The server's poll guard skips every request while a rate-limit cooldown is
  // active, so Poll now would silently no-op; disable it until the window clears.
  const rateLimited = snapshot?.rateLimit.limited === true;

  return (
    <div
      class="rounded-lg border border-dark-700 bg-dark-800 px-3 py-3"
      data-testid="github-health-panel"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <div class="text-sm font-medium text-gray-200">GitHub integration health</div>
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
              busy !== null
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
              disabled || !webhooksCapabilityEnabled || reregisterTargets === 0 || busy !== null
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
        <div class="mt-3 flex items-center gap-2 py-2 text-xs text-gray-400">
          <Spinner size="sm" /> Loading integration health…
        </div>
      ) : error ? (
        <p class="mt-3 text-xs text-red-300">Failed to load health: {error}</p>
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
              <span class="text-gray-200">{snapshot.recentErrors.length}</span>
              {snapshot.recentErrors.length > 0 && (
                <span class="ml-2 text-gray-500">
                  latest {formatTimestamp(snapshot.recentErrors[0].updatedAt)}
                </span>
              )}
            </Metric>
          </dl>

          {(snapshot.webhook.errors.length > 0 || snapshot.recentErrors.length > 0) && (
            <div class="space-y-2 rounded-lg border border-white/10 bg-dark-850 px-3 py-2">
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
                    key: `err:${entry.deliveryKey}`,
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
    <div class="rounded-lg border border-white/10 bg-dark-850 px-3 py-2">
      <dt class="text-[11px] uppercase tracking-wider text-gray-500">{label}</dt>
      <dd class="mt-1 text-gray-200">{children}</dd>
    </div>
  );
}

function TokenStatusBadge({ snapshot }: { snapshot: GitHubHealthSnapshot }) {
  const { token } = snapshot;
  if (!token.configured) {
    // A credential-store read failure (vs. genuinely no token) is actionable —
    // surface it so the operator does not mistake a broken keychain for "none".
    return (
      <span>
        <span class="text-red-300">Not configured</span>
        {token.error && <div class="text-red-300">{token.error}</div>}
      </span>
    );
  }
  const sourceLabel = token.source === 'keychain' ? 'keychain' : 'env var';
  return (
    <span>
      <span class="text-gray-200">{token.login ?? 'configured'}</span>{' '}
      <span class="text-gray-500">({sourceLabel})</span>
      {token.error && <div class="text-red-300">{token.error}</div>}
    </span>
  );
}

function PollingStatus({ snapshot }: { snapshot: GitHubHealthSnapshot }) {
  const { polling } = snapshot;
  if (!polling.globallyEnabled || polling.intervalMs <= 0) {
    return <span class="text-gray-400">Disabled</span>;
  }
  return (
    <span>
      <span class="text-gray-200">{formatInterval(polling.intervalMs)}</span>{' '}
      <span class="text-gray-500">
        {polling.active ? 'active' : 'idle'}, {polling.pollingRepoCount} repo(s)
      </span>
      <div class="text-gray-500">last poll {formatTimestamp(polling.lastPollAt)}</div>
    </span>
  );
}

function RateLimitStatus({ snapshot }: { snapshot: GitHubHealthSnapshot }) {
  const { rateLimit } = snapshot;
  if (rateLimit.limited) {
    return (
      <span>
        <span class="text-yellow-300">Cooling down</span>{' '}
        <span class="text-gray-500">resets in {relativeFromNow(rateLimit.until)}</span>
      </span>
    );
  }
  if (rateLimit.remaining === null) {
    return <span class="text-gray-400">Unknown (no poll yet)</span>;
  }
  return (
    <span>
      <span class="text-gray-200">{rateLimit.remaining.toLocaleString()}</span>{' '}
      <span class="text-gray-500">remaining</span>
      {rateLimit.resetAt && (
        <div class="text-gray-500">resets in {relativeFromNow(rateLimit.resetAt)}</div>
      )}
    </span>
  );
}

function WebhookStatus({ snapshot }: { snapshot: GitHubHealthSnapshot }) {
  const { webhook } = snapshot;
  if (webhook.total === 0) return <span class="text-gray-400">No repositories</span>;
  return (
    <span>
      <span class="text-green-300">{webhook.active} active</span>
      {webhook.inactive > 0 && <span class="text-red-300"> · {webhook.inactive} inactive</span>}
      {webhook.unknown > 0 && <span class="text-gray-500"> · {webhook.unknown} unchecked</span>}
      <div class="text-gray-500">
        last webhook {formatTimestamp(webhook.lastWebhookAt)}
        {webhook.lastCheckedAt ? ` · checked ${relativeAgo(webhook.lastCheckedAt)}` : ''}
      </div>
    </span>
  );
}

function ReactionStatus({ snapshot }: { snapshot: GitHubHealthSnapshot }) {
  const { reactions } = snapshot;
  if (reactions.trackedPullRequests === 0) {
    return <span class="text-gray-400">No PRs tracked</span>;
  }
  return (
    <span>
      <span class="text-gray-200">{reactions.trackedPullRequests} PR(s)</span>{' '}
      <span class="text-gray-500">tracked</span>
      <div class="text-gray-500">last activity {formatTimestamp(reactions.lastActivityAt)}</div>
    </span>
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
      <div class="text-[11px] uppercase tracking-wider text-gray-500">{heading}</div>
      <ul class="mt-1 space-y-1">
        {rows.map((row) => (
          <li key={row.key} class="text-xs">
            <div class="truncate font-mono text-gray-300">{row.primary}</div>
            <div class="truncate text-red-300">
              {row.detail ?? 'unknown error'}
              {row.agent && <span class="text-gray-500"> · {row.agent}</span>}
            </div>
            {row.at && <div class="text-[11px] text-gray-500">{formatTimestamp(row.at)}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
