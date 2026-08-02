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
  /** True count of recent failed deliveries (recentErrors is capped at 5). */
  recentErrorTotal: number;
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
  /**
   * Notified when an in-panel action (poll now / re-register webhooks) starts or
   * finishes, so the parent can lock sibling repository mutations for the
   * duration. Re-registering a hook recreates the watched repo server-side; an
   * operator removing that target mid-flight could otherwise race the RPC and
   * resurrect the deleted watch.
   */
  onBusyChange?: (busy: 'poll' | 'reregister' | null) => void;
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
/** Cadence at which the panel silently re-fetches its snapshot while mounted, so
 * time-dependent badges (polling/reaction staleness, rate-limit cooldown expiry,
 * the recent-error window) can transition without an operator clicking Refresh. */
const HEALTH_REFRESH_INTERVAL_MS = 60 * 1000;
/** End-to-end timeout for a manual Poll now. Each repo fans out across PR/check-run/reaction endpoints (each allowed up to 30s) and repos run sequentially, so the default 10s RPC timeout would report Poll failed while the daemon keeps polling. Sized to cover realistic multi-repo polls; a truly unbounded fan-out (many repos, all requests simultaneously hung at the 30s cap) would need an async job protocol, tracked separately. */
const POLL_ONCE_TIMEOUT_MS = 5 * 60 * 1000;
/** Consecutive silent-refresh failures after which the retained snapshot is marked stale. */
const STALE_AFTER_SILENT_FAILURES = 3;
/** End-to-end timeout for a single webhook (re-)configure RPC. autoConfigureWebhook does a PATCH and possibly a replacement POST (each allowed up to 30s), so the default 10s RPC timeout would reject locally and release the bulk re-register lock while the daemon keeps configuring the hook. */
const WEBHOOK_CONFIGURE_TIMEOUT_MS = 90 * 1000;
/** A manual webhook's only liveness evidence is its last inbound delivery. Past
 * this window with no fresh delivery, treat the evidence as stale (Degraded, not
 * Healthy) so a silently-deleted/disabled hook is not badged live indefinitely. */
const WEBHOOK_EVIDENCE_STALE_MS = 30 * 24 * 60 * 60 * 1000;

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
  // The daemon computes staleness per-repo (one repo's fresh reactions cannot
  // mask another's) and reports the count here.
  return snapshot.reactions.staleRepoCount > 0;
}

function webhookEvidenceStale(snapshot: GitHubHealthSnapshot): boolean {
  // A webhook path whose liveness evidence has aged out. The strongest evidence
  // is a recent inbound delivery (lastWebhookAt); failing that, an auto-managed
  // hook's last remote active-check (webhookLastCheckedAt) still counts while
  // fresh. With neither, a silently-deleted/disabled hook would otherwise stay
  // badged Healthy indefinitely off stale evidence — flag Degraded so the
  // operator re-checks. Uses the snapshot's server timestamp, not the browser
  // clock. A repo with no evidence at all (freshly registered, awaiting a first
  // delivery/check) is not "stale" — it is handled by the webhookLive/down logic.
  return snapshot.repositories.some((r) => {
    if (!r.enabled || !r.webhookEnabled) return false;
    const lastCheck = r.webhookLastCheckedAt ?? null;
    if (r.lastWebhookAt === null && lastCheck === null) {
      // An unconfirmed (manual, webhookActive null) hook with no evidence at all
      // has never been proven to work — flag it so a mixed-mode Space (where
      // another path is healthy) does not read Healthy over an unverified
      // configured webhook. Auto hooks (webhookActive true) without evidence are
      // unusual and stay non-stale (handled by the webhookLive/down logic).
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
  // Polling is live when configured to run, at least one repo is accessible,
  // the token (if any) is not rejected, AND the last poll is reasonably fresh
  // (a stalled scheduled request leaves an ancient lastPollAt with no further
  // delivery). No token is fine for public repos; private repos without a token
  // surface as inaccessible via the poll-access tracking.
  const pollingLive =
    snapshot.polling.globallyEnabled &&
    snapshot.polling.intervalMs > 0 &&
    snapshot.polling.pollingRepoCount - snapshot.polling.inaccessibleRepoCount > 0 &&
    // Polling has actually delivered at least once (lastPollAt !== null). A
    // repo whose polls keep rate-limiting before any 200/304 never advances
    // lastPollAt; treating that as live would badge Healthy despite never
    // reaching the repo. (pollingIsStale's null fast-path alone is not enough.)
    snapshot.polling.lastPollAt !== null &&
    // Only a definitive credential rejection (HTTP 401/403) drops the polling
    // path to Down. A transient /user validation outage (timeout/network) sets
    // token.error (→ Degraded) but recent accessible polls may still prove the
    // credential works, so it must not flip a polling-only space to Down.
    !snapshot.token.authRejected &&
    !pollingIsStale(snapshot) &&
    // Every polling repo has actually delivered at least once. A multi-repo
    // cycle that rate-limited before visiting a later repo leaves it never-polled
    // (lastPollAt null, not inaccessible); the aggregate lastPollAt (max) would
    // otherwise mask it behind a fresh repo. (neverPolledRepoCount is per-repo.)
    snapshot.polling.neverPolledRepoCount === 0;
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
  if (!(pollingLive || webhookLive)) {
    // An active rate-limit cooldown (with a future reset) explains stale polling:
    // polls are paused for the cooldown, not broken. A polling-configured Space
    // under a long primary cooldown would otherwise flip to Down once lastPollAt
    // ages past the staleness window. Treat the known-recoverable cooldown as
    // Degraded — but ONLY for Spaces that actually use the polling path: the
    // cooldown is an API/polling concept and cannot explain or recover a broken
    // inbound webhook on a webhook-only Space (which must stay Down). Gates on
    // pollingRepoCount > 0, matching the token-error rule below.
    if (
      snapshot.rateLimit.limited &&
      // Polling must be ENABLED (not merely configured) to resume after the
      // cooldown: a 0 interval or disabled capability means polling cannot
      // recover, so the cooldown does not make a no-live-path Space recoverable.
      snapshot.polling.globallyEnabled &&
      snapshot.polling.intervalMs > 0 &&
      // The cooldown can only mask a freshness problem, not a definitive failure:
      // require an accessible, non-rejected polling path. A rejected token or
      // all-inaccessible repos stay Down — the cooldown cannot recover them.
      !snapshot.token.authRejected &&
      snapshot.polling.pollingRepoCount - snapshot.polling.inaccessibleRepoCount > 0
    ) {
      return 'degraded';
    }
    return 'down';
  }
  // Polling failure signals only count while polling is an active delivery path
  // (capability on + nonzero interval). When polling is disabled, cached
  // inaccessible/partial/stale/never-polled errors, reaction staleness, and
  // token errors must not degrade an otherwise-healthy webhook path.
  const pollingActive = snapshot.polling.globallyEnabled && snapshot.polling.intervalMs > 0;
  if (
    // The daemon-wide GitHub API cooldown only degrades Spaces that actually
    // use the polling path; a webhook-only Space's inbound deliveries do not
    // touch the API and keep working while it is rate-limited.
    (snapshot.rateLimit.limited && pollingLive) ||
    // Webhook-specific failure signals only count while webhook delivery is an
    // active path. When the capability is intentionally off, cached inactive
    // hooks / errors / stale evidence must not degrade a healthy polling path.
    (snapshot.webhook.deliveryEnabled &&
      (snapshot.webhook.inactive > 0 ||
        snapshot.webhook.errors.length > 0 ||
        // A webhook whose delivery/check evidence is now ancient.
        webhookEvidenceStale(snapshot))) ||
    (pollingActive &&
      (snapshot.polling.inaccessibleRepoCount > 0 ||
        snapshot.polling.partialErrorRepoCount > 0 ||
        // A polling repo whose last successful poll is now stale (skipped for
        // budget across cycles while another repo stayed fresh). Per-repo, so
        // the aggregate lastPollAt (max) cannot mask it.
        snapshot.polling.stalePollingRepoCount > 0 ||
        // A configured polling repo that has never reached GitHub — in a
        // mixed-mode Space the live webhook would otherwise hide a polling path
        // that has never worked.
        snapshot.polling.neverPolledRepoCount > 0 ||
        // Reaction polling persistently not observed despite tracked targets
        // (e.g. skipped for budget across many cycles).
        reactionsAreStale(snapshot) ||
        // A token validation error only matters for a Space that uses the GitHub
        // API for polling. Gate on polling being CONFIGURED (not pollingLive): a
        // mixed-mode Space whose polling auth is rejected has pollingLive false
        // but its polling/reaction path is still broken and should degrade.
        (Boolean(snapshot.token.error) && snapshot.polling.pollingRepoCount > 0))) ||
    snapshot.recentErrors.length > 0
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
  onBusyChange,
}: GitHubHealthPanelProps) {
  const [snapshot, setSnapshot] = useState<GitHubHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'poll' | 'reregister' | null>(null);
  // True between a sibling-settings mutation (refreshNonce bump) and the health
  // refresh committing. Re-register must not run against the pre-mutation
  // snapshot (it could recreate a just-removed repo's hook).
  const [snapshotStale, setSnapshotStale] = useState(false);
  const spaceIdRef = useRef(spaceId);
  spaceIdRef.current = spaceId;
  // Monotonic per-refresh generation so a slow, older same-space refresh cannot
  // overwrite a newer snapshot (which can race the mount and nonce effects, or
  // two overlapping manual refreshes).
  const refreshGenRef = useRef(0);
  // Count of in-flight foreground (non-silent) refreshes. A silent refresh
  // yields while one is active so it neither bumps the generation (which could
  // supersede the foreground and strand its loading flag) nor commits a possibly
  // staler lightweight result over the foreground's full validation.
  const foregroundInFlightRef = useRef(0);
  // The parent always passes a numeric healthNonce, so the nonce effect would
  // fire on mount too — duplicating the spaceId effect's initial fetch (and the
  // parent's own getTokenStatus, i.e. 3 /user validations). Skip the first run.
  const skippedFirstNonceRef = useRef(false);
  const silentFailuresRef = useRef(0);

  async function refreshHealth(silent = false): Promise<void> {
    // A silent (periodic) refresh yields to any in-flight foreground load: it
    // would otherwise share the generation and let a delayed lightweight result
    // overwrite the foreground's full validation (e.g. restore cached valid-token
    // state after a fresh rejection). Skip it entirely while one is active.
    if (silent && foregroundInFlightRef.current > 0) return;
    const refreshSpaceId = spaceIdRef.current;
    // Both foreground and silent refreshes bump the generation, so a delayed
    // older response (of either kind) can never overwrite a newer snapshot.
    const refreshGen = ++refreshGenRef.current;
    if (!silent) foregroundInFlightRef.current += 1;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      if (!silent) {
        foregroundInFlightRef.current = Math.max(0, foregroundInFlightRef.current - 1);
        setSnapshot(null);
        setError('Not connected to server');
        setLoading(false);
      } else {
        // A disconnected hub is the same as a failed refresh for staleness
        // purposes — the retained snapshot cannot be refreshed.
        silentFailuresRef.current += 1;
        if (silentFailuresRef.current >= STALE_AFTER_SILENT_FAILURES) {
          setSnapshotStale(true);
        }
      }
      return;
    }
    try {
      // A silent (periodic) refresh skips the loading flash and preserves the
      // last good snapshot on error so the badge does not blank out every
      // interval when the request transiently fails. It also passes
      // `lightweight` so the daemon reuses the cached token status instead of
      // issuing an authenticated /user call on every tick.
      if (!silent) setLoading(true);
      const result = await hub.request<GitHubHealthSnapshot>(
        'space.github.health',
        silent ? { spaceId: refreshSpaceId, lightweight: true } : { spaceId: refreshSpaceId }
      );
      if (spaceIdRef.current !== refreshSpaceId || refreshGenRef.current !== refreshGen) return;
      setSnapshot(result);
      setError(null);
      // A fresh snapshot resolves any post-mutation staleness.
      setSnapshotStale(false);
      silentFailuresRef.current = 0;
    } catch (err) {
      if (spaceIdRef.current !== refreshSpaceId || refreshGenRef.current !== refreshGen) return;
      // A silent refresh failure must not blank the retained snapshot or surface
      // an error that hides it — the whole point of the periodic refresh is to
      // keep the last good snapshot visible across transient failures. Only a
      // foreground (operator-initiated) failure replaces the error state.
      if (!silent) {
        setSnapshot(null);
        setError(err instanceof Error ? err.message : String(err));
      } else {
        // After several consecutive silent failures the retained snapshot is no
        // longer current evidence — mark it stale so the badge degrades rather
        // than showing a frozen Healthy indefinitely.
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
    // Mark the snapshot stale until the refresh commits so re-register cannot
    // target a just-removed repo from the pre-mutation snapshot (the nonce
    // refresh is async; without this the button stays enabled on stale targets).
    setSnapshotStale(true);
    void refreshHealth();
  }, [refreshNonce]);

  // Refresh the snapshot when an active rate-limit cooldown expires, so Poll now
  // re-enables and the badge updates without a manual Refresh. Both `until` and
  // the snapshot `timestamp` are daemon epochs, so their delta is the remaining
  // cooldown — avoiding a browser-clock subtraction that clock skew would
  // mis-time.
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

  // Periodically re-fetch the snapshot so time-dependent badges can transition
  // while the panel stays open. Without this, a snapshot loaded right after a
  // healthy poll stays frozen (both timestamp and lastPollAt fixed) and the
  // badge can never move Healthy → Down if scheduled polling subsequently
  // stalls. Silent so it does not flash the loader or blank the snapshot.
  useEffect(() => {
    if (busy) return;
    const id = setInterval(() => {
      void refreshHealth(true);
    }, HEALTH_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [busy, spaceId]);

  // Propagate the in-panel action lock to the parent so sibling repository
  // mutations (add/remove/reconfigure) are disabled for the duration.
  useEffect(() => {
    onBusyChange?.(busy);
    // Release the parent lock on unmount: a panel unmounted mid-action (e.g. the
    // global extension toggled off while busy) would otherwise leave panelBusy
    // true — the action's later setBusy(null) runs after unmount and cannot
    // notify. (Cleanup also runs on busy/callback change; the intermediate null
    // is batched with the following notification, so it never renders.)
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
      // Poll now fans out across many endpoints per repo (each allowed up to
      // 30s) and runs repos sequentially, so it can exceed the default 10s RPC
      // timeout. Pass an end-to-end timeout sized for the server operation so
      // the UI does not report Poll failed and release its lock while the daemon
      // is still polling.
      const result = await hub.request<{ count: number; skipped?: string }>(
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
      } else {
        toast.success(`Poll complete: ${result.count} event(s) published`);
      }
      // Refresh via exactly one path: the parent's onAfterAction bumps
      // healthNonce (which re-fetches the snapshot) and also reloads sibling
      // state; fall back to a direct refresh only when no callback is wired.
      // Avoids issuing two health RPCs (each with a /user validation) per poll.
      await (onAfterAction ? onAfterAction() : refreshHealth());
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
    // Do not re-register against a snapshot that predates a just-completed
    // sibling mutation (e.g. a Remove): the targets could include a deleted repo,
    // and autoConfigureWebhook would recreate its hook and watched row.
    if (snapshotStale) {
      toast.error('Refreshing after a change — try again in a moment');
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
          // Pass an end-to-end timeout sized for one PATCH + one POST so a slow
          // GitHub response does not reject locally and release the bulk
          // re-register lock while the daemon keeps configuring the hook.
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
      // Refresh via exactly one path: the parent's onAfterAction bumps
      // healthNonce (which re-fetches the snapshot) and also reloads sibling
      // state; fall back to a direct refresh only when no callback is wired.
      // Avoids issuing two health RPCs (each with a /user validation) per poll.
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
              <span class="text-gray-200">{snapshot.recentErrorTotal}</span>
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
                    // deliveryKey is only unique together with eventId; compose
                    // both so concurrent failures to the same target key distinctly.
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
  // When inbound delivery is globally disabled (capability off), the handler
  // rejects every delivery — the cached remote-hook count is not a live path,
  // so show a disabled state rather than green "active" counts.
  if (!webhook.deliveryEnabled) {
    return (
      <span>
        <span class="text-gray-400">Delivery disabled</span>
        <div class="text-gray-500">
          {webhook.active > 0
            ? `${webhook.active} hook(s) registered but not accepting events`
            : 'No active hooks'}
        </div>
      </span>
    );
  }
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
