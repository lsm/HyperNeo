import type { Database as BunDatabase } from '../../../storage/sqlite-compat';
import { createHash } from 'node:crypto';
import type { MessageHub } from '@hyperneo/shared';
import { Logger } from '../../logger';
import { isRateLimitError } from '../../space/runtime/rate-limit-detector';
import { type CredentialStore } from '../../credentials/credential-store.js';
import { verifySignature } from '../../github/webhook-handler';
import type {
  ExternalEventExtensionContext,
  HttpExternalEventExtension,
  RpcExternalEventExtension,
} from '../types';
import { ExternalEventStore } from '../external-event-store';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
import {
  checkRunAppKeyFrom,
  checkRunConclusionFrom,
  checkRunIdFrom,
  checkRunNameFrom,
  checkRunOccurredAt,
  isNonFailureConclusion,
} from './github-check-run-fields';
import {
  gitHubRepoPath,
  headRefKey,
  headRepoFromPullRequest,
  headShaFromPullRequest,
  parseHeadRefKey,
  pickPrNumbersByHeadSha,
  pullRequestNumberFrom,
} from './github-pr-head-ref';
import {
  addPullRequestNumberByHeadRef,
  removePullRequestNumberByHeadRef,
} from './github-pr-head-ref-index';
import { isPullRequestOpen, pullRequestUpdatedAt } from './github-pr-row-state';
import { isPositiveReaction, reactionIdFrom } from './github-reaction-fields';
import {
  normalizeGitHubCheckRun,
  normalizeGitHubDeployment,
  normalizeGitHubDeploymentStatus,
  normalizeGitHubPollingRow,
  normalizeGitHubReaction,
  normalizeGitHubStatus,
  normalizeGitHubWebhook,
  repoFromPayload,
  toExternalEvent,
  type GitHubPollingRepo,
} from './github-normalizer';
import {
  GitHubEventExtensionRepository,
  type GitHubWatchedRepo,
  type PollCursor,
} from './github-repository';

const log = new Logger('github-event-extension');
// 120s baseline: halves sustained GitHub API request rate vs 60s to stay
// safely below the undocumented secondary rate-limit ceiling. ETag 304s avoid
// primary quota but still count toward secondary rate limits.
const DEFAULT_POLL_INTERVAL_MS = 120_000;
const GITHUB_API_BASE = 'https://api.github.com';
const REACTION_POLL_PR_LIMIT = 10;
const REACTION_POLL_RATE_LIMIT_FLOOR = 100;
/**
 * When the rate-limit `remaining` counter drops to or below this threshold,
 * polling is deferred until the reset epoch. Keeps a safety margin so the
 * extension cannot exhaust the budget on rapid poll cycles.
 */
const RATE_LIMIT_LOW_REMAINING_THRESHOLD = 10;
/** Minimum backoff applied when scheduling the next poll after rate-limit detection. */
const RATE_LIMIT_MIN_BACKOFF_MS = 60_000;
/**
 * A terminal delivery failure only counts toward the health rollup's
 * `recentErrors` (and thus the Degraded badge) while it is within this window.
 * The full, unbounded delivery log remains available for diagnostics; this only
 * bounds the health snapshot so one old failure cannot flag the space forever.
 */
const HEALTH_RECENT_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Upper bound on the /user token-validation request when assembling the health
 * snapshot. A stalled validation must not block every other metric (and thus
 * the whole panel); on timeout the snapshot reports the token with an error
 * instead of hanging indefinitely.
 */
const TOKEN_VALIDATION_TIMEOUT_MS = 5_000;
/** Max age of a cached token status reused by lightweight health refreshes. A PAT revoked/expired on GitHub (no local setToken/clearToken) would otherwise be served from cache forever; this bounds the staleness without returning to one /user per minute. */
const TOKEN_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * Upper bound on a single GitHub API request during polling (repo endpoints,
 * check-runs, reactions). A request that never settles (network stall) must
 * expire so the cycle completes, subsequent cycles can run, and the failed
 * fetch is recorded as a partial/inaccessible error instead of leaving the
 * polling path silently live with a null lastPollAt. Generous enough for
 * legitimate paginated responses.
 */
const GITHUB_POLL_REQUEST_TIMEOUT_MS = 30_000;
/** Per-request cap for GitHub webhook-management API calls (PATCH/POST/GET/DELETE hooks). Bounds the server side of autoConfigureWebhook/checkWebhook so the client RPC timeout reflects a real upper bound (a stalled request aborts instead of hanging indefinitely). */
const GITHUB_WEBHOOK_REQUEST_TIMEOUT_MS = 30_000;
/**
 * Upper bound on a single ref/sha → PR resolution call made while handling a
 * deployment/deployment_status webhook. GitHub marks a delivery failed if it
 * gets no 2xx within ~10s, so the per-call cap must stay well under that — a
 * deployment makes up to two sequential calls (commit-SHA, then ref), so the
 * two together must fit the same ~10s delivery budget. (GitHub does NOT
 * auto-redeliver; a timeout surfaces as 503 so the failed delivery stays
 * visible and eligible for manual/scripted redelivery rather than being
 * silently accepted as 202. The external-event dedupe layer then absorbs the
 * duplicate if a redelivery is later replayed.)
 */
const DEPLOYMENT_PR_RESOLUTION_TIMEOUT_MS = 5_000;
/**
 * A repo's reaction polling is "stale" once its last observed reaction activity
 * is older than this many poll intervals (floored so short intervals do not
 * flap sub-minute). Per-repo so one repo's fresh reactions cannot mask another
 * repo's staleness in the aggregate.
 */
const REACTION_STALE_INTERVALS = 3;
const REACTION_STALE_MIN_MS = 5 * 60 * 1000;
const COMMENT_ENDPOINT_INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Parsed GitHub rate-limit state from response headers.
 *
 * - `remaining`: requests left in the current window (`Infinity` when the
 *   header is absent — the request was likely served from a non-rate-limited
 *   path such as an ETag hit).
 * - `resetAt`: wall-clock epoch (ms) when the window resets. GitHub returns
 *   this as seconds; multiplied to ms internally. `0` when missing.
 * - `limited`: true when the response status is 403/429. Used to defer
 *   subsequent polls even when `remaining` was not provided.
 * - `retryAfter`: true when `resetAt` was derived from a `Retry-After` header.
 *   When true, callers should honor the exact `resetAt` delay without flooring
 *   to the minimum backoff (secondary limits use short Retry-After values).
 */
export interface GitHubRateLimitInfo {
  remaining: number;
  resetAt: number;
  limited: boolean;
  retryAfter: boolean;
}

/**
 * Parses rate-limit headers from a GitHub API response.
 *
 * Headers are optional — GitHub does not always send them (e.g., 304 Not Modified
 * responses lack rate-limit headers). When absent, `remaining` is `Infinity`
 * and `resetAt` is `0`, so callers can treat the response as "unlimited" and
 * fall back to the configured poll interval.
 *
 * `limited` requires rate-limit evidence, not just a 403/429 status: GitHub
 * also returns 403 for permission/auth failures. We treat the response as
 * rate-limited only when either (a) the status is 429, or (b) the status is
 * 403 AND the `X-RateLimit-Remaining` header is present and equals 0. A bare
 * 403 with missing/positive remaining (e.g. `Resource not accessible by
 * integration`) is not classified as rate-limiting so a permission error is
 * not hidden behind a backoff.
 *
 * `resetAt` prefers `Retry-After` (used for secondary rate limits) over
 * `X-RateLimit-Reset` when both are present, per GitHub's guidance.
 */
export function parseRateLimitHeaders(res: Response): GitHubRateLimitInfo {
  const remainingRaw = res.headers.get('X-RateLimit-Remaining');
  const resetRaw = res.headers.get('X-RateLimit-Reset');
  const retryAfterRaw = res.headers.get('Retry-After');
  const remaining = remainingRaw ? parseInt(remainingRaw, 10) : Number.NaN;
  const resetSeconds = resetRaw ? parseInt(resetRaw, 10) : Number.NaN;
  const retryAfterSeconds = retryAfterRaw ? parseInt(retryAfterRaw, 10) : Number.NaN;
  const remainingValue = Number.isNaN(remaining) ? Infinity : remaining;
  const hasRetryAfter = !Number.isNaN(retryAfterSeconds);
  // 429 is always rate-limit; 403 is rate-limit when remaining=0 OR Retry-After present.
  const limited =
    res.status === 429 || (res.status === 403 && (remainingValue === 0 || hasRetryAfter));
  // Retry-After wins when present (seconds from now). Otherwise use the
  // X-RateLimit-Reset epoch.
  const resetAt = !Number.isNaN(retryAfterSeconds)
    ? Date.now() + retryAfterSeconds * 1000
    : Number.isNaN(resetSeconds)
      ? 0
      : resetSeconds * 1000;
  return {
    remaining: remainingValue,
    resetAt,
    limited,
    retryAfter: hasRetryAfter,
  };
}
/**
 * Distinct credential-store namespace for the GitHub event extension's PAT.
 * Deliberately separate from `credentialService('github')`
 * (`neokai.provider.github`) so a user-created provider whose `providerId`
 * is 'github' cannot collide with the extension's secret (each would
 * corrupt the other's payload).
 */
const GITHUB_CREDENTIAL_SERVICE = 'neokai.external-events.github';
const GITHUB_CREDENTIAL_ACCOUNT = 'default';
const WEBHOOK_EVENTS = [
  'push',
  'pull_request',
  'issue_comment',
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request_review_thread',
  'check_run',
  'status',
  'check_suite',
  'deployment',
  'deployment_status',
  'branch_protection_rule',
  // App-only webhook (spec #2320 row 6): GitHub delivers merge_group only via
  // App webhooks, never repo/org. Included so an app-webhook-configured hook
  // requests it; excluded from REQUIRED_WEBHOOK_EVENTS because repo-webhook users
  // can never receive it (otherwise the health panel flags it missing for all).
  'merge_group',
];
// GitHub does not send issue/PR webhooks for reactions on the PR itself.
// Codex approval reactions are therefore polling-only via /issues/{number}/reactions.
// `push` carries no PR signal; `merge_group` is app-only and undeliverable for
// repo-webhook users, so neither counts toward health-completeness. The other
// webhook events (incl. branch_protection_rule / deployment*) ARE deliverable
// via repo webhooks and stay required.
const REQUIRED_WEBHOOK_EVENTS = WEBHOOK_EVENTS.filter(
  (event) => event !== 'push' && event !== 'merge_group'
);
// Events actually requestable on a REPOSITORY hook. App-only events
// (`merge_group`) are excluded — GitHub rejects them on repo hooks (422) and
// never delivers them there. `merge_group` stays in WEBHOOK_EVENTS above so the
// normalizer handles it and so a future app-webhook delivery path can request
// it; it just must not be sent to the repo-hook API (createRemoteWebhook /
// updateRemoteWebhook).
const REPO_HOOK_WEBHOOK_EVENTS = WEBHOOK_EVENTS.filter((event) => event !== 'merge_group');
const WEBHOOK_PATH = '/webhook/github/space';

interface GitHubEventExtensionOptions {
  pollIntervalMs?: number;
  getPollIntervalMs?: () => number | undefined;
  fetchImpl?: typeof fetch;
  /**
   * Optional credential store used to persist the GitHub PAT outside env vars.
   * When provided, the extension reads the token from the store first and
   * falls back to the constructor-supplied env value.
   */
  credentialStore?: CredentialStore;
  /**
   * Optional reactive-database handle forwarded to the ExternalEventStore so
   * its raw-SQL writes notify LiveQuery consumers (e.g. task timelines).
   */
  reactiveDb?: ReactiveDatabase;
  /**
   * Run a best-effort reconciliation sweep over daemon-managed hooks on
   * `start()`, PATCHing any that are missing required events so existing
   * installations adopt new WEBHOOK_EVENTS types without a manual
   * re-registration. Defaults off so unit tests (which construct the extension
   * with a token and watched repos) don't fire background API calls; the daemon
   * enables it via app.ts. `checkWebhook` self-heals regardless of this flag.
   */
  autoReconcileWebhooks?: boolean;
}

interface GitHubTokenStatus {
  configured: boolean;
  source: 'keychain' | 'env' | 'none';
  login?: string;
  error?: string;
  /**
   * True only when the credential is definitively rejected by GitHub
   * (HTTP 401/403 from /user). A transient validation failure (timeout,
   * network error) sets `error` but not this flag — recent accessible polls
   * may still prove the credential works, so only a definitive rejection
   * should drop the polling path from live to Down.
   */
  authRejected?: boolean;
  autoRegisteredHookCount?: number;
  /** Fingerprint of the token that was actually validated (bound to the validation, not a separate read). */
  validatedFingerprint?: string;
}

interface GitHubHookResponse {
  id: number;
  active: boolean;
  events?: string[];
  config?: {
    url?: string;
    content_type?: string;
  };
}

/**
 * The merge-blocking event ingest paths surfaced in the health panel (spec
 * #2320 rows 1/2/4/5/6/7). The `mergeStateStatus` poller (row 3, #2323) is a
 * separate source that has not landed yet, so it is intentionally absent here
 * — surfacing it before the source exists would be dead UI over no data.
 */
export type GitHubHealthEventTypeKey =
  | 'status'
  | 'review_thread'
  | 'deployment'
  | 'check_suite'
  | 'merge_group'
  | 'branch_protection';

/** Surfaced event types in display order, with their operator-facing labels. */
const GITHUB_HEALTH_EVENT_TYPES: ReadonlyArray<{ key: GitHubHealthEventTypeKey; label: string }> = [
  { key: 'status', label: 'Commit status' },
  { key: 'review_thread', label: 'Review threads' },
  { key: 'deployment', label: 'Deployments' },
  { key: 'check_suite', label: 'Check suites' },
  { key: 'merge_group', label: 'Merge queue' },
  { key: 'branch_protection', label: 'Branch protection' },
];

/**
 * Maps a topic-action suffix (the segment after the final `.`) to one of the
 * surfaced event types. `deployment` rolls up both `deployment_created` and the
 * state-bearing `deployment_status_*` actions (spec row 4 covers both). Any
 * suffix not listed here is an older/other ingest path (issue comments, generic
 * pull_request actions, …) and is intentionally left out of this breakdown.
 *
 * `merge_group` also rolls up the `pull_request` `.enqueued` / `.dequeued`
 * topics (spec row 8): `merge_group` is an app-only webhook undeliverable over a
 * repo/org hook (excluded from REPO_HOOK_WEBHOOK_EVENTS), so for the common
 * PAT/repo-webhook installation those queue-transition topics are the only
 * merge-queue signal that ever arrives. Without them the "Merge queue" row would
 * read zero even while queue traffic is being ingested.
 */
const TOPIC_SUFFIX_TO_HEALTH_TYPE: Record<string, GitHubHealthEventTypeKey> = {
  status_pending: 'status',
  status_success: 'status',
  status_failure: 'status',
  status_error: 'status',
  thread_resolved: 'review_thread',
  thread_unresolved: 'review_thread',
  deployment_created: 'deployment',
  deployment_status_success: 'deployment',
  deployment_status_failure: 'deployment',
  deployment_status_error: 'deployment',
  deployment_status_in_progress: 'deployment',
  deployment_status_queued: 'deployment',
  deployment_status_pending: 'deployment',
  suite_failed: 'check_suite',
  merge_group_checks_requested: 'merge_group',
  merge_group_destroyed: 'merge_group',
  // Repo-webhook fallback for the app-only merge_group webhook (spec row 8).
  enqueued: 'merge_group',
  dequeued: 'merge_group',
  branch_protection_created: 'branch_protection',
  branch_protection_edited: 'branch_protection',
  branch_protection_deleted: 'branch_protection',
};

/**
 * Per-repository rollup included in {@link GitHubHealthSnapshot}. Mirrors the
 * fields an operator needs to triage a single repo at a glance without paging
 * through the full watched-repo list.
 */
export interface GitHubHealthRepoSummary {
  owner: string;
  repo: string;
  enabled: boolean;
  webhookEnabled: boolean;
  webhookActive: boolean | null;
  /**
   * True when the remote hook is daemon-managed (created via
   * autoConfigureWebhook). Bulk re-registration only targets these rows so a
   * manually-configured hook is not orphaned behind a replaced secret.
   */
  webhookAutoRegistered: boolean;
  pollingEnabled: boolean;
  lastWebhookAt: number | null;
  webhookLastCheckedAt: number | null;
  lastPollAt: number | null;
  webhookLastError: string | null;
  /** Set when the last poll cycle could not reach this repo (e.g. 403/404). */
  lastPollError: string | null;
  /**
   * Set when the last cycle reached some endpoints but a later required one
   * failed (partial access); cleared on a fully successful or fully failed
   * cycle. Partial traffic still publishes, so this is Degraded, not Down.
   */
  lastPartialPollError: string | null;
  /** Number of open PRs currently tracked for reaction polling in this repo. */
  reactionTrackedPullRequests: number;
}

/**
 * Consolidated health snapshot returned by the `space.github.health` RPC.
 *
 * Aggregates token availability, polling configuration, the current rate-limit
 * window, webhook registration status, reaction-polling freshness, recent
 * delivery failures, and a per-repo rollup into a single response so operators
 * have one place to verify the GitHub event subsystem is healthy. Timestamps are
 * wall-clock epoch milliseconds; `null` means "never".
 */
export interface GitHubHealthSnapshot {
  source: 'github';
  spaceId: string;
  /** When the snapshot was assembled. */
  timestamp: number;
  token: GitHubTokenStatus;
  polling: {
    /** Global capability + globallyEnabled both on. */
    globallyEnabled: boolean;
    /** Resolved poll interval in ms (0 = polling disabled). */
    intervalMs: number;
    /** A poll timer is currently armed and the extension is running. */
    active: boolean;
    /** Count of enabled + polling-configured repos in this space. */
    pollingRepoCount: number;
    /**
     * Polling-configured repos whose last poll cycle could not access the repo
     * (e.g. a valid-but-unauthorized PAT). Such a repo cannot publish, so the
     * health badge only treats polling as live when some repo is accessible.
     */
    inaccessibleRepoCount: number;
    /**
     * Polling-configured repos whose last cycle reached some endpoints but
     * not others (e.g. a fine-grained PAT with issue-comment but no
     * pull-request access). They still publish partial traffic, so they are a
     * live path but a Degraded signal rather than Down.
     */
    partialErrorRepoCount: number;
    /**
     * Polling-configured repos that have never successfully reached GitHub
     * (lastPollAt null, not flagged inaccessible) — e.g. a multi-repo cycle that
     * rate-limited before visiting them. Per-repo so one repo's fresh poll
     * cannot mask another that has never observed events.
     */
    neverPolledRepoCount: number;
    /**
     * Polling repos whose last successful poll (non-null lastPollAt) is now past
     * the staleness window — e.g. skipped for budget across several cycles while
     * another repo stayed fresh. Per-repo so the aggregate lastPollAt (max)
     * cannot mask a stale repo behind a fresh one.
     */
    stalePollingRepoCount: number;
    /** Most recent successful poll across this space's repos. */
    lastPollAt: number | null;
  };
  rateLimit: {
    /** True while inside an active cooldown (`now < until`). */
    limited: boolean;
    /** Epoch ms until which polling is deferred; 0 when no cooldown is active. */
    until: number;
    /** Cooldown derived from a Retry-After (secondary) limit. */
    fromRetryAfter: boolean;
    /** Remaining requests in the current window; null when never observed. */
    remaining: number | null;
    /** Epoch ms when the window resets; null when unknown/never observed. */
    resetAt: number | null;
    /** Epoch ms of the last rate-limit observation; 0 when never observed. */
    observedAt: number;
  };
  webhook: {
    total: number;
    /** Repos with webhook delivery enabled. */
    configured: number;
    active: number;
    inactive: number;
    /** Repos whose remote hook status has never been checked. */
    unknown: number;
    /**
     * Whether inbound webhook delivery is globally enabled (source globally on
     * AND the webhooks capability not disabled). When false the handler rejects
     * every delivery, so active hooks are not a working path regardless of count.
     */
    deliveryEnabled: boolean;
    lastWebhookAt: number | null;
    lastCheckedAt: number | null;
    errors: Array<{ owner: string; repo: string; error: string; at: number | null }>;
  };
  reactions: {
    /** Total open PRs tracked for reaction polling across this space. */
    trackedPullRequests: number;
    /** Most recent poll among repos tracking reactions; null if none. */
    lastActivityAt: number | null;
    /**
     * Count of polling repos that track reaction targets but whose reactions
     * are stale (never succeeded, or last observed past the freshness window).
     * Per-repo so one repo's fresh reactions cannot mask another's staleness.
     */
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
  /**
   * Recent ingestion activity for the merge-blocking event paths the panel
   * surfaces (spec #2320 rows 1/2/4/5/6/7), each over the same recency window
   * as {@link recentErrors}. One entry per surfaced type (count 0 / lastAt null
   * when none observed in the window) so the panel can render a stable layout.
   * The mergeStateStatus poller (row 3) is tracked separately (#2323) and is
   * omitted until that source lands.
   */
  eventTypes: Array<{
    type: GitHubHealthEventTypeKey;
    label: string;
    /** Events of this type ingested within the recency window. */
    count: number;
    /** Most recent `ingested_at` of this type in the window; null if none. */
    lastAt: number | null;
  }>;
  repositories: GitHubHealthRepoSummary[];
}

export class GitHubEventExtension implements HttpExternalEventExtension, RpcExternalEventExtension {
  readonly sourceId = 'github';
  readonly routes = [
    {
      method: 'POST',
      path: '/webhook/github/space',
      handle: (req: Request, _context: ExternalEventExtensionContext) => this.handleWebhook(req),
    },
  ] as const;

  readonly repo: GitHubEventExtensionRepository;
  private context?: ExternalEventExtensionContext;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private activePollCycle?: Promise<void>;
  /**
   * In-flight startup reconciliation sweep (if any). Tracked so `stop()` can await
   * it: the sweep's `stopped` guard only fires between hooks, so an in-flight
   * GET/PATCH can still be underway when the source is disabled. Prevents
   * post-stop remote mutations and health writes (incl. after the DB closes).
   */
  private reconcileSweepPromise?: Promise<void>;
  /**
   * Promise chain serializing all poll execution (scheduled + manual). Each
   * runExclusivePoll call chains onto the tail, so queued callers never wake
   * together (unlike a shared-flag await) — at most one poll runs at a time.
   */
  private pollQueue: Promise<unknown> = Promise.resolve();
  private stopped = true;
  /**
   * Per-remote-hook promise chains serializing webhook (re-)configuration, keyed
   * by `${owner}/${repo}`. Two Spaces sharing one auto-managed hook can invoke
   * re-registration concurrently; without per-hook serialization each call
   * generates its own secret and PATCHes the same hook, and the remote mutation
   * + DB write can complete out of order — leaving the DB with one secret while
   * GitHub retains the other, so deliveries fail signature verification. Entries
   * are removed once idle so the map cannot grow unbounded.
   */
  private webhookConfigQueues = new Map<string, Promise<void>>();
  /**
   * Wall-clock epoch (ms) until which polling is deferred because GitHub
   * returned a rate-limit response or the `remaining` budget dropped below
   * the safety threshold. `0` means no deferral is active. Set by
   * `applyRateLimit()`, consulted by `pollEnabledSpaces()` and
   * `runPollCycle()` so the next poll is scheduled after the reset window.
   */
  private rateLimitedUntil = 0;
  /**
   * True when the active cooldown was derived from a `Retry-After` header.
   * Retry-After values may be shorter than the minimum backoff and should be
   * honored exactly rather than floored to `RATE_LIMIT_MIN_BACKOFF_MS`.
   */
  private rateLimitedFromRetryAfter = false;
  /**
   * Most recent rate-limit snapshot observed during a poll cycle (the merged
   * `latestRateLimit` value, preserving a finite `remaining` across 304s).
   * Exposed via `buildHealthSnapshot` for the integration health panel.
   * `undefined` until the first poll observes rate-limit headers.
   */
  private lastRateLimitInfo?: GitHubRateLimitInfo;
  /** Wall-clock epoch (ms) when `lastRateLimitInfo` was last updated; 0 if never. */
  private lastRateLimitObservedAt = 0;
  /** Fingerprint of the credential whose cooldown is stored in rateLimitedUntil. */
  private lastRateLimitFingerprint?: string;
  /**
   * Cached token status reused by lightweight (periodic) health refreshes so an
   * open panel does not trigger an authenticated /user request on every refresh
   * cycle. Keyed by `credentialGeneration` so a setToken/clearToken invalidates
   * it immediately; only stable results (success or a definitive rejection) are
   * cached so a transient validation blip is re-checked, not served repeatedly.
   */
  private lastTokenStatus: GitHubTokenStatus | null = null;
  private lastTokenStatusGeneration = -1;
  private lastTokenStatusAt = 0;
  /**
   * Monotonic counter bumped whenever the effective credential changes
   * (setToken/clearToken). A poll cycle captures the value at its start and
   * discards its own rate-limit observations if the credential changed under
   * it, so a replaced/cleared PAT does not get its quota/cooldown restored by a
   * slow, obsolete in-flight cycle.
   */
  private credentialGeneration = 0;
  /** Credential generation captured at the start of the current poll cycle. */
  private pollCycleCredentialGeneration: number | null = null;
  /** Fingerprint of the credential that started the current poll cycle. */
  private pollCycleCredentialFingerprint: string | null = null;
  /** Whether the current poll cycle reached at least one 200/304 endpoint. */
  private pollCycleAccessible = false;
  private readonly credentialStore?: CredentialStore;
  private readonly eventStore: ExternalEventStore;

  constructor(
    db: BunDatabase,
    private readonly githubToken = process.env.GITHUB_TOKEN,
    private readonly options: GitHubEventExtensionOptions = {}
  ) {
    this.repo = new GitHubEventExtensionRepository(db);
    this.eventStore = new ExternalEventStore(db, options.reactiveDb);
    this.credentialStore = options.credentialStore;
  }

  async start(context: ExternalEventExtensionContext): Promise<void> {
    this.context = context;
    this.stopped = false;
    // Best-effort, non-blocking: bring existing daemon-managed hooks into sync
    // with the current repo-hook event set (REPO_HOOK_WEBHOOK_EVENTS — e.g. a
    // new event type added since the hook was registered; app-only events are
    // excluded). Never blocks or fails startup; per-repo errors are logged and
    // skipped inside the sweep. Opt-in (app.ts) so unit tests don't fire
    // background API calls.
    if (this.options.autoReconcileWebhooks) {
      this.reconcileSweepPromise = this.reconcileManagedWebhooks()
        .catch((error) => {
          log.warn('GitHub webhook reconciliation sweep failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.reconcileSweepPromise = undefined;
        });
    }
    if (!(await this.isPollingGloballyEnabled()) || this.getPollIntervalMs() <= 0) return;
    this.scheduleNextPoll();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    await this.activePollCycle;
    // Let any in-flight reconciliation sweep reach its next `stopped` check (or
    // finish) before returning — the guard only fires between hooks, so a
    // GET/PATCH can still be underway when the source is disabled.
    if (this.reconcileSweepPromise) await this.reconcileSweepPromise;
  }

  registerRpcHandlers(hub: MessageHub, context: ExternalEventExtensionContext): void {
    hub.onRequest('space.github.enable', async (data) => {
      await assertRpcConfigEnabled(context, this.sourceId);
      const params = data as { spaceId: string };
      if (!params.spaceId) throw new Error('spaceId is required');
      const willReenablePollingRows = this.repo
        .listWatchedRepos(params.spaceId)
        .some((repo) => repo.pollingEnabled);
      this.repo.setRepoEnabled(params.spaceId, true);
      // Re-enabling a space can revive polling-configured rows whose
      // `enabled` flag was just flipped back on. If the global polling
      // capability was cleared while the space was disabled (see
      // disablePollingCapabilityIfUnused), the timer would never restart
      // on its own. Re-arm the capability + timer here only when polling is
      // globally enabled; interval=0 should still allow webhook delivery to
      // resume for the space without re-enabling polling.
      if (willReenablePollingRows && this.getPollIntervalMs() > 0) {
        await this.enablePollingCapability(context);
        this.ensurePollingActive();
      }
      await this.persistSpaceConfig(context, params.spaceId);
      context.onSourceConfigChanged({
        source: this.sourceId,
        spaceId: params.spaceId,
        kind: 'space_enabled',
      });
      return { spaceId: params.spaceId, source: this.sourceId, enabled: true };
    });

    hub.onRequest('space.github.disable', async (data) => {
      await assertRpcConfigEnabled(context, this.sourceId);
      const params = data as { spaceId: string };
      if (!params.spaceId) throw new Error('spaceId is required');
      this.repo.setRepoEnabled(params.spaceId, false);
      await this.persistSpaceConfig(context, params.spaceId);
      context.onSourceConfigChanged({
        source: this.sourceId,
        spaceId: params.spaceId,
        kind: 'space_disabled',
      });
      return { spaceId: params.spaceId, source: this.sourceId, enabled: false };
    });

    hub.onRequest('space.github.watchRepo', async (data) => {
      await assertRpcConfigEnabled(context, this.sourceId);
      const params = data as {
        spaceId: string;
        owner: string;
        repo: string;
        webhookSecret?: string;
        webhookEnabled?: boolean;
        pollingEnabled?: boolean;
        enabled?: boolean;
      };
      if (!params.spaceId || !params.owner || !params.repo) {
        throw new Error('spaceId, owner and repo are required');
      }
      const existingForValidation = this.repo.getWatchedRepo(
        params.spaceId,
        params.owner,
        params.repo
      );
      if (params.pollingEnabled && !existingForValidation?.pollingEnabled) {
        this.assertPollingIntervalEnabled();
      }
      const upsertParams = {
        spaceId: params.spaceId,
        owner: params.owner,
        repo: params.repo,
        webhookSecret: params.webhookSecret,
        webhookEnabled: params.webhookEnabled,
        pollingEnabled: params.pollingEnabled,
        enabled: params.enabled,
      };
      // Run the whole transition under the per-hook lock and RE-READ the row
      // inside the callback. `existing` captured before the lock waited could be
      // stale if a prior queued op replaced the hook (H1→H2); operating on the
      // captured row would delete the stale H1 and orphan H2. The validation read
      // above is a best-effort precondition; the mutation reads the current row.
      const watchedRepo = await this.runExclusiveWebhookConfig(
        params.owner,
        params.repo,
        async (): Promise<GitHubWatchedRepo> => {
          const existing = this.repo.getWatchedRepo(params.spaceId, params.owner, params.repo);
          const replacingAutoSecret = Boolean(
            params.webhookSecret && existing?.webhookAutoRegistered
          );
          const disablingAutoWebhook = Boolean(
            existing?.webhookAutoRegistered &&
              existing.webhookEnabled &&
              params.webhookEnabled === false
          );
          // A manual webhook secret rotation — re-adding an existing manually
          // configured repo with a different secret — invalidates deliveries
          // signed with the previous secret. Auto-registered repos rotate their
          // secret via clearWebhookRegistration below.
          const manualSecretRotated =
            existing != null &&
            Boolean(params.webhookSecret) &&
            !existing.webhookAutoRegistered &&
            existing.webhookSecret !== params.webhookSecret;
          if ((replacingAutoSecret || disablingAutoWebhook) && existing?.webhookRemoteId) {
            await this.deleteRemoteWebhookIfUnshared(existing);
          }
          let w = this.repo.upsertWatchedRepo(upsertParams);
          if (replacingAutoSecret || disablingAutoWebhook) {
            this.repo.clearWebhookRegistration(w.id, { clearSecret: disablingAutoWebhook });
            w = this.repo.getWatchedRepoById(w.id) ?? w;
          }
          if (manualSecretRotated) {
            this.repo.clearWebhookDeliveryHistory(w.id);
            w = this.repo.getWatchedRepoById(w.id) ?? w;
          }
          return w;
        }
      );
      if (watchedRepo.pollingEnabled) {
        // Persist the user's intent to use polling in this space whenever a
        // repo is added/updated with polling enabled. This keeps the connection
        // card checkbox and the no-secret addRepo default consistent even if
        // the row is later removed.
        this.repo.setPollingIntent(params.spaceId, true);
        await this.persistSpaceConfig(context, watchedRepo.spaceId);
        if (this.getPollIntervalMs() > 0) {
          await this.enablePollingCapability(context);
          this.ensurePollingActive();
        }
      } else {
        // Per-row polling was turned off (or the row was added without
        // polling). If the user explicitly disabled the last polling-configured
        // row in this space, clear the per-space intent so the global
        // capability and UI checkbox reflect reality. Adding a non-polling row
        // to a space with intent=true does not clear it.
        if (
          existingForValidation?.pollingEnabled &&
          this.repo.listAllPollingConfiguredRepos(params.spaceId).length === 0
        ) {
          this.repo.setPollingIntent(params.spaceId, false);
        }
        await this.persistSpaceConfig(context, watchedRepo.spaceId);
        await this.disablePollingCapabilityIfUnused(context);
        this.maybeStopPolling();
      }
      context.onSourceConfigChanged({
        source: this.sourceId,
        spaceId: watchedRepo.spaceId,
        kind: 'watched_repo_changed',
      });
      return {
        watchedRepo: this.sanitizeWatchedRepo(watchedRepo),
        webhookUrl: '/webhook/github/space',
      };
    });

    hub.onRequest('space.github.autoConfigureWebhook', async (data) => {
      await assertRpcConfigEnabled(context, this.sourceId);
      await assertWebhookCapabilityEnabled(context, this.sourceId);
      const params = data as {
        spaceId?: string;
        owner?: string;
        repo?: string;
      };
      if (!params.spaceId || !params.owner || !params.repo) {
        throw new Error('spaceId, owner and repo are required');
      }
      const watchedRepo = await this.autoConfigureWebhook({
        spaceId: params.spaceId,
        owner: params.owner,
        repo: params.repo,
      });
      await this.persistSpaceConfig(context, watchedRepo.spaceId);
      context.onSourceConfigChanged({
        source: this.sourceId,
        spaceId: watchedRepo.spaceId,
        kind: 'watched_repo_changed',
      });
      return {
        watchedRepo: this.sanitizeWatchedRepo(watchedRepo),
        webhookUrl: watchedRepo.webhookUrl,
      };
    });

    hub.onRequest('space.github.checkWebhook', async (data) => {
      await assertRpcConfigEnabled(context, this.sourceId);
      await assertWebhookCapabilityEnabled(context, this.sourceId);
      const params = data as { spaceId?: string; owner?: string; repo?: string };
      if (!params.spaceId || !params.owner || !params.repo) {
        throw new Error('spaceId, owner and repo are required');
      }
      const watchedRepo = await this.checkWebhook(params.spaceId, params.owner, params.repo);
      await this.persistSpaceConfig(context, watchedRepo.spaceId);
      return { watchedRepo: this.sanitizeWatchedRepo(watchedRepo) };
    });

    hub.onRequest('space.github.listWatchedRepos', async (data) => {
      await assertRpcConfigEnabled(context, this.sourceId);
      const params = data as { spaceId?: string };
      if (!params.spaceId) throw new Error('spaceId is required');
      return {
        repositories: this.repo
          .listWatchedRepos(params.spaceId)
          .map((repo) => this.sanitizeWatchedRepo(repo)),
      };
    });

    hub.onRequest('space.github.unwatchRepo', async (data) => {
      await assertRpcConfigEnabled(context, this.sourceId);
      const params = data as { spaceId?: string; owner?: string; repo?: string };
      if (!params.spaceId || !params.owner || !params.repo) {
        throw new Error('spaceId, owner and repo are required');
      }
      const { spaceId, owner, repo } = params;
      // Run the DELETE + watched-row removal under the per-hook lock so a queued
      // re-registration cannot observe the still-present row (and recreate the
      // hook) between the DELETE and the row removal, or upsert after removal and
      // resurrect the watch. Re-read the row INSIDE the callback: `existing` was
      // captured before the lock waited, so a prior queued op may have replaced
      // the hook (H1→H2); operating on the captured row would delete the stale H1
      // and orphan H2.
      const removed = await this.runExclusiveWebhookConfig(owner, repo, async () => {
        const current = this.repo.getWatchedRepo(spaceId, owner, repo);
        if (current?.webhookRemoteId && current.webhookAutoRegistered) {
          await this.deleteRemoteWebhookIfUnshared(current);
        }
        return this.repo.removeWatchedRepo(spaceId, owner, repo);
      });
      await this.persistSpaceConfig(context, params.spaceId);
      await this.disablePollingCapabilityIfUnused(context);
      this.maybeStopPolling();
      context.onSourceConfigChanged({
        source: this.sourceId,
        spaceId: params.spaceId,
        kind: 'watched_repo_removed',
      });
      return { removed };
    });

    hub.onRequest('space.github.listConfig', async (data) => {
      await assertRpcConfigEnabled(context, this.sourceId);
      const params = data as { spaceId?: string };
      if (!params.spaceId) throw new Error('spaceId is required');
      return await context.config.getSpaceConfig(params.spaceId, this.sourceId);
    });

    hub.onRequest('space.github.pollOnce', async (data) => {
      await assertRpcConfigEnabled(context, this.sourceId);
      const global = await context.config.getGlobalConfig(this.sourceId);
      if (global.capabilities.polling === false) {
        throw new Error('GitHub polling capability is disabled');
      }
      // A poll interval of 0 means polling is disabled globally (see
      // assertPollingIntervalEnabled); a manual poll must respect that setting
      // rather than publish behind it.
      if (this.getPollIntervalMs() <= 0) {
        throw new Error('GitHub polling is disabled (interval is 0)');
      }
      const params = (data ?? {}) as { spaceId?: string };
      // Serialize with the scheduled cycle (and other manual polls) so two
      // concurrent polls of the same repo cannot interleave cursor reads and
      // wholesale cursor writes.
      const count = await this.runExclusivePoll(() =>
        params.spaceId ? this.pollSpace(params.spaceId) : this.pollEnabledSpaces()
      );
      // If the poll ends under a newly active cooldown (whether count is 0 or
      // positive), some endpoints/repos were not checked. Surface it so the UI
      // reports "partial/skipped" instead of a misleading "complete".
      if (Date.now() < this.rateLimitedUntil) {
        return { count, skipped: 'rate-limited' as const, retryAt: this.rateLimitedUntil };
      }
      // Surface non-rate-limit errors recorded during the cycle (connection
      // failures, HTTP 403/404, etc.) so the UI does not report a false
      // "complete" when some or all endpoints failed.
      // Use the SAME enabled polling-repo set the poll just iterated
      // (listPollingRepos — enabled AND polling). The global poll
      // (pollEnabledSpaces) and per-space poll (pollSpace) both skip disabled
      // rows, so counting errors via listAllPollingConfiguredRepos (which
      // includes disabled rows still carrying a persisted poll error) would
      // report a partial poll with errors from repos the cycle never attempted.
      const polledRepos = this.repo.listPollingRepos(params.spaceId);
      const errorCount = polledRepos.filter(
        (r) => r.pollCursor?.lastPollError || r.pollCursor?.lastPartialPollError
      ).length;
      return errorCount > 0 ? { count, errors: errorCount } : { count };
    });

    /**
     * Store the GitHub PAT in the credential store.
     *
     * Scope: DAEMON-WIDE. The token is shared by every space that uses the
     * GitHub event extension — there is no per-space isolation. Callers MUST
     * confirm overwrite with the user when `getTokenStatus` reports an
     * existing token. The UI is responsible for that confirmation; the RPC
     * intentionally does not refuse overwrites because headless callers
     * (CLI, migration scripts) also use it.
     *
     * Format: accepts classic PATs (`ghp_`), fine-grained PATs
     * (`github_pat_`), OAuth tokens (`gho_`), and app tokens (`ghs_`).
     * Rejects empty / malformed values.
     */
    hub.onRequest('space.github.setToken', async (data) => {
      await assertRpcConfigEnabled(context, this.sourceId);
      if (!this.credentialStore) {
        throw new Error('Credential store is not available for GitHub tokens');
      }
      const params = data as { token?: string };
      const token = params.token?.trim();
      if (!token) throw new Error('token is required');
      validateGitHubTokenFormat(token);
      const fingerprintBefore = credentialFingerprint(await this.resolveToken());
      await this.credentialStore.set(GITHUB_CREDENTIAL_SERVICE, GITHUB_CREDENTIAL_ACCOUNT, token);
      // Only reset credential-scoped state when the token actually changes —
      // re-saving the same PAT (or falling back to an identical env token) must
      // not clear cooldowns/errors or re-trust stale access evidence.
      if (fingerprintBefore !== credentialFingerprint(token)) {
        this.resetRateLimitObservation();
      }
      log.info('GitHub token updated', { source: 'keychain' });
      return { success: true };
    });

    hub.onRequest('space.github.getTokenStatus', async () => {
      await assertRpcConfigEnabled(context, this.sourceId);
      return await this.getTokenStatus();
    });

    /**
     * Consolidated health snapshot for the GitHub event subsystem in a space.
     * Aggregates token, polling, rate-limit, webhook, reaction, and recent
     * delivery-error state into one response for the integration health panel.
     */
    hub.onRequest('space.github.health', async (data) => {
      await assertRpcConfigEnabled(context, this.sourceId);
      const params = data as { spaceId?: string; lightweight?: boolean };
      if (!params.spaceId) throw new Error('spaceId is required');
      // A lightweight request (the panel's periodic 60s refresh) reuses the
      // cached token status instead of issuing an authenticated /user call on
      // every tick — an open panel would otherwise burn ~60 requests/hour
      // against the shared daemon-wide PAT.
      return await this.buildHealthSnapshot(params.spaceId, {
        lightweight: params.lightweight === true,
      });
    });

    /**
     * Remove the daemon-wide GitHub PAT from the credential store.
     * Falls back to env-var token on the next resolveToken() call.
     */
    hub.onRequest('space.github.clearToken', async () => {
      await assertRpcConfigEnabled(context, this.sourceId);
      if (!this.credentialStore) {
        throw new Error('Credential store is not available for GitHub tokens');
      }
      const fingerprintBefore = credentialFingerprint(await this.resolveToken());
      await this.credentialStore.delete(GITHUB_CREDENTIAL_SERVICE, GITHUB_CREDENTIAL_ACCOUNT);
      const fingerprintAfter = credentialFingerprint(await this.resolveToken());
      if (fingerprintBefore !== fingerprintAfter) {
        this.resetRateLimitObservation();
      }
      log.info('GitHub token removed from credential store');
      return { success: true, autoRegisteredHookCount: this.repo.countAllAutoRegisteredHookRefs() };
    });

    /**
     * Toggle polling for watched repos in a space.
     *
     * Scope rules:
     * - Enabling polling only affects repos that do NOT already have webhook
     *   delivery configured (webhookEnabled && webhookSecret, manual or
     *   auto-registered). Polling and webhooks produce independent dedupe
     *   keys (`action: 'polled'` vs webhook actions), so enabling both on
     *   the same repo would backfill and re-trigger workflow runs for
     *   already-delivered events. Repos with webhook delivery stay on
     *   webhook delivery; the user can still flip the per-row Polling
     *   checkbox explicitly.
     * - Disabling polling clears the flag on every repo in the space.
     *
     * Side-effect on the GLOBAL polling capability: enabling flips it on
     * (it gates every poll cycle across the daemon). Disabling flips it
     * back off only when no polling-configured repos remain in any space —
     * so the UI checkbox reflects reality after a disable.
     */
    hub.onRequest('space.github.setPollingEnabled', async (data) => {
      await assertRpcConfigEnabled(context, this.sourceId);
      const params = data as { spaceId?: string; enabled?: boolean };
      if (!params.spaceId || typeof params.enabled !== 'boolean') {
        throw new Error('spaceId and enabled are required');
      }
      if (params.enabled) {
        this.assertPollingIntervalEnabled();
      }
      const repos = this.repo.listWatchedRepos(params.spaceId);
      for (const repo of repos) {
        if (params.enabled && repo.webhookEnabled && repo.webhookSecret) {
          // Webhook delivery is configured for this row (manual or
          // auto-registered). Polling and webhooks emit independent dedupe
          // keys (`action: 'polled'` vs webhook actions), so enabling both
          // would backfill events webhooks already delivered. Leave polling
          // off and let the user opt in via the per-row Polling checkbox.
          // Inactive/broken webhooks should be fixed at the webhook layer
          // rather than papered over with duplicate polling delivery.
          continue;
        }
        this.repo.upsertWatchedRepo({
          spaceId: repo.spaceId,
          owner: repo.owner,
          repo: repo.repo,
          pollingEnabled: params.enabled,
        });
      }
      if (params.enabled) {
        // Record intent BEFORE enabling capability so the capability helper
        // sees the new intent when it scans for spaces with polling_intent.
        this.repo.setPollingIntent(params.spaceId, true);
        await this.enablePollingCapability(context);
        this.ensurePollingActive();
      } else {
        // Clear intent BEFORE disabling capability so countSpacesWithPollingIntent
        // reflects the user's revocation; otherwise the helper would keep the
        // capability on (intent persisted) and the global flag would never drop.
        this.repo.setPollingIntent(params.spaceId, false);
        await this.disablePollingCapabilityIfUnused(context);
        this.maybeStopPolling();
      }
      await this.persistSpaceConfig(context, params.spaceId);
      context.onSourceConfigChanged({
        source: this.sourceId,
        spaceId: params.spaceId,
        kind: 'watched_repo_changed',
      });
      return { spaceId: params.spaceId, pollingEnabled: params.enabled };
    });
  }

  private async handleWebhook(req: Request): Promise<Response> {
    if (!this.context)
      return Response.json({ error: 'GitHub extension not started' }, { status: 503 });
    const global = await this.context.config.getGlobalConfig(this.sourceId);
    const webhooksEnabled = global.globallyEnabled && global.capabilities.webhooks !== false;

    const signature = req.headers.get('X-Hub-Signature-256');
    const eventType = req.headers.get('X-GitHub-Event');
    const deliveryId = req.headers.get('X-GitHub-Delivery');
    if (!signature) return Response.json({ error: 'Missing signature header' }, { status: 401 });
    if (!eventType || !deliveryId)
      return Response.json({ error: 'Missing GitHub event headers' }, { status: 400 });

    const raw = await req.text();
    const signatureMatchedRepos: GitHubWatchedRepo[] = [];
    for (const repo of this.repo.listWebhookValidationRepos()) {
      if (repo.webhookSecret && (await verifySignature(raw, signature, repo.webhookSecret))) {
        signatureMatchedRepos.push(repo);
      }
    }
    if (signatureMatchedRepos.length === 0) {
      return Response.json({ error: 'Invalid signature' }, { status: 401 });
    }
    if (!webhooksEnabled) {
      return Response.json(
        { message: 'Event ignored', reason: 'github_extension_disabled' },
        { status: 202 }
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    // The `status` webhook (commit-status API — external/legacy CI) addresses a
    // commit SHA, not a PR, so it needs async SHA→PR resolution before it can
    // be normalized. Handle it out-of-band from the pure single-event path.
    if (eventType === 'status') {
      return await this.handleStatusWebhook(deliveryId, payload, signatureMatchedRepos);
    }

    // deployment/deployment_status payloads carry a ref/sha but no pull_requests
    // array, so the PR(s) must be resolved via the GitHub API before normalizing.
    // Handled out-of-band (mirrors handleStatusWebhook): the resolution can
    // short-circuit to 503 (transient) or 202 (unattributable) before publishing.
    if (eventType === 'deployment' || eventType === 'deployment_status') {
      return await this.handleDeploymentWebhook(
        eventType,
        deliveryId,
        payload,
        signatureMatchedRepos
      );
    }

    const normalized = normalizeGitHubWebhook(eventType, deliveryId, payload);
    if (!normalized)
      return Response.json({ message: 'Event ignored', deliveryId }, { status: 202 });

    const validForRepo = signatureMatchedRepos.filter(
      (r) =>
        r.owner.toLowerCase() === normalized.repoOwner.toLowerCase() &&
        r.repo.toLowerCase() === normalized.repoName.toLowerCase()
    );
    if (validForRepo.length === 0)
      return Response.json({ error: 'Repository is not watched' }, { status: 404 });

    let published = 0;
    for (const repo of validForRepo) {
      if (!repo.enabled) continue;
      const spaceConfig = await this.context.config.getSpaceConfig(repo.spaceId, this.sourceId);
      if (spaceConfig && !spaceConfig.enabled) continue;
      await this.publishEvent(repo.spaceId, normalized, this.context);
      this.repo.markWebhookReceived(repo.id);
      published++;
    }

    return Response.json({ message: 'Webhook received', deliveryId, spaces: published });
  }

  /**
   * Handles a `deployment`/`deployment_status` webhook. The payload addresses a
   * deployment (ref/sha) but carries no `pull_requests`, so the PR(s) are
   * resolved via the GitHub API (commit-SHA → open PRs whose HEAD is that SHA)
   * and the event is re-expressed per PR under `pull_request/<id>.deployment*`.
   * Mirrors `handleStatusWebhook`.
   *
   * Attribution is SHA-precise: only a PR whose HEAD equals the deployed SHA is
   * updated, so a stale deploy (the PR head has since advanced) is NOT
   * attributed, and a default-branch deploy (sha = main tip) drops as
   * unattributable. There is deliberately NO branch-name fallback — reaching it
   * would mean the SHA matched no PR head, i.e. exactly the stale case we must
   * not paper over. One SHA can be the head of several open PRs, so all matches
   * are published (each scoped by PR in the dedupe key).
   *
   * HTTP status: 200 on publish; 202 for an unattributable/drop or a repo
   * watched only by disabled spaces (resolution skipped, no API cost); 503 for a
   * transient failure (missing token / API error / rate-limit cooldown) — GitHub
   * does NOT auto-redeliver, but 503 marks the delivery FAILED so it stays
   * visible and eligible for manual/scripted redelivery.
   */
  private async handleDeploymentWebhook(
    eventType: string,
    deliveryId: string,
    payload: unknown,
    signatureMatchedRepos: GitHubWatchedRepo[]
  ): Promise<Response> {
    if (!this.context) {
      return Response.json({ error: 'GitHub extension not started' }, { status: 503 });
    }
    const root = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const repo = repoFromPayload(root);
    // GitHub places `deployment` as a top-level sibling of `deployment_status`.
    const statusRoot =
      root.deployment_status && typeof root.deployment_status === 'object'
        ? (root.deployment_status as Record<string, unknown>)
        : null;
    const deployment =
      (root.deployment && typeof root.deployment === 'object'
        ? (root.deployment as Record<string, unknown>)
        : undefined) ??
      (statusRoot?.deployment && typeof statusRoot.deployment === 'object'
        ? (statusRoot.deployment as Record<string, unknown>)
        : undefined) ??
      {};
    const ref = typeof deployment.ref === 'string' ? deployment.ref : '';
    const sha = typeof deployment.sha === 'string' ? deployment.sha : '';
    if (!repo.owner || !repo.repo || (!ref && !sha)) {
      return Response.json({ message: 'Event ignored', deliveryId }, { status: 202 });
    }
    const validForRepo = signatureMatchedRepos.filter(
      (r) =>
        r.owner.toLowerCase() === repo.owner.toLowerCase() &&
        r.repo.toLowerCase() === repo.repo.toLowerCase()
    );
    if (validForRepo.length === 0) {
      return Response.json({ error: 'Repository is not watched' }, { status: 404 });
    }

    // Resolve only when at least one watched row (and its space) is enabled —
    // the resolution GET consumes GitHub quota, so a delivery for a repo watched
    // only by disabled rows/spaces must not pay that cost. Mirrors status.
    const targets: GitHubWatchedRepo[] = [];
    for (const watched of validForRepo) {
      if (!watched.enabled) continue;
      const spaceConfig = await this.context.config.getSpaceConfig(watched.spaceId, this.sourceId);
      if (spaceConfig && !spaceConfig.enabled) continue;
      targets.push(watched);
    }
    if (targets.length === 0) {
      return Response.json({ message: 'Webhook received', deliveryId, spaces: 0 });
    }

    // `inactive` (ephemeral-env teardown) is a spec-defined no-op (#2324). Drop
    // it before the cooldown gate and SHA→PR resolution so it costs no GitHub
    // quota and can't surface a spurious 503 — but still mark each enabled
    // target received, since a correctly signed delivery should refresh webhook
    // health (clear a transient error / advance last_webhook_at). This preserves
    // dev's behavior, where the normalizer's null-return sat inside the publish
    // loop so the per-target mark ran for an inactive delivery.
    if (eventType === 'deployment_status' && statusRoot?.state === 'inactive') {
      for (const watched of targets) {
        this.repo.markWebhookReceived(watched.id);
      }
      return Response.json(
        { message: 'Event ignored', deliveryId, reason: 'inactive' },
        { status: 202 }
      );
    }

    // Don't attempt resolution during a rate-limit cooldown — it would just
    // make failing calls and risk extending the cooldown. Surface as transient.
    if (Date.now() < this.rateLimitedUntil) {
      return Response.json(
        { error: 'Deployment PR resolution skipped — rate limited', deliveryId },
        { status: 503 }
      );
    }

    const { prNumbers, sawError } = await this.resolveDeploymentPrNumbers(repo, sha);
    if (sawError) {
      return Response.json(
        { error: 'Deployment PR resolution failed', deliveryId },
        { status: 503 }
      );
    }
    if (prNumbers.length === 0) {
      return Response.json(
        { message: 'Event ignored', deliveryId, reason: 'no_pull_request' },
        { status: 202 }
      );
    }

    let published = 0;
    for (const watched of targets) {
      for (const prNumber of prNumbers) {
        const normalized =
          eventType === 'deployment'
            ? normalizeGitHubDeployment({
                repo,
                deployment,
                source: 'webhook',
                deliveryId,
                rawPayload: payload,
                sender: root.sender,
                prNumber,
              })
            : normalizeGitHubDeploymentStatus({
                repo,
                deploymentStatus: root.deployment_status,
                deployment,
                source: 'webhook',
                deliveryId,
                rawPayload: payload,
                sender: root.sender,
                prNumber,
              });
        if (!normalized) continue;
        await this.publishEvent(watched.spaceId, normalized, this.context);
        published++;
      }
      this.repo.markWebhookReceived(watched.id);
    }

    return Response.json({ message: 'Webhook received', deliveryId, spaces: published });
  }

  /**
   * Resolves a deployment SHA to the open PR numbers whose HEAD it is, via
   * `GET /repos/{owner}/{repo}/commits/{sha}/pulls`, filtering on `head.sha ===
   * sha` and `state === 'open'` (the endpoint also returns closed/merged PRs and
   * PRs that merely contain the commit, neither of which may be attributed — a
   * closed PR's retained head.sha would otherwise wake a stale subscription).
   * Returns `{ sawError: true }` on a fetch/parse failure so the caller can
   * surface a 503 rather than silently dropping. Real deployments always carry
   * a SHA; a SHA-less payload resolves to none.
   */
  private async resolveDeploymentPrNumbers(
    repo: GitHubPollingRepo,
    sha: string
  ): Promise<{ prNumbers: number[]; sawError: boolean }> {
    if (!sha) return { prNumbers: [], sawError: false };
    const repoPath = gitHubRepoPath(repo.owner, repo.repo);
    const result = await this.fetchDeploymentPrList(
      `/repos/${repoPath}/commits/${encodeURIComponent(sha)}/pulls?per_page=100`
    );
    if (result.kind === 'error') return { prNumbers: [], sawError: true };
    return { prNumbers: pickPrNumbersByHeadSha(result.pulls, sha), sawError: false };
  }

  private async fetchDeploymentPrList(
    path: string
  ): Promise<{ kind: 'ok'; pulls: unknown } | { kind: 'error' }> {
    try {
      const response = await this.githubFetch(path, {
        signal: AbortSignal.timeout(DEPLOYMENT_PR_RESOLUTION_TIMEOUT_MS),
      });
      return { kind: 'ok', pulls: await response.json() };
    } catch {
      // Missing token, API error, or timeout — caller treats as transient.
      return { kind: 'error' };
    }
  }

  /**
   * Handles a GitHub `status` webhook (commit-status API — external/legacy CI
   * such as Jenkins/Travis/custom). The payload addresses a commit SHA, not a
   * PR, so the SHA is resolved to the open PR(s) whose head it is and the event
   * is re-expressed under `pull_request/<id>.status_<state>`.
   *
   * Resolution is best-effort: a failed/empty result (no token, 404, the commit
   * is a base-branch tip with no PR head) drops the event (202) rather than
   * failing the delivery. All four commit-status states surface, including
   * `pending` (blocked-waiting-on-check).
   */
  private async handleStatusWebhook(
    deliveryId: string,
    payload: unknown,
    signatureMatchedRepos: GitHubWatchedRepo[]
  ): Promise<Response> {
    if (!this.context) {
      return Response.json({ error: 'GitHub extension not started' }, { status: 503 });
    }
    const root = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const repo = repoFromPayload(root);
    const sha = statusCommitSha(root);
    if (!repo.owner || !repo.repo || !sha) {
      return Response.json({ message: 'Event ignored', deliveryId }, { status: 202 });
    }
    const validForRepo = signatureMatchedRepos.filter(
      (r) =>
        r.owner.toLowerCase() === repo.owner.toLowerCase() &&
        r.repo.toLowerCase() === repo.repo.toLowerCase()
    );
    if (validForRepo.length === 0) {
      return Response.json({ error: 'Repository is not watched' }, { status: 404 });
    }

    // Resolve SHA→PR only when at least one watched row (and its space) is
    // enabled. The resolution GET consumes GitHub quota, so a delivery for a
    // repo watched only by disabled rows/spaces must not pay that cost — unlike
    // the non-status webhook paths, whose normalization is free.
    const targets: GitHubWatchedRepo[] = [];
    for (const watched of validForRepo) {
      if (!watched.enabled) continue;
      const spaceConfig = await this.context.config.getSpaceConfig(watched.spaceId, this.sourceId);
      if (spaceConfig && !spaceConfig.enabled) continue;
      targets.push(watched);
    }
    if (targets.length === 0) {
      return Response.json({ message: 'Webhook received', deliveryId, spaces: 0 });
    }

    const prNumbers = await this.resolvePullRequestNumbersForCommit(repo.owner, repo.repo, sha);
    if (prNumbers.length === 0) {
      return Response.json(
        { message: 'Event ignored', deliveryId, reason: 'no_pull_request' },
        { status: 202 }
      );
    }

    let published = 0;
    for (const watched of targets) {
      for (const prNumber of prNumbers) {
        const normalized = normalizeGitHubStatus({
          repo,
          status: root,
          prNumber,
          source: 'webhook',
          deliveryId,
          rawPayload: payload,
          sender: root.sender,
        });
        if (!normalized) continue;
        await this.publishEvent(watched.spaceId, normalized, this.context);
        published++;
      }
      this.repo.markWebhookReceived(watched.id);
    }

    return Response.json({ message: 'Webhook received', deliveryId, spaces: published });
  }

  /**
   * Resolves a commit SHA to the OPEN PR numbers whose head it is, via
   * `GET /repos/{owner}/{repo}/commits/{sha}/pulls`. Filters to OPEN PRs whose
   * `head.sha` equals the queried SHA: the endpoint also returns PRs that merged
   * the commit into the base (different head) and closed/merged PRs whose
   * retained head.sha still matches, neither of which may be attributed to a
   * commit-status on the SHA (spec row 1: commit.sha → open PR with matching
   * head). Mirrors `pickPrNumbersByHeadSha` (deployment webhook). Best-effort —
   * any fetch/parse error or non-2xx resolves to an empty list so the webhook is
   * ignored rather than failing.
   */
  private async resolvePullRequestNumbersForCommit(
    owner: string,
    repo: string,
    sha: string
  ): Promise<number[]> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const token = await this.resolveToken();
    const headers = gitHubPollingHeaders(token);
    const numbers: number[] = [];
    const seen = new Set<number>();
    // A commit is the head of at most a few open PRs; bound pagination so a
    // pathological response cannot loop the handler indefinitely.
    for (let page = 1; page <= 5; page++) {
      let response: Response;
      try {
        response = await fetchImpl(
          `${GITHUB_API_BASE}/repos/${gitHubRepoPath(owner, repo)}/commits/${encodeURIComponent(sha)}/pulls?per_page=100&page=${page}`,
          { headers, signal: AbortSignal.timeout(GITHUB_POLL_REQUEST_TIMEOUT_MS) }
        );
      } catch {
        break;
      }
      if (!response.ok) break;
      let rows: unknown;
      try {
        rows = await response.json();
      } catch {
        break;
      }
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        const pr = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
        const head =
          pr.head && typeof pr.head === 'object' ? (pr.head as Record<string, unknown>) : {};
        const headSha = typeof head.sha === 'string' ? head.sha : '';
        const state = typeof pr.state === 'string' ? pr.state : '';
        // head.sha === sha excludes PRs that merely contain the commit (e.g. the
        // PR that merged it into the base); state === 'open' additionally
        // excludes a closed/merged PR whose retained head.sha still equals the
        // commit — mirrors pickPrNumbersByHeadSha (deployment webhook) and
        // satisfies spec row 1 (commit.sha → open PR with matching head).
        if (headSha && headSha === sha && state === 'open') {
          const number = typeof pr.number === 'number' ? pr.number : 0;
          if (number && !seen.has(number)) {
            seen.add(number);
            numbers.push(number);
          }
        }
      }
      if (rows.length < 100) break;
    }
    return numbers;
  }

  async pollOnce(fetchImpl: typeof fetch = this.options.fetchImpl ?? fetch): Promise<number> {
    return await this.pollEnabledSpaces(fetchImpl);
  }

  private async pollEnabledSpaces(
    fetchImpl: typeof fetch = this.options.fetchImpl ?? fetch
  ): Promise<number> {
    if (!this.context) return 0;
    if (!(await this.isPollingGloballyEnabled())) return 0;
    // Skip the entire cycle when a prior endpoint flagged rate-limiting.
    // runPollCycle() will have already deferred the next poll past the reset.
    if (Date.now() < this.rateLimitedUntil) {
      log.warn('GitHub polling cycle skipped — rate limited until', {
        resetAt: new Date(this.rateLimitedUntil).toISOString(),
      });
      return 0;
    }
    let count = 0;
    for (const repo of this.repo.listPollingRepos()) {
      // A 403/429 or low-remaining response on an earlier repo defers the
      // rest of the cycle so we don't burn additional calls against a budget
      // we already know is exhausted.
      if (Date.now() < this.rateLimitedUntil) break;
      const spaceConfig = await this.context.config.getSpaceConfig(repo.spaceId, this.sourceId);
      if (spaceConfig && !spaceConfig.enabled) continue;
      count += await this.pollWatchedRepo(repo, fetchImpl);
    }
    return count;
  }

  private async pollSpace(
    spaceId: string,
    fetchImpl: typeof fetch = this.options.fetchImpl ?? fetch
  ): Promise<number> {
    if (!this.context) return 0;
    if (!(await this.isPollingGloballyEnabled())) return 0;
    // Honor the shared rate-limit window so a UI-triggered scoped poll does
    // not bypass the backoff applied by the regular poll loop. pollOnce
    // shares the same GitHub API budget, so firing during cooldown would
    // re-hit the exhausted quota.
    if (Date.now() < this.rateLimitedUntil) {
      log.warn('GitHub scoped poll skipped — rate limited until', {
        spaceId,
        resetAt: new Date(this.rateLimitedUntil).toISOString(),
      });
      return 0;
    }
    const spaceConfig = await this.context.config.getSpaceConfig(spaceId, this.sourceId);
    if (spaceConfig && !spaceConfig.enabled) return 0;
    let count = 0;
    for (const repo of this.repo.listPollingRepos(spaceId)) {
      count += await this.pollWatchedRepo(repo, fetchImpl);
      // Break loop if rate limit was hit mid-cycle (same guard as pollEnabledSpaces).
      if (Date.now() < this.rateLimitedUntil) break;
    }
    return count;
  }

  private async isPollingGloballyEnabled(): Promise<boolean> {
    if (!this.context) return false;
    const global = await this.context.config.getGlobalConfig(this.sourceId);
    return global.globallyEnabled && global.capabilities.polling !== false;
  }

  /**
   * Whether inbound webhook delivery is globally enabled. Mirrors the gate in
   * `handleWebhook`: the handler short-circuits every delivery (202 "Event
   * ignored") when the source is globally off or the webhooks capability is
   * disabled, so active hooks are not a working path in that state.
   */
  private async isWebhookDeliveryEnabled(): Promise<boolean> {
    if (!this.context) return false;
    const global = await this.context.config.getGlobalConfig(this.sourceId);
    return global.globallyEnabled && global.capabilities.webhooks !== false;
  }

  async refreshPollingInterval(): Promise<void> {
    if (this.stopped) return;
    if (!(await this.isPollingGloballyEnabled()) || this.getPollIntervalMs() <= 0) {
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = null;
      return;
    }
    if (this.activePollCycle) return;
    const delay = this.getNextPollDelayMs();
    if (delay === null) return;
    this.scheduleNextPollAfter(delay);
  }

  private scheduleNextPoll(): void {
    const delay = this.getNextPollDelayMs();
    if (delay === null) return;
    this.scheduleNextPollAfter(delay);
  }

  /**
   * Schedules the next poll cycle after `delayMs`.
   *
   * Replaces the timer regardless of any outstanding schedule. Used both for
   * the default fixed-interval cadence and for rate-limit-aware deferrals
   * where `delayMs` is derived from `X-RateLimit-Reset`. The delay is floored
   * to 1 second so sub-second `pollIntervalMs` configs cannot starve the
   * event loop — GitHub's API would reject such cadence anyway.
   */
  private scheduleNextPollAfter(delayMs: number): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(
      () => {
        // Never overlap a running cycle (scheduled or manual) — concurrent
        // polls of the same repo would interleave cursor reads/writes. If one
        // is in flight, just reschedule. runExclusivePoll owns activePollCycle.
        if (this.activePollCycle) {
          this.scheduleNextPoll();
          return;
        }
        // runExclusivePoll owns activePollCycle (sets + clears it around the
        // run). Do NOT assign its return value here — that would overwrite the
        // internal `tail` tracking and leave activePollCycle permanently set,
        // deadening scheduled polling after one cycle.
        this.runExclusivePoll(() => this.runPollCycle()).catch(() => {});
      },
      Math.max(1_000, delayMs)
    );
    this.pollTimer.unref?.();
  }

  /**
   * Run a poll (scheduled or manual) with mutual exclusion against any other
   * poll. Each call chains `fn` onto the tail of `pollQueue`, so callers that
   * arrive while one is running execute strictly after it — never woken
   * together by a shared-flag await. `activePollCycle` mirrors the in-flight
   * run so the scheduled timer reschedules instead of queuing a redundant
   * cycle. Prevents interleaved cursor reads and wholesale cursor writes.
   */
  private runExclusivePoll<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto the previous run (run on success OR failure of the prior).
    const run = this.pollQueue.then(fn, fn);
    // Advance the tail; never leak a rejection into the queue.
    const tail = run.then(
      () => {},
      () => {}
    );
    this.pollQueue = tail;
    this.activePollCycle = tail;
    tail.finally(() => {
      if (this.activePollCycle === tail) this.activePollCycle = undefined;
    });
    return run;
  }

  /**
   * Run `fn` exclusively for one remote hook (owner/repo), chaining onto that
   * hook's per-key queue. Re-registration of DIFFERENT hooks runs concurrently;
   * re-registration of the SAME shared hook (from multiple Spaces) serializes so
   * the secret-generation, remote PATCH, and shared-row DB update cannot
   * interleave and leave GitHub's secret out of sync with the daemon's.
   */
  private runExclusiveWebhookConfig<T>(
    owner: string,
    repo: string,
    fn: () => Promise<T>
  ): Promise<T> {
    // Normalize to lowercase: repository queries identify the shared hook by
    // lower(owner)/lower(repo), so `Acme/Repo` and `acme/repo` share one remote
    // hook. A case-sensitive key would give their concurrent re-registrations
    // separate queues and still race the same hook.
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    const prev = this.webhookConfigQueues.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => {},
      () => {}
    );
    this.webhookConfigQueues.set(key, tail);
    tail.finally(() => {
      if (this.webhookConfigQueues.get(key) === tail) this.webhookConfigQueues.delete(key);
    });
    return run;
  }

  private async runPollCycle(): Promise<void> {
    try {
      await this.pollEnabledSpaces();
    } catch (error) {
      log.warn('GitHub polling cycle failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (this.stopped) return;
    if (this.repo.listPollingRepos().length === 0) {
      // No work left — release the timer. watchRepo/setPollingEnabled will
      // spin it back up when a polling-enabled repo reappears.
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
      return;
    }
    const delay = this.getNextPollDelayMs();
    if (delay === null) return;
    this.scheduleNextPollAfter(delay);
  }

  private getNextPollDelayMs(): number | null {
    const intervalMs = this.getPollIntervalMs();
    if (intervalMs <= 0) return null;

    const now = Date.now();
    if (now < this.rateLimitedUntil) {
      // Retry-After-based cooldowns may be shorter than the minimum backoff;
      // honor them exactly. Primary reset windows are floored to the minimum.
      const rateLimitDelay = this.rateLimitedFromRetryAfter
        ? Math.max(0, this.rateLimitedUntil - now)
        : Math.max(RATE_LIMIT_MIN_BACKOFF_MS, this.rateLimitedUntil - now);
      return Math.max(intervalMs, rateLimitDelay);
    }
    return intervalMs;
  }

  private getPollIntervalMs(): number {
    const configured = this.options.getPollIntervalMs?.() ?? this.options.pollIntervalMs;
    if (configured === undefined || !Number.isFinite(configured)) {
      return DEFAULT_POLL_INTERVAL_MS;
    }
    return Math.max(0, Math.trunc(configured));
  }

  /**
   * Resolve the GitHub PAT from the credential store when wired, falling back
   * to the env-supplied token. Returns undefined when neither is available.
   */
  private lastResolvedToken: string | undefined;

  private async resolveToken(): Promise<string | undefined> {
    return (await this.resolveTokenOrFail()).token;
  }

  /**
   * Resolve the effective GitHub token, reporting whether the credential-store
   * read failed. On failure the token falls back to the env value like
   * resolveToken, but the `readFailed` flag lets callers that attribute
   * credential-scoped state (the stale-cooldown clear in buildHealthSnapshot)
   * avoid acting on a fingerprint that reflects a fallback rather than a real
   * rotation — a transient keychain failure must not clear a valid cooldown.
   */
  private async resolveTokenOrFail(): Promise<{ token: string | undefined; readFailed: boolean }> {
    let token: string | undefined;
    let readFailed = false;
    if (this.credentialStore) {
      try {
        const stored = await this.credentialStore.get(
          GITHUB_CREDENTIAL_SERVICE,
          GITHUB_CREDENTIAL_ACCOUNT
        );
        if (stored) token = stored;
      } catch (error) {
        readFailed = true;
        log.warn('Failed to read GitHub token from credential store', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!token) token = this.githubToken;
    // Cache the resolved value so sync callers (applyRateLimit) can record its
    // fingerprint without an async resolveToken round-trip.
    this.lastResolvedToken = token;
    return { token, readFailed };
  }

  private async getTokenStatus(): Promise<GitHubTokenStatus> {
    // Capture the credential generation BEFORE the keychain read so a setToken/
    // clearToken that lands during either await (the keychain read below, or the
    // /user fetch) can discard this validation — its result belongs to the old
    // credential. Capturing after the read would carry the new credential's
    // generation while validating the stale token, so an obsolete rate-limit
    // response would pass the generation guard and reinstall the old token's
    // cooldown for the new one.
    const validationGeneration = this.credentialGeneration;
    let source: GitHubTokenStatus['source'] = 'none';
    let token: string | undefined;
    let keychainError: string | undefined;
    if (this.credentialStore) {
      try {
        const stored = await this.credentialStore.get(
          GITHUB_CREDENTIAL_SERVICE,
          GITHUB_CREDENTIAL_ACCOUNT
        );
        if (stored) {
          token = stored;
          source = 'keychain';
        }
      } catch (error) {
        keychainError = error instanceof Error ? error.message : 'credential store unavailable';
        log.warn('Failed to read GitHub token from credential store', { error: keychainError });
      }
    }
    // The credential changed during the keychain read: the resolved token is
    // stale (belongs to the previous credential). Reject rather than validating
    // it — its rate limit must not apply to the current credential, and its
    // status is not the current credential's. Surface a transient error; the
    // next health refresh validates the new token.
    if (this.credentialGeneration !== validationGeneration) {
      // Reject path: this return carries no validatedFingerprint, matching the
      // sibling generation-check rejects below (post-/user-fetch, post-body, and
      // the rate-limited-validation reject) — nothing was actually validated, so
      // claiming a validatedFingerprint would be misleading. Both consumers
      // treat its absence as a mismatch (resolveTokenStatus cache-bust re-reads)
      // or skip the stale-cooldown clear, which is correct for a rejected validation.
      return {
        configured: true,
        source,
        error: 'credential changed during validation',
        autoRegisteredHookCount: this.repo.countAllAutoRegisteredHookRefs(),
      };
    }
    if (!token && this.githubToken) {
      token = this.githubToken;
      source = 'env';
    }
    // Update lastResolvedToken so applyRateLimit (called from this method's rate-
    // limit branches) records the correct fingerprint — getTokenStatus resolves
    // the token via its own store read, not via resolveToken().
    this.lastResolvedToken = token;
    if (!token)
      return {
        configured: false,
        source: 'none',
        error: keychainError,
        autoRegisteredHookCount: this.repo.countAllAutoRegisteredHookRefs(),
        validatedFingerprint: 'none',
      };

    try {
      const fetchImpl = this.options.fetchImpl ?? fetch;
      // validationGeneration was captured before the keychain read above; the
      // generation guards below discard this validation's observations if the
      // credential also changes during this /user fetch.
      const response = await fetchImpl(`${GITHUB_API_BASE}/user`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'HyperNeo-Space-GitHub/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        // Bound validation so a stalled /user (e.g. unreachable API) cannot
        // block the entire health snapshot. Test fetch impls ignore the signal.
        signal: AbortSignal.timeout(TOKEN_VALIDATION_TIMEOUT_MS),
      });
      // If the credential changed during the /user fetch, this response belongs
      // to the superseded token. Do not return its login/rejection (a stale 401
      // would otherwise be cached for the current credential and served to later
      // lightweight refreshes) nor apply its rate limit. Reject like the
      // keychain-read case so the next validation re-checks the new credential.
      if (this.credentialGeneration !== validationGeneration) {
        return {
          configured: true,
          source,
          error: 'credential changed during validation',
          autoRegisteredHookCount: this.repo.countAllAutoRegisteredHookRefs(),
        };
      }
      const autoRegisteredHookCount = this.repo.countAllAutoRegisteredHookRefs();
      if (response.ok) {
        const user = (await response.json()) as { login?: string };
        // Recheck after consuming the body: response.json() is another await
        // point where setToken/clearToken can land, so the login we just parsed
        // can belong to a superseded credential. Reject rather than return/cache
        // it for the current one.
        if (this.credentialGeneration !== validationGeneration) {
          return {
            configured: true,
            source,
            error: 'credential changed during validation',
            autoRegisteredHookCount,
          };
        }
        // A successful /user carries the current rate-limit budget. Persist
        // every finite observation so the health panel reports the quota
        // immediately (not "Unknown (no poll yet)") — even before the first
        // repository poll — while applying the shared cooldown only when the
        // budget is low so the health refresh does not consume the final
        // reserved requests.
        const successRateLimit = parseRateLimitHeaders(response);
        this.recordRateLimitObservation(successRateLimit);
        if (successRateLimit.remaining < RATE_LIMIT_LOW_REMAINING_THRESHOLD) {
          this.applyRateLimit(successRateLimit, true, credentialFingerprint(token));
        }
        return {
          configured: true,
          source,
          login: user.login,
          autoRegisteredHookCount,
          validatedFingerprint: credentialFingerprint(token),
        };
      }
      // A 403 here can be a primary rate limit (X-RateLimit-Remaining: 0), not
      // an auth/permission rejection — GitHub returns 403 for both. Inspect the
      // rate-limit headers so a quota-limited /user is treated as a transient
      // validation failure (Degraded), not a definitive credential rejection
      // (which would drop a polling-only Space to Down).
      const validationRateLimit = parseRateLimitHeaders(response);
      let rateLimited = validationRateLimit.limited;
      // A secondary/abuse rate limit can return 403 with no rate-limit headers;
      // the polling path detects this via the body. Apply the same check here so
      // a headerless secondary limit is treated as transient, not a credential
      // rejection (which would drop a polling-only Space to Down).
      let secondaryLimitApplied = false;
      if (!rateLimited && (response.status === 403 || response.status === 429)) {
        // response.text() is another await point; recheck the generation after
        // consuming it so an obsolete token's rejection is not returned/cached
        // for a credential that rotated while the body was streaming.
        const errorText = await response.text();
        if (this.credentialGeneration !== validationGeneration) {
          return {
            configured: true,
            source,
            error: 'credential changed during validation',
            autoRegisteredHookCount,
          };
        }
        if (isRateLimitError(errorText)) {
          rateLimited = true;
          secondaryLimitApplied = true;
        }
      }
      if (rateLimited && this.credentialGeneration === validationGeneration) {
        // The generation check above confirms this rate limit belongs to the
        // current credential; bypass the poll-cycle guard so an in-flight stale
        // poll does not discard it.
        if (secondaryLimitApplied) {
          // No headers to derive a reset from; apply the minimum backoff.
          this.applyRateLimit(
            {
              remaining: validationRateLimit.remaining,
              resetAt: Date.now() + RATE_LIMIT_MIN_BACKOFF_MS,
              limited: true,
              retryAfter: true,
            },
            true,
            credentialFingerprint(token)
          );
        } else {
          this.applyRateLimit(validationRateLimit, true, credentialFingerprint(token));
        }
      }
      return {
        configured: true,
        source,
        error: rateLimited ? `HTTP ${response.status} (rate limited)` : `HTTP ${response.status}`,
        // 401 is always a credential rejection. A 403 is only a rejection when
        // it is NOT a (primary or secondary) rate-limit response.
        // Only a definitive 401 (revoked/expired credential) sets authRejected.
        // A non-rate-limited 403 from /user means the credential is valid but
        // lacks permission for that endpoint (installation tokens, fine-grained
        // PATs without user scope) — it still works against repo endpoints, so
        // it is a Degraded signal (token.error), not a definitive rejection.
        authRejected: response.status === 401,
        autoRegisteredHookCount,
        validatedFingerprint: credentialFingerprint(token),
      };
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return {
        configured: true,
        source,
        error: timedOut
          ? 'validation timed out'
          : error instanceof Error
            ? error.message
            : 'validation failed',
        // A timeout/network failure is NOT a definitive rejection.
        autoRegisteredHookCount: this.repo.countAllAutoRegisteredHookRefs(),
        validatedFingerprint: credentialFingerprint(token),
      };
    }
  }

  /**
   * Resolve the token status for a health snapshot, optionally reusing a cached
   * result. A lightweight (periodic) refresh reuses the last stable validation
   * (keyed by credential generation) so it does not issue an authenticated
   * /user call every tick. A full refresh (mount, manual Refresh, mutations)
   * always re-validates and refreshes the cache. Only stable results (success
   * or a definitive rejection) are cached; a transient error is re-checked on
   * the next request instead of being served repeatedly.
   */
  private async resolveTokenStatus(lightweight: boolean): Promise<GitHubTokenStatus> {
    if (
      lightweight &&
      this.lastTokenStatus !== null &&
      this.lastTokenStatusGeneration === this.credentialGeneration &&
      // Bounded cache age: a PAT revoked/expired remotely (no local
      // setToken/clearToken, so the generation is unchanged) is revalidated
      // periodically rather than served from cache forever.
      Date.now() - this.lastTokenStatusAt < TOKEN_STATUS_CACHE_TTL_MS &&
      // The keychain may change without setToken/clearToken (no generation bump).
      // If the resolved credential's fingerprint differs from the cached
      // validatedFingerprint, the cached status describes a different credential.
      credentialFingerprint(this.lastResolvedToken) === this.lastTokenStatus.validatedFingerprint
    ) {
      return this.lastTokenStatus;
    }
    // Capture the generation before awaiting. getTokenStatus rejects if the
    // credential changes during its own awaits, but resuming this await is itself
    // a boundary where setToken/clearToken can land between getTokenStatus's
    // return and the cache assignment — without this recheck the old credential's
    // status would be cached under the new generation.
    const generationBefore = this.credentialGeneration;
    const token = await this.getTokenStatus();
    if (this.credentialGeneration !== generationBefore) {
      this.lastTokenStatus = null;
      return {
        configured: true,
        source: token.source,
        error: 'credential changed during validation',
        autoRegisteredHookCount: this.repo.countAllAutoRegisteredHookRefs(),
      };
    }
    // Cache stable results: successful validations, definitive rejections
    // (authRejected), and permission-only 403 responses (installation tokens,
    // fine-grained PATs — the same token will get the same 403 from /user on
    // every call, so re-validating each tick wastes the shared API budget).
    // Transient errors (timeout/network) are NOT cached — they should be
    // re-checked on the next request.
    const isPermissionError = token.error === 'HTTP 403';
    if (!token.error || token.authRejected || isPermissionError) {
      this.lastTokenStatus = token;
      this.lastTokenStatusGeneration = generationBefore;
      this.lastTokenStatusAt = Date.now();
    } else {
      this.lastTokenStatus = null;
    }
    return token;
  }

  /**
   * Assemble a consolidated health snapshot for one space. Pulls token state,
   * the resolved polling config, the current rate-limit window, per-repo
   * webhook/poll freshness, reaction-poll targets, and the most recent failed
   * deliveries into a single response for the integration health panel.
   *
   * `getTokenStatus` is robust to network failures (it returns a structured
   * error rather than throwing), so this method never throws on token
   * validation — only on an absent spaceId (enforced by the RPC caller).
   */
  private async buildHealthSnapshot(
    spaceId: string,
    options: { lightweight?: boolean } = {}
  ): Promise<GitHubHealthSnapshot> {
    // Durable credential fingerprint for the access-scoping check below. One
    // keychain read (no network) — cheap even for lightweight refreshes.
    // Capture the generation: if the credential rotates between this read and
    // resolveTokenStatus (another await), re-read the fingerprint so it matches
    // the credential that was actually validated, not the pre-rotation one.
    let generationBefore = this.credentialGeneration;
    let currentCredentialFingerprint = credentialFingerprint(await this.resolveToken());
    const token = await this.resolveTokenStatus(options.lightweight === true);
    const globallyEnabled = await this.isPollingGloballyEnabled();
    const webhookDeliveryEnabled = await this.isWebhookDeliveryEnabled();
    const intervalMs = this.getPollIntervalMs();
    // Re-read the fingerprint after ALL config awaits complete — a credential
    // rotation during any of them would leave the early read stale. Retry until
    // the generation is stable across the await, but cap at a bounded number of
    // retries so a pathological credential backend (rotation on every read)
    // cannot wedge the RPC.
    for (
      let attempt = 0;
      attempt < 3 && this.credentialGeneration !== generationBefore;
      attempt++
    ) {
      generationBefore = this.credentialGeneration;
      currentCredentialFingerprint = credentialFingerprint(await this.resolveToken());
    }
    // Read the effective credential AFTER all validation/config awaits. A silent
    // keychain rotation (no setToken/clearToken, so credentialGeneration did not
    // bump and the retry loop above did not fire) can land after
    // resolveTokenStatus validated token A but during the config reads — leaving
    // token.validatedFingerprint stale (A's) while token B is now effective. This
    // final read is the authoritative current credential for both the
    // cooldown-clear decision and the access-scoping fingerprint below.
    const { token: effectiveToken, readFailed: effectiveReadFailed } =
      await this.resolveTokenOrFail();
    const effectiveFingerprint = credentialFingerprint(effectiveToken);
    // A transient credential-store failure makes the read fall back to the env
    // token or undefined — a different fingerprint, but NOT a rotation. Only
    // treat the effective fingerprint as authoritative (for clearing the cooldown
    // or marking rotation) when the read succeeded; otherwise keep the validated
    // fingerprint and the existing cooldown, deferring to the next snapshot.
    const credentialRotatedDuringSnapshot =
      !effectiveReadFailed &&
      token.validatedFingerprint !== undefined &&
      effectiveFingerprint !== token.validatedFingerprint;
    // Clear a cooldown only when it belongs to a credential OTHER than the
    // effective current one AND the effective read succeeded. Comparing against
    // the stale token.validatedFingerprint would wrongly clear a cooldown that a
    // concurrent poll/validation correctly tagged to the now-effective B; clearing
    // on a failed read would re-arm polling against the still-rate-limited token.
    if (
      !effectiveReadFailed &&
      this.rateLimitedUntil > 0 &&
      this.lastRateLimitFingerprint &&
      this.lastRateLimitFingerprint !== effectiveFingerprint
    ) {
      this.rateLimitedUntil = 0;
      this.rateLimitedFromRetryAfter = false;
      // Re-arm the poll timer at the normal interval — it was armed for the
      // rotated-away credential's distant rate-limit reset, which no longer applies.
      if (this.pollTimer && !this.activePollCycle && !this.stopped) {
        this.scheduleNextPoll();
      }
    }
    // Bind the access-scoping fingerprint. If the credential rotated during this
    // snapshot (silent rotation, or it kept changing across all 3 retries), mark
    // access unverified via the unstable sentinel so no repo's lastPollAt is
    // trusted as proof of access for a credential not validated this snapshot.
    if (this.credentialGeneration !== generationBefore || credentialRotatedDuringSnapshot) {
      currentCredentialFingerprint = '__unstable_credential__';
    } else if (token.validatedFingerprint) {
      currentCredentialFingerprint = token.validatedFingerprint;
    }
    const now = Date.now();
    // Read repos AFTER the async validation/config awaits so the rollup reflects
    // repository state at response time, not at snapshot-request time — a
    // scheduled poll can update lastPollAt/errors during those awaits.
    const watched = this.repo.listWatchedRepos(spaceId);

    let webhookConfigured = 0;
    let webhookActive = 0;
    let webhookInactive = 0;
    let webhookUnknown = 0;
    let lastWebhookAt: number | null = null;
    let lastCheckedAt: number | null = null;
    let reactionTrackedPullRequests = 0;
    let inaccessiblePollingRepos = 0;
    let partialPollingRepos = 0;
    let neverPolledRepos = 0;
    let stalePollingRepos = 0;
    let staleReactionRepos = 0;
    let lastPollAt: number | null = null;
    let lastReactionActivityAt: number | null = null;
    const webhookErrors: GitHubHealthSnapshot['webhook']['errors'] = [];
    const reactionStaleWindow =
      intervalMs > 0
        ? Math.max(intervalMs * REACTION_STALE_INTERVALS, REACTION_STALE_MIN_MS)
        : REACTION_STALE_MIN_MS;
    // Per-repo polling staleness window (mirrors the frontend's pollingIsStale).
    // The aggregate lastPollAt (max) would otherwise let one fresh repo mask
    // another whose non-null timestamp has gone stale.
    const pollingStaleWindow =
      intervalMs > 0
        ? Math.max(intervalMs * REACTION_STALE_INTERVALS, REACTION_STALE_MIN_MS)
        : REACTION_STALE_MIN_MS;

    for (const repo of watched) {
      // A disabled space (space.github.disable) flips every row's `enabled`
      // flag, and the webhook/poll paths skip disabled rows before delivering.
      // Exclude them from the health aggregates so the summary reflects the
      // active delivery path — otherwise a disabled space with stale active
      // hooks would read as Healthy. The `repositories` rollup still includes
      // them (with their `enabled` flag) for diagnostics.
      if (!repo.enabled) continue;
      if (repo.webhookEnabled) {
        webhookConfigured++;
        if (repo.webhookActive === true) webhookActive++;
        else if (repo.webhookActive === false) webhookInactive++;
        else webhookUnknown++;
        // Delivery timestamps and webhook errors only count for rows that
        // currently accept webhooks. A toggled-off webhook keeps its historical
        // lastWebhookAt, but it must not be treated as a live delivery path.
        if (repo.lastWebhookAt && (lastWebhookAt === null || repo.lastWebhookAt > lastWebhookAt)) {
          lastWebhookAt = repo.lastWebhookAt;
        }
        if (
          repo.webhookLastCheckedAt &&
          (lastCheckedAt === null || repo.webhookLastCheckedAt > lastCheckedAt)
        ) {
          lastCheckedAt = repo.webhookLastCheckedAt;
        }
        if (repo.webhookLastError) {
          webhookErrors.push({
            owner: repo.owner,
            repo: repo.repo,
            error: repo.webhookLastError,
            at: repo.webhookLastCheckedAt,
          });
        }
      }
      // Cursor-derived signals (tracked PRs, poll/reaction freshness) only
      // apply while the repo is actually polling. A repo switched to
      // webhook-only keeps its cursor but reactions no longer run for it.
      const isPollingRepo = repo.pollingEnabled;
      const repoInaccessible = isPollingRepo && Boolean(repo.pollCursor?.lastPollError);
      const trackedPrs = isPollingRepo
        ? (repo.pollCursor?.recentPullRequestNumbers?.length ?? 0)
        : 0;
      reactionTrackedPullRequests += trackedPrs;
      if (repoInaccessible) {
        inaccessiblePollingRepos++;
      }
      if (isPollingRepo && repo.pollCursor?.lastPartialPollError) {
        partialPollingRepos++;
      }
      // lastPollAt only proves access under the credential that produced it. A
      // replaced token's first poll hasn't re-confirmed repo access, so a stale
      // lastPollAt from the previous credential must not badge the repo live.
      // provenLastPollAt is null unless the last successful poll ran under the
      // current credential FINGERPRINT — a durable hash of the token that
      // survives restarts (unlike the in-memory generation counter).
      const pollFingerprint = repo.pollCursor?.lastPollCredentialFingerprint;
      const accessVerified = pollFingerprint === currentCredentialFingerprint;
      const provenLastPollAt = accessVerified ? repo.lastPollAt : null;
      // A polling repo that has never successfully reached GitHub under the
      // current credential (no proven lastPollAt) and is not flagged
      // inaccessible — e.g. a multi-repo cycle that rate-limited before visiting
      // it, or a token rotation that hasn't re-confirmed access. Counted per-repo
      // so one repo's fresh poll cannot mask another.
      if (isPollingRepo && !provenLastPollAt && !repo.pollCursor?.lastPollError) {
        neverPolledRepos++;
      }
      // A polling repo whose proven last successful poll is now past the
      // staleness window — e.g. skipped for budget across several cycles. Counted
      // per-repo so the aggregate lastPollAt (max) cannot mask it behind a fresh
      // repo.
      if (
        isPollingRepo &&
        provenLastPollAt &&
        !repo.pollCursor?.lastPollError &&
        now - provenLastPollAt > pollingStaleWindow
      ) {
        stalePollingRepos++;
      }
      // Aggregate poll freshness only from accessible repos whose last poll ran
      // under the current credential: an inaccessible repo, or one whose
      // lastPollAt predates a token rotation, must not contribute a fresh
      // timestamp that masks a broken/revoked path.
      if (
        isPollingRepo &&
        !repoInaccessible &&
        provenLastPollAt &&
        (lastPollAt === null || provenLastPollAt > lastPollAt)
      ) {
        lastPollAt = provenLastPollAt;
      }
      // Reaction freshness reflects when reactions were actually polled
      // (lastReactionPollAt), not merely when the repo polled — reactions are
      // skipped when the rate-limit budget is tight, so lastPollAt would
      // otherwise over-state freshness.
      const reactionAt = isPollingRepo ? (repo.pollCursor?.lastReactionPollAt ?? null) : null;
      if (
        trackedPrs > 0 &&
        reactionAt !== null &&
        (lastReactionActivityAt === null || reactionAt > lastReactionActivityAt)
      ) {
        lastReactionActivityAt = reactionAt;
      }
      // Per-repo reaction staleness: a repo tracking reaction targets whose
      // reactions never succeeded (null) or were last observed past the window.
      // Counted per-repo so one repo's fresh reactions cannot mask another's.
      if (
        isPollingRepo &&
        trackedPrs > 0 &&
        (reactionAt === null || now - reactionAt > reactionStaleWindow)
      ) {
        staleReactionRepos++;
      }
    }

    // An observation persists across all-304 cycles (which carry no quota
    // headers) so the panel keeps reporting the budget. But once its reset epoch
    // has passed, a stale exhausted-quota observation (remaining: 0, past resetAt)
    // is no longer meaningful — the quota has likely reset. Drop it so the panel
    // stops showing zero-remaining across later windows until a fresh finite
    // observation (a non-304 request or a /user validation) arrives.
    if (
      this.lastRateLimitInfo &&
      this.lastRateLimitInfo.resetAt &&
      this.lastRateLimitInfo.resetAt <= now
    ) {
      this.lastRateLimitInfo = undefined;
      this.lastRateLimitObservedAt = 0;
    }
    const rateLimitInfo = this.lastRateLimitInfo;
    // Bound the health rollup to a recency window: a terminal failure only
    // counts toward recentErrors (and the Degraded badge) while it is recent.
    // The full unbounded log stays available via the deliveries view.
    const recentCutoff = now - HEALTH_RECENT_ERROR_WINDOW_MS;
    const recentDeliveries = this.eventStore
      .listDeliveryLog({
        spaceId,
        status: 'failed',
        // Filter at the SQL level so the LIMIT cannot crowd out GitHub failures
        // with newer failures from other external-event sources in this Space.
        source: 'github',
        limit: 5,
      })
      .filter((delivery) => delivery.updatedAt >= recentCutoff);
    // The true count of recent failures (the capped list above undercounts a
    // larger outage — it returns at most 5). Surfaced separately so the panel can
    // report the real number, not the truncated display length.
    const recentErrorTotal = this.eventStore.countDeliveryLog({
      spaceId,
      status: 'failed',
      source: 'github',
      updatedSince: recentCutoff,
    });

    // Recent ingestion activity per merge-blocking event type. Reuse the same
    // recency window as recentErrors so the breakdown and the error rollup
    // describe the same horizon. The store returns raw per-topic counts; reduce
    // them here by the topic-action suffix so the source-agnostic store never
    // has to know a GitHub kind. Types with no events in the window still emit a
    // 0-count entry so the panel renders a stable layout.
    const eventTypeBuckets = this.eventStore.listEventCountsByTopic({
      spaceId,
      source: 'github',
      since: recentCutoff,
    });
    const eventTypeAccumulators = GITHUB_HEALTH_EVENT_TYPES.reduce(
      (acc, { key }) => {
        acc[key] = { count: 0, lastAt: 0 };
        return acc;
      },
      {} as Record<GitHubHealthEventTypeKey, { count: number; lastAt: number }>
    );
    for (const bucket of eventTypeBuckets) {
      // The action suffix is the segment after the final `.` — repo names may
      // contain dots, but the action itself never does, so lastIndexOf lands on
      // the entityId/action separator regardless of owner/repo naming.
      const suffix = bucket.topic.slice(bucket.topic.lastIndexOf('.') + 1);
      const type = TOPIC_SUFFIX_TO_HEALTH_TYPE[suffix];
      if (!type) continue;
      const acc = eventTypeAccumulators[type];
      acc.count += bucket.count;
      if (bucket.lastAt > acc.lastAt) acc.lastAt = bucket.lastAt;
    }
    const eventTypes = GITHUB_HEALTH_EVENT_TYPES.map(({ key, label }) => ({
      type: key,
      label,
      count: eventTypeAccumulators[key].count,
      lastAt: eventTypeAccumulators[key].lastAt > 0 ? eventTypeAccumulators[key].lastAt : null,
    }));

    return {
      source: 'github',
      spaceId,
      timestamp: now,
      token,
      polling: {
        globallyEnabled,
        intervalMs,
        active: !this.stopped && this.pollTimer !== null,
        pollingRepoCount: this.repo.listPollingRepos(spaceId).length,
        inaccessibleRepoCount: inaccessiblePollingRepos,
        partialErrorRepoCount: partialPollingRepos,
        neverPolledRepoCount: neverPolledRepos,
        stalePollingRepoCount: stalePollingRepos,
        lastPollAt,
      },
      rateLimit: {
        limited: now < this.rateLimitedUntil,
        until: this.rateLimitedUntil,
        fromRetryAfter: this.rateLimitedFromRetryAfter,
        remaining:
          rateLimitInfo && Number.isFinite(rateLimitInfo.remaining)
            ? rateLimitInfo.remaining
            : null,
        resetAt: rateLimitInfo && rateLimitInfo.resetAt ? rateLimitInfo.resetAt : null,
        observedAt: this.lastRateLimitObservedAt,
      },
      webhook: {
        total: watched.length,
        configured: webhookConfigured,
        active: webhookActive,
        inactive: webhookInactive,
        unknown: webhookUnknown,
        deliveryEnabled: webhookDeliveryEnabled,
        lastWebhookAt,
        lastCheckedAt,
        errors: webhookErrors,
      },
      reactions: {
        trackedPullRequests: reactionTrackedPullRequests,
        lastActivityAt: lastReactionActivityAt,
        staleRepoCount: staleReactionRepos,
      },
      recentErrors: recentDeliveries.map((delivery) => ({
        eventId: delivery.event.id,
        deliveryKey: delivery.deliveryKey,
        topic: delivery.event.topic,
        agentName: delivery.agentName,
        failureReason: delivery.failureReason,
        updatedAt: delivery.updatedAt,
        occurredAt: delivery.event.occurredAt,
      })),
      // True count of recent failures (recentErrors is capped at 5 for display).
      recentErrorTotal,
      eventTypes,
      repositories: watched.map((repo) => ({
        owner: repo.owner,
        repo: repo.repo,
        enabled: repo.enabled,
        webhookEnabled: repo.webhookEnabled,
        webhookActive: repo.webhookActive,
        webhookAutoRegistered: repo.webhookAutoRegistered,
        pollingEnabled: repo.pollingEnabled,
        lastWebhookAt: repo.lastWebhookAt,
        webhookLastCheckedAt: repo.webhookLastCheckedAt,
        lastPollAt: repo.lastPollAt,
        webhookLastError: repo.webhookLastError,
        lastPollError: repo.pollCursor?.lastPollError ?? null,
        lastPartialPollError: repo.pollCursor?.lastPartialPollError ?? null,
        reactionTrackedPullRequests: repo.pollCursor?.recentPullRequestNumbers?.length ?? 0,
      })),
    };
  }

  /**
   * Flip the global polling capability on. Called when a polling-enabled repo
   * is added so subsequent poll cycles are not blocked by capability gating.
   */
  private async enablePollingCapability(context: ExternalEventExtensionContext): Promise<void> {
    const global = await context.config.getGlobalConfig(this.sourceId);
    if (global.capabilities.polling === true) return;
    await context.config.setGlobalConfig(this.sourceId, {
      ...global,
      capabilities: { ...global.capabilities, polling: true },
    });
  }

  /**
   * Turn the global polling capability off if no watched repo in any space
   * has `polling_enabled = 1` AND no space has a persisted polling intent.
   * Called from setPollingEnabled(false), unwatchRepo, and watchRepo when
   * the row ends up without polling, so the UI checkbox reflects reality
   * after the last polling consumer goes away.
   *
   * Uses `listAllPollingConfiguredRepos` (NOT `listPollingRepos`) so a
   * disabled space or row that still carries a polling row doesn't strand
   * the capability in the OFF state. Includes the per-space polling-intent
   * count so a space that has signalled intent to use polling (but
   * temporarily has zero polling rows) doesn't have its intent stranded
   * either — the capability stays on until the user explicitly turns the
   * intent off via setPollingEnabled(false).
   */
  private async disablePollingCapabilityIfUnused(
    context: ExternalEventExtensionContext
  ): Promise<void> {
    if (this.repo.listAllPollingConfiguredRepos().length > 0) return;
    if (this.repo.countSpacesWithPollingIntent() > 0) return;
    const global = await context.config.getGlobalConfig(this.sourceId);
    if (global.capabilities.polling !== true) return;
    await context.config.setGlobalConfig(this.sourceId, {
      ...global,
      capabilities: { ...global.capabilities, polling: false },
    });
  }

  private assertPollingIntervalEnabled(): void {
    if (this.getPollIntervalMs() <= 0) {
      throw new Error(
        'GitHub polling is disabled globally. Set GitHub polling interval above 0 in General settings to enable polling.'
      );
    }
  }

  private ensurePollingActive(): void {
    if (this.stopped) return;
    if (this.pollTimer || this.getPollIntervalMs() <= 0) return;
    this.scheduleNextPoll();
  }

  private maybeStopPolling(): void {
    if (!this.pollTimer) return;
    if (this.repo.listPollingRepos().length > 0) return;
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /**
   * Marks the extension as rate-limited until `rateLimit.resetAt` (or the
   * minimum backoff when the reset header was absent / already past).
   *
   * Preserves the longer cooldown when multiple requests observe different
   * reset windows (e.g., scheduled poll vs RPC pollOnce overlap).
   */
  /**
   * Drop the cached rate-limit state. Called when the effective credential
   * changes (setToken/clearToken): the observed remaining/reset budget AND the
   * active cooldown belong to the previous credential, so neither must gate the
   * new one (a fresh PAT that hits a primary limit should not inherit the old
   * token's up-to-~1h X-RateLimit-Reset, and the panel must not report
   * limited:true with null remaining). A per-IP secondary limit, if still in
   * effect, is re-detected and re-applied by the next poll, so clearing is safe.
   */
  private resetRateLimitObservation(): void {
    this.lastRateLimitInfo = undefined;
    this.lastRateLimitObservedAt = 0;
    this.rateLimitedUntil = 0;
    this.rateLimitedFromRetryAfter = false;
    // Bump the generation so any in-flight cycle (still using the old token)
    // discards its rate-limit observations instead of restoring the old
    // credential's quota/cooldown over the replacement.
    this.credentialGeneration++;
    // Clear the old credential's per-repo access failures so a valid
    // replacement token is not badged Down (or rate-limited into preserving the
    // stale error) before its first successful poll proves access.
    this.repo.clearPollErrorsForAllRepos();
    // If the scheduled timer was armed with the (now-cleared) rate-limit delay,
    // re-arm it at the normal interval so polling with the new credential
    // resumes promptly. Skip while a cycle is mid-flight — its own tail will
    // reschedule, and re-arming concurrently could start an overlapping cycle.
    if (this.pollTimer && !this.activePollCycle && !this.stopped) {
      this.scheduleNextPoll();
    }
  }

  private applyRateLimit(
    rateLimit: GitHubRateLimitInfo,
    bypassGenerationGuard = false,
    credentialFp?: string
  ): void {
    // Discard observations from a poll cycle whose credential was replaced
    // mid-flight — they belong to the old token and would block the new one.
    // A validation call (getTokenStatus) passes bypassGenerationGuard after its
    // own generation check, so a rate limit observed for the CURRENT credential
    // is not discarded merely because a stale poll is still in flight.
    if (
      !bypassGenerationGuard &&
      this.pollCycleCredentialGeneration !== null &&
      this.pollCycleCredentialGeneration !== this.credentialGeneration
    ) {
      return;
    }
    // When resetAt is derived from Retry-After, honor it directly (not floored to min backoff).
    // When resetAt is derived from X-RateLimit-Reset (or missing), floor to min backoff.
    const resetDelay =
      rateLimit.resetAt > Date.now() ? rateLimit.resetAt - Date.now() : RATE_LIMIT_MIN_BACKOFF_MS;
    const delay = rateLimit.retryAfter
      ? resetDelay
      : Math.max(RATE_LIMIT_MIN_BACKOFF_MS, resetDelay);
    const newRateLimitedUntil = Date.now() + delay;
    // Attribute the cooldown to the credential that actually observed it:
    //  - Validation callers (getTokenStatus) pass credentialFp =
    //    fingerprint(their local validated token) so a /user rate limit is tagged
    //    to the validated token even when a concurrent repo poll has set
    //    pollCycleCredentialFingerprint to a DIFFERENT token.
    //  - Poll callers omit credentialFp and rely on pollCycleCredentialFingerprint
    //    (captured at poll resolve), which survives a concurrent health refresh
    //    overwriting the shared lastResolvedToken during the poll's in-flight await.
    const newFingerprint =
      credentialFp ??
      this.pollCycleCredentialFingerprint ??
      credentialFingerprint(this.lastResolvedToken);
    // Replace the cooldown when this observation wins the deadline OR belongs to
    // a different credential than the one that owns the current cooldown. The
    // preserve-longer rule (don't shorten an existing backoff) applies ONLY within
    // a credential — a cooldown owned by a rotated-away credential is irrelevant
    // to the new one, so the new credential's observation replaces it even when
    // shorter. Without the cross-credential replace, a silent rotation to B with
    // a shorter window would preserve A's longer deadline, then
    // buildHealthSnapshot clears A's deadline (B is effective), leaving B with no
    // cooldown while it is still rate-limited.
    const currentOwnedByOtherCredential =
      this.lastRateLimitFingerprint !== undefined &&
      this.lastRateLimitFingerprint !== newFingerprint;
    if (newRateLimitedUntil > this.rateLimitedUntil || currentOwnedByOtherCredential) {
      this.rateLimitedUntil = newRateLimitedUntil;
      this.rateLimitedFromRetryAfter = rateLimit.retryAfter;
      this.lastRateLimitFingerprint = newFingerprint;
    }
    log.warn('GitHub rate limit detected — deferring next poll', {
      remaining: rateLimit.remaining === Infinity ? 'unknown' : rateLimit.remaining,
      resetAt: rateLimit.resetAt ? new Date(rateLimit.resetAt).toISOString() : 'unknown',
      nextPollInMs: delay,
    });
  }

  /**
   * Persist an observed rate-limit budget (remaining/reset) on the extension
   * instance WITHOUT applying a cooldown. Used for successful /user validations
   * (and any finite observation that does not warrant deferring the next poll):
   * the health panel can report the current quota immediately instead of
   * "Unknown (no poll yet)". Only finite observations are recorded — a
   * headerless response parses as non-finite and would clobber a previously
   * observed budget. Merged (not overwritten) so an all-304 / headerless cycle
   * cannot erase a prior finite observation.
   */
  private recordRateLimitObservation(rateLimit: GitHubRateLimitInfo): void {
    if (!Number.isFinite(rateLimit.remaining)) return;
    this.lastRateLimitInfo = mergeRateLimitInfo(this.lastRateLimitInfo, rateLimit);
    this.lastRateLimitObservedAt = Date.now();
  }

  private async publishEvent(
    spaceId: string,
    event: import('./github-normalizer').NormalizedGitHubEvent,
    context: ExternalEventExtensionContext
  ): Promise<void> {
    await context.publisher.publish(toExternalEvent(spaceId, event));
  }

  private async persistSpaceConfig(
    context: ExternalEventExtensionContext,
    spaceId: string
  ): Promise<void> {
    const repos = this.repo.listWatchedRepos(spaceId);
    await context.config.setSpaceConfig(spaceId, this.sourceId, {
      spaceId,
      source: this.sourceId,
      enabled: this.repo.isSpaceEnabled(spaceId),
      settings: {
        pollingIntent: this.repo.getPollingIntent(spaceId),
        watchedRepos: repos.map((repo) => ({
          id: repo.id,
          owner: repo.owner,
          repo: repo.repo,
          enabled: repo.enabled,
          webhookEnabled: repo.webhookEnabled,
          pollingEnabled: repo.pollingEnabled,
          webhookSecret: repo.webhookSecret ? 'configured' : null,
          webhookRemoteId: repo.webhookRemoteId,
          webhookUrl: repo.webhookUrl,
          webhookAutoRegistered: repo.webhookAutoRegistered,
          webhookActive: repo.webhookActive,
          webhookLastCheckedAt: repo.webhookLastCheckedAt,
          webhookLastError: repo.webhookLastError,
          webhookConfiguredAt: repo.webhookConfiguredAt,
          lastWebhookAt: repo.lastWebhookAt,
          lastPollAt: repo.lastPollAt,
          createdAt: repo.createdAt,
          updatedAt: repo.updatedAt,
        })),
      },
    });
  }

  private sanitizeWatchedRepo(repo: GitHubWatchedRepo): Omit<GitHubWatchedRepo, 'webhookSecret'> & {
    webhookSecret: 'configured' | null;
  } {
    return {
      ...repo,
      webhookSecret: repo.webhookSecret ? 'configured' : null,
    };
  }

  private async autoConfigureWebhook(params: {
    spaceId: string;
    owner: string;
    repo: string;
  }): Promise<GitHubWatchedRepo> {
    if (!(await this.resolveToken())) {
      throw new Error('GITHUB_TOKEN is required to configure GitHub webhooks');
    }
    const webhookUrl = getConfiguredWebhookUrl();
    return this.runExclusiveWebhookConfig(
      params.owner,
      params.repo,
      async (): Promise<GitHubWatchedRepo> => {
        const existing = this.repo.getWatchedRepo(params.spaceId, params.owner, params.repo);
        const reusable = this.repo.getAutoRegisteredRepo(params.owner, params.repo, webhookUrl);
        const source = existing?.webhookAutoRegistered ? existing : reusable;
        const secret = existing?.webhookAutoRegistered
          ? generateWebhookSecret()
          : (reusable?.webhookSecret ?? generateWebhookSecret());
        try {
          const hook = await this.configureRemoteWebhook(params, source, webhookUrl, secret);
          const checkedAt = Date.now();
          const configuredAt = Date.now();
          const storedUrl = hook.config?.url ?? webhookUrl;
          if (source?.webhookRemoteId) {
            this.repo.updateSharedAutoHook({
              owner: params.owner,
              repo: params.repo,
              previousWebhookRemoteId: source.webhookRemoteId,
              webhookRemoteId: hook.id,
              webhookSecret: secret,
              webhookUrl: storedUrl,
              webhookActive: hook.active,
              webhookLastCheckedAt: checkedAt,
              webhookConfiguredAt: configuredAt,
            });
          }
          return this.repo.upsertWatchedRepo({
            spaceId: params.spaceId,
            owner: params.owner,
            repo: params.repo,
            webhookSecret: secret,
            webhookEnabled: true,
            // Omit pollingEnabled: upsertWatchedRepo preserves the row's CURRENT
            // value (read fresh inside the upsert). Passing the value captured
            // before the slow PATCH would overwrite a concurrent
            // setPollingEnabled(false) and silently re-enable polling.
            webhookRemoteId: hook.id,
            webhookUrl: storedUrl,
            webhookAutoRegistered: true,
            webhookActive: hook.active,
            webhookLastCheckedAt: checkedAt,
            webhookLastError: null,
            webhookConfiguredAt: configuredAt,
          });
        } catch (error) {
          // Only persist a failed recovery when the remote hook is confirmed gone
          // (a PATCH 404 followed by a failed replacement POST). A mere update
          // failure (e.g. a 422) leaves the existing remote hook intact, so its
          // status must not be flipped to inactive. Mirrors checkWebhook's pattern.
          const hookConfirmedGone = (error as Error & { hookConfirmedDeleted?: boolean })
            .hookConfirmedDeleted;
          // The confirmed-gone hook is the one configureRemoteWebhook PATCHed, which
          // is `source` (existing when it is the auto-registered row, otherwise the
          // reusable shared row from another Space). Update via source so a reused
          // shared hook's deletion marks every sharing row inactive, not just the
          // local existing row (which is null when reusing another Space's hook).
          if (hookConfirmedGone && source && source.webhookRemoteId) {
            this.updateWebhookStatus(source, {
              active: false,
              lastCheckedAt: Date.now(),
              lastError: error instanceof Error ? error.message : String(error),
            });
          } else if (
            // A transport abort (timeout/network) AFTER the mutation was sent is
            // indeterminate — GitHub may have applied the new secret even though the
            // response never came back, so the daemon's retained (old) secret could
            // start failing signature verification. A GitHubApiError here means the
            // request reached GitHub and was rejected (e.g. a 422), so the remote
            // hook is unchanged; only a non-API transport failure is uncertain.
            !(error instanceof GitHubApiError) &&
            source &&
            source.webhookRemoteId
          ) {
            this.updateWebhookStatus(source, {
              lastCheckedAt: Date.now(),
              lastError: `webhook update uncertain: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
          }
          throw error;
        }
      }
    );
  }

  private async checkWebhook(
    spaceId: string,
    owner: string,
    repo: string
  ): Promise<GitHubWatchedRepo> {
    if (!(await this.resolveToken())) {
      throw new Error('GITHUB_TOKEN is required to check GitHub webhooks');
    }
    const watched = this.repo.getWatchedRepo(spaceId, owner, repo);
    if (!watched) throw new Error(`Repository ${owner}/${repo} is not watched`);
    if (!watched.webhookRemoteId)
      throw new Error(`Repository ${owner}/${repo} has no auto-configured webhook`);
    try {
      let hook = await this.getRemoteWebhook(watched);
      let error = validateRemoteHook(watched, hook);
      // The row used for post-heal validation + the status write. Defaults to the
      // snapshot; after a self-heal PATCH it becomes the re-read row, whose
      // URL/secret may differ from the snapshot if a concurrent
      // autoConfigureWebhook reconfigured the hook (same hook id, new endpoint).
      let effective = watched;
      // Whether the self-heal actually PATCHed (reaffirming the stored secret). A
      // successful PATCH resolves a pre-existing "update uncertain" error; a
      // GET-only check cannot, so the uncertainty must be preserved (below).
      let selfHealPatched = false;
      // Self-heal: a daemon-managed hook can fall behind when WEBHOOK_EVENTS
      // grows (e.g. a new event type added since registration). If the only
      // problem is missing events, PATCH it back into sync and re-validate
      // instead of surfacing a stale, fixable error. Only touches hooks the
      // daemon owns; a user-configured hook is reported, not mutated. The PATCH
      // runs under the per-hook lock and re-reads the CURRENT row: a concurrent
      // autoConfigureWebhook serialized ahead of it may have rotated the secret,
      // and PATCHing with the snapshot secret would desync the remote secret and
      // break signature verification on every later delivery. The outer guard
      // only decides whether to ATTEMPT a heal (missing events + managed); the
      // precise "event-only drift" check runs inside the lock against the re-read
      // row, so a concurrent autoConfigure that reconfigured the hook isn't
      // falsely blocked by the stale snapshot, and a deliberately disabled or
      // repointed hook isn't force-reverted.
      if (
        watched.webhookAutoRegistered &&
        watched.webhookRemoteId &&
        watched.webhookSecret &&
        missingRequiredEvents(hook).length > 0
      ) {
        try {
          const healed = await this.runExclusiveWebhookConfig(
            watched.owner,
            watched.repo,
            async () => {
              const current = this.repo.getWatchedRepo(
                watched.spaceId,
                watched.owner,
                watched.repo
              );
              if (!current?.webhookSecret) return { hook, row: effective, patched: false };
              // Only PATCH when missing events is the SOLE problem for the
              // current row — don't reactivate or repoint a deliberately changed
              // hook (updateRemoteWebhook forces active:true + the stored URL).
              if (!isOnlyMissingEvents(current, hook)) {
                return { hook, row: current, patched: false };
              }
              const patchedHook = await this.updateRemoteWebhook(
                current,
                current.webhookUrl ?? getConfiguredWebhookUrl(),
                current.webhookSecret
              );
              return { hook: patchedHook, row: current, patched: true };
            }
          );
          hook = healed.hook;
          effective = healed.row;
          selfHealPatched = healed.patched;
          // Validate against the re-read row (current URL), not the snapshot —
          // otherwise a reconfigured-but-correct hook is flagged inactive.
          error = validateRemoteHook(effective, hook);
        } catch (healError) {
          // A definitive API rejection (GitHubApiError) means the hook is still
          // missing events — fall through with the original `error` so the status
          // write marks it inactive. A transport/decode failure may have landed
          // AFTER GitHub applied the PATCH: record update-uncertain preserving
          // the prior active state (markWebhookReceived won't repair a false
          // active=0) and return — don't let the status write below flip it
          // inactive. Mirrors reconcileWebhookEvents. (Re-throw on rethrow paths
          // is unnecessary: checkWebhook's outer catch only acts on 404.)
          if (!(healError instanceof GitHubApiError)) {
            this.updateWebhookStatus(effective, {
              lastCheckedAt: Date.now(),
              lastError: `webhook update uncertain: ${
                healError instanceof Error ? healError.message : String(healError)
              }`,
            });
            const result = this.repo.getWatchedRepoById(effective.id);
            if (!result) throw new Error('Repository was removed during webhook check');
            return result;
          }
        }
      }
      // Re-read the CURRENT error after the GET: a slow GET can overlap a
      // re-registration whose PATCH timed out and recorded "update uncertain".
      // A GET cannot verify which secret GitHub retained, so preserve that
      // uncertainty — UNLESS the self-heal just PATCHed, which reaffirms the
      // stored secret and resolves it. A "deletion uncertain" error IS resolved
      // by a successful GET (the hook still exists).
      const currentError = this.repo.getWatchedRepoById(effective.id)?.webhookLastError ?? null;
      const priorErrorIsUpdateUncertain = currentError?.includes('update uncertain') ?? false;
      this.updateWebhookStatus(effective, {
        active: !error,
        lastCheckedAt: Date.now(),
        lastError: priorErrorIsUpdateUncertain && !selfHealPatched ? currentError : error,
      });
    } catch (error) {
      // Re-read the current error here too (same overlap reasoning as above).
      const currentError = this.repo.getWatchedRepoById(watched.id)?.webhookLastError ?? null;
      const priorErrorIsUpdateUncertain = currentError?.includes('update uncertain') ?? false;
      this.updateWebhookStatus(watched, {
        active: error instanceof GitHubApiError && error.status === 404 ? false : undefined,
        lastCheckedAt: Date.now(),
        lastError: priorErrorIsUpdateUncertain
          ? currentError
          : error instanceof Error
            ? error.message
            : String(error),
      });
      throw error;
    }
    const result = this.repo.getWatchedRepoById(watched.id);
    if (!result) throw new Error('Repository was removed during webhook check');
    return result;
  }

  private updateWebhookStatus(
    watched: GitHubWatchedRepo,
    status: {
      active?: boolean | null;
      lastCheckedAt?: number | null;
      lastError?: string | null;
    }
  ): void {
    if (watched.webhookAutoRegistered && watched.webhookRemoteId) {
      this.repo.updateSharedWebhookStatus(
        watched.owner,
        watched.repo,
        watched.webhookRemoteId,
        status
      );
      return;
    }
    this.repo.updateWebhookStatus(watched.id, status);
  }

  /**
   * Best-effort: if a daemon-managed (auto-registered) hook is missing required
   * events, PATCH it back to the repo-hook event set (`REPO_HOOK_WEBHOOK_EVENTS`,
   * which excludes app-only events like `merge_group` — GitHub rejects those on
   * repo hooks). Closes the gap left when the set grows (e.g. a new event type
   * like `pull_request_review_thread`) but the hook was registered before that
   * event existed and has not been re-registered since.
   *
   * Only daemon-managed hooks are touched; only when events are actually
   * missing (steady state does one GET, no PATCH). Reuses `updateRemoteWebhook`,
   * which re-affirms the full config with the stored secret (idempotent — no
   * rotation). Returns the post-reconciliation hook plus whether a PATCH was
   * issued (`patched` — callers must NOT clear a pre-existing "update uncertain"
   * error on a GET-only result, since a GET cannot verify which secret GitHub
   * retained), or null when the hook is not a reconcilable daemon-managed hook.
   * GET/PATCH errors propagate to the caller.
   */
  private async reconcileWebhookEvents(
    watched: GitHubWatchedRepo
  ): Promise<{ hook: GitHubHookResponse; patched: boolean } | null> {
    if (!watched.webhookAutoRegistered || !watched.webhookRemoteId || !watched.webhookSecret) {
      return null;
    }
    let hook: GitHubHookResponse;
    try {
      hook = await this.getRemoteWebhook(watched);
    } catch (error) {
      // A 404 means the configured remote hook is gone. Mark the shared rows
      // inactive (mirrors checkWebhook) so health doesn't keep reporting a
      // missing hook as active. Other GET failures (network, a permission 403)
      // leave the state uncertain — let the sweep log them and re-check next run.
      if (error instanceof GitHubApiError && error.status === 404) {
        this.updateWebhookStatus(watched, {
          active: false,
          lastCheckedAt: Date.now(),
          lastError: error.message,
        });
      }
      throw error;
    }
    if (missingRequiredEvents(hook).length === 0) return { hook, patched: false };
    // Reconciliation is event-only drift repair: only PATCH when missing events
    // is the SOLE problem. If the hook is also disabled or repointed on GitHub,
    // leave it — updateRemoteWebhook would force active:true and restore the
    // stored URL/secret, silently reverting a deliberate change. The health
    // write below still records the other error.
    if (!isOnlyMissingEvents(watched, hook)) return { hook, patched: false };
    const webhookUrl = watched.webhookUrl ?? getConfiguredWebhookUrl();
    try {
      hook = await this.updateRemoteWebhook(watched, webhookUrl, watched.webhookSecret);
    } catch (error) {
      // The GET proved the hook is missing required events, but the PATCH failed.
      // A GitHubApiError is a definitive rejection (422/403/404) → the hook
      // really can't deliver the new events, so mark it inactive. A NON-API
      // failure (transport timeout, abort, undecodable body) may have landed
      // AFTER GitHub applied the PATCH — don't flip active:false (markWebhookReceived
      // won't repair it while active=0, so it would stay falsely inactive until a
      // restart/manual check); record it as update-uncertain and leave the prior
      // active state. Mirrors autoConfigureWebhook's uncertainty handling.
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof GitHubApiError) {
        this.updateWebhookStatus(watched, {
          active: false,
          lastCheckedAt: Date.now(),
          lastError: message,
        });
      } else {
        this.updateWebhookStatus(watched, {
          lastCheckedAt: Date.now(),
          lastError: `webhook update uncertain: ${message}`,
        });
      }
      throw error;
    }
    return { hook, patched: true };
  }

  /**
   * Best-effort, non-blocking sweep over every daemon-managed hook at startup:
   * PATCH any that are missing required events so existing installations pick up
   * new webhook event types without a manual re-registration. Per-repo failures
   * are logged and skipped; honors the rate-limit window and stops if the
   * extension is stopped or a rate-limit is hit. Never throws — designed to be
   * fire-and-forget from `start()` (and directly callable for an on-demand
   * reconcile).
   */
  async reconcileManagedWebhooks(): Promise<void> {
    if (!(await this.resolveToken())) return;
    if (!(await this.isWebhookDeliveryEnabled())) return;
    if (Date.now() < this.rateLimitedUntil) return;
    // One entry per SHARED hook: listWebhookValidationRepos returns a row per
    // Space, but auto-registration shares one remote hook across Spaces for a
    // repo, so dedupe by (owner/repo, remoteId) to GET each distinct hook once.
    const seen = new Set<string>();
    const hooks = this.repo
      .listWebhookValidationRepos()
      .filter((r) => r.webhookAutoRegistered && r.webhookRemoteId && r.webhookSecret)
      .filter((r) => {
        const key = `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}:${r.webhookRemoteId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    for (const watched of hooks) {
      if (this.stopped) return;
      if (Date.now() < this.rateLimitedUntil) return;
      try {
        await this.reconcileSharedHook(watched.spaceId, watched.owner, watched.repo);
      } catch (error) {
        // githubFetch applies the shared cooldown for genuine rate limits (429,
        // or a 403 with X-RateLimit-Remaining: 0 / Retry-After) via
        // parseRateLimitHeaders. If it engaged, stop the sweep; otherwise this is
        // a per-hook failure (a bare permission 403, a PATCH 422, a transport
        // error) — log it and continue to the next hook.
        if (Date.now() < this.rateLimitedUntil) {
          log.warn('GitHub webhook reconcile paused — API rate-limited', {
            repo: `${watched.owner}/${watched.repo}`,
            status: error instanceof GitHubApiError ? error.status : undefined,
            retryAt: new Date(this.rateLimitedUntil).toISOString(),
          });
          return;
        }
        log.warn('GitHub webhook reconcile failed', {
          repo: `${watched.owner}/${watched.repo}`,
          status: error instanceof GitHubApiError ? error.status : undefined,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Under the per-hook lock, re-read the CURRENT watched row for a shared hook,
   * reconcile it, and sync the shared row's health. Re-reading inside the lock
   * is mandatory: the sweep snapshots rows before acquiring the lock, so a
   * concurrent autoConfigureWebhook serialized ahead of this callback may have
   * rotated the secret or replaced the hook — PATCHing the stale snapshot would
   * desync the remote secret and break signature verification. Mirrors the
   * re-read pattern used by checkWebhook/autoConfigureWebhook.
   *
   * Rate-limit errors (GitHubApiError 429/403) propagate so the sweep can pause.
   */
  private async reconcileSharedHook(spaceId: string, owner: string, repo: string): Promise<void> {
    await this.runExclusiveWebhookConfig(owner, repo, async () => {
      const current = this.repo.getWatchedRepo(spaceId, owner, repo);
      if (!current) return;
      const result = await this.reconcileWebhookEvents(current);
      if (!result) return;
      const { hook, patched } = result;
      const error = validateRemoteHook(current, hook);
      // A GET cannot verify which secret GitHub retained, so preserve a
      // pre-existing "update uncertain" error (left by an autoConfigure PATCH
      // that timed out) unless this reconcile PATCHed — a PATCH reaffirms the
      // stored secret, which is the only thing that resolves the uncertainty.
      // Mirrors checkWebhook's uncertainty handling.
      const currentError = this.repo.getWatchedRepoById(current.id)?.webhookLastError ?? null;
      const priorUncertain = currentError?.includes('update uncertain') ?? false;
      this.updateWebhookStatus(current, {
        active: !error,
        lastCheckedAt: Date.now(),
        lastError: patched || !priorUncertain ? error : currentError,
      });
    });
  }

  private async configureRemoteWebhook(
    params: { owner: string; repo: string },
    source: GitHubWatchedRepo | null,
    webhookUrl: string,
    secret: string
  ): Promise<GitHubHookResponse> {
    if (!source?.webhookRemoteId) {
      return await this.createRemoteWebhook(params.owner, params.repo, webhookUrl, secret);
    }
    try {
      return await this.updateRemoteWebhook(source, webhookUrl, secret);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        // The remote hook is confirmed gone; attempt to recreate it. If the
        // replacement POST also fails, mark the escaping error so the caller
        // knows the hook is definitively absent (not merely an update failure
        // that leaves the existing hook's status intact).
        try {
          return await this.createRemoteWebhook(params.owner, params.repo, webhookUrl, secret);
        } catch (createError) {
          // Only a definitive API failure (the POST reached GitHub and was
          // rejected, so no replacement hook exists) confirms the hook is gone.
          // A transport abort (timeout) on the POST may have committed a new
          // hook — leave it untagged so the caller treats it as uncertain
          // instead of marking the hook inactive while a new one may exist.
          if (createError instanceof GitHubApiError) {
            (createError as Error & { hookConfirmedDeleted?: boolean }).hookConfirmedDeleted = true;
          }
          throw createError;
        }
      }
      throw error;
    }
  }

  private async createRemoteWebhook(
    owner: string,
    repo: string,
    webhookUrl: string,
    secret: string
  ): Promise<GitHubHookResponse> {
    const repoPath = gitHubRepoPath(owner, repo);
    const response = await this.githubFetch(`/repos/${repoPath}/hooks`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: REPO_HOOK_WEBHOOK_EVENTS,
        config: {
          url: webhookUrl,
          content_type: 'json',
          secret,
          insecure_ssl: '0',
        },
      }),
    });
    return (await response.json()) as GitHubHookResponse;
  }

  private async updateRemoteWebhook(
    watched: GitHubWatchedRepo,
    webhookUrl: string,
    secret: string
  ): Promise<GitHubHookResponse> {
    const repoPath = gitHubRepoPath(watched.owner, watched.repo);
    const response = await this.githubFetch(`/repos/${repoPath}/hooks/${watched.webhookRemoteId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        active: true,
        events: REPO_HOOK_WEBHOOK_EVENTS,
        config: {
          url: webhookUrl,
          content_type: 'json',
          secret,
          insecure_ssl: '0',
        },
      }),
    });
    return (await response.json()) as GitHubHookResponse;
  }

  private async getRemoteWebhook(watched: GitHubWatchedRepo): Promise<GitHubHookResponse> {
    const repoPath = gitHubRepoPath(watched.owner, watched.repo);
    const response = await this.githubFetch(`/repos/${repoPath}/hooks/${watched.webhookRemoteId}`);
    return (await response.json()) as GitHubHookResponse;
  }

  private async deleteRemoteWebhookIfUnshared(watched: GitHubWatchedRepo): Promise<void> {
    if (!watched.webhookRemoteId) return;
    // Callers wrap this DELETE together with the watched-row removal/update in
    // runExclusiveWebhookConfig so the whole transition is atomic w.r.t. a
    // concurrent re-registration — locking only the DELETE would leave a gap
    // where a queued re-registration observes the still-present row and
    // recreates the hook before the row is removed.
    if (
      this.repo.countAutoRegisteredHookRefs(watched.owner, watched.repo, watched.webhookRemoteId) >
      1
    ) {
      return;
    }
    await this.deleteRemoteWebhook(watched);
  }

  private async deleteRemoteWebhook(watched: GitHubWatchedRepo): Promise<void> {
    if (!(await this.resolveToken())) {
      throw new Error('GITHUB_TOKEN is required to delete GitHub webhooks');
    }
    const repoPath = gitHubRepoPath(watched.owner, watched.repo);
    try {
      await this.githubFetch(`/repos/${repoPath}/hooks/${watched.webhookRemoteId}`, {
        method: 'DELETE',
      });
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return;
      if (!(error instanceof GitHubApiError)) {
        // Transport abort (timeout) mid-DELETE: the hook may already be deleted
        // remotely. Mark the cached status uncertain so the panel degrades
        // instead of reporting a possibly-deleted hook as active; a retry
        // reconciles it (a repeat DELETE 404s, confirming deletion).
        this.updateWebhookStatus(watched, {
          lastCheckedAt: Date.now(),
          lastError: `webhook deletion uncertain: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
      throw error;
    }
  }

  private async githubFetch(path: string, init: RequestInit = {}): Promise<Response> {
    // Capture the credential generation BEFORE resolving the token: a
    // setToken/clearToken rotation can land during the token-resolution await
    // (credential-store read) just as it can during the request itself, and
    // either bumps credentialGeneration and clears the cooldown
    // (resetRateLimitObservation). A rate-limit response from the rotated-away
    // token must not re-install a cooldown that blocks the new credential.
    // Mirrors the poll/validation paths' generation checks.
    const requestGeneration = this.credentialGeneration;
    const token = await this.resolveToken();
    if (!token) {
      throw new Error('GITHUB_TOKEN is required for GitHub API requests');
    }
    const response = await (this.options.fetchImpl ?? fetch)(`${GITHUB_API_BASE}${path}`, {
      ...init,
      // Bound each webhook-management request so a stalled GitHub response
      // cannot hang the RPC indefinitely — this makes the client RPC timeout a
      // real upper bound rather than a guess. A caller-provided signal wins.
      signal: init.signal ?? AbortSignal.timeout(GITHUB_WEBHOOK_REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'application/vnd.github+json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
        'User-Agent': 'HyperNeo-Space-GitHub/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
        ...init.headers,
      },
    });
    if (!response.ok) {
      // Apply the shared rate-limit cooldown for genuine rate-limited responses.
      // parseRateLimitHeaders catches 429 and 403-with-rate-limit-headers; a
      // headerless secondary/abuse limit (403/429 whose BODY looks like a limit)
      // is caught by inspecting the error text via isRateLimitError, as the
      // poll/validation paths do. This is the one place webhook-management calls
      // learn of a limit, so every caller (autoConfigure, checkWebhook, the sweep)
      // backs off uniformly. Only apply it for the credential that made the
      // request — a mid-flight setToken/clearToken rotation bumps
      // credentialGeneration and clears the cooldown, and the rotated-away
      // token's limit must not block the new credential.
      const errorText = await formatGitHubApiError(response);
      const rateLimit = parseRateLimitHeaders(response);
      const secondaryLimit =
        (response.status === 403 || response.status === 429) && isRateLimitError(errorText);
      if (
        requestGeneration === this.credentialGeneration &&
        (rateLimit.limited || secondaryLimit)
      ) {
        // A headerless secondary limit has no resetAt; applyRateLimit floors an
        // absent/past resetAt to the minimum backoff.
        this.applyRateLimit(
          {
            remaining: rateLimit.remaining,
            resetAt: rateLimit.limited ? rateLimit.resetAt : 0,
            limited: true,
            retryAfter: rateLimit.retryAfter,
          },
          true,
          credentialFingerprint(token)
        );
      }
      throw new GitHubApiError(response.status, errorText);
    }
    return response;
  }

  async pollWatchedRepo(
    watched: GitHubWatchedRepo,
    fetchImpl: typeof fetch = fetch
  ): Promise<number> {
    // Mark the cycle's credential generation so applyRateLimit / the end-of-cycle
    // rate-limit commit can discard observations if the credential changed
    // mid-flight (setToken/clearToken bumped the generation).
    this.pollCycleCredentialGeneration = this.credentialGeneration;
    // pollCycleCredentialFingerprint is set after the core resolves its token
    // (below), not here — lastResolvedToken at this point may be stale or null.
    try {
      return await this.pollWatchedRepoCore(watched, fetchImpl);
    } catch (err) {
      // A post-fetch failure (malformed/truncated JSON body, a publish error)
      // escapes the core before its end-of-cycle cursor commit, so lastPollAt
      // never advances and no error is recorded — a polling-only repo whose
      // first poll repeatedly fails during body decoding would stay Healthy.
      // Persist a partial-error so the health snapshot surfaces it (Degraded);
      // a later successful cycle recomputes and clears it. Skip when the
      // credential changed mid-cycle: the error belongs to the obsolete token
      // and resetRateLimitObservation already cleared the per-repo errors.
      if (this.pollCycleCredentialGeneration === this.credentialGeneration) {
        this.repo.recordPollFailure(
          watched.id,
          err instanceof Error ? err.message : 'poll cycle failed',
          this.pollCycleAccessible
        );
      }
      throw err;
    } finally {
      this.pollCycleCredentialGeneration = null;
      this.pollCycleCredentialFingerprint = null;
      this.pollCycleAccessible = false;
    }
  }

  private async pollWatchedRepoCore(
    watched: GitHubWatchedRepo,
    fetchImpl: typeof fetch = fetch
  ): Promise<number> {
    if (!this.context) return 0;
    let count = 0;
    const cursor = watched.pollCursor ?? {};
    const etags = cursor.etags ?? {};
    const processedPages = cursor.processedPages ?? {};
    const recentPullRequestNumbers = cursor.recentPullRequestNumbers ?? [];
    const recentPullRequestHeadShas = cursor.recentPullRequestHeadShas ?? {};
    const recentPullRequestHeadRepos = cursor.recentPullRequestHeadRepos ?? {};
    const checkRunEtags = cursor.checkRunEtags ?? {};
    const checkRunLegacyPrs = cursor.checkRunLegacyPrs ?? {};
    const checkRunHeadLastSeenAt = cursor.checkRunHeadLastSeenAt ?? {};
    let checkRunHeadPendingLastSeenAt = cursor.checkRunHeadPendingLastSeenAt ?? {};
    const checkRunPollingEnabledAt = cursor.checkRunPollingEnabledAt;
    const pullsSeedInProgress = cursor.pullsSeedInProgress ?? false;
    const seenReactionIds = cursor.seenReactionIds ?? {};
    const reactionEtags = cursor.reactionEtags ?? {};
    const endpointLastSeenAt = cursor.endpointLastSeenAt ?? {};
    const endpointPendingLastSeenAt = cursor.endpointPendingLastSeenAt ?? {};
    let nextPullsSeedInProgress = pullsSeedInProgress;
    const watermarks = {
      committed: cursor.lastSeenAt ?? watched.lastPollAt ?? 0,
      pending: cursor.pendingLastSeenAt ?? cursor.lastSeenAt ?? watched.lastPollAt ?? 0,
    };
    const base = `https://api.github.com/repos/${gitHubRepoPath(watched.owner, watched.repo)}`;
    const endpoints = [
      { key: 'issue_comments', path: '/issues/comments' },
      { key: 'review_comments', path: '/pulls/comments' },
      { key: 'pulls', path: '/pulls', extra: 'state=all&sort=updated&direction=desc' },
    ];
    const pullRequestNumbersByHeadRef = new Map<string, number[]>();
    for (const [prNumber, headSha] of Object.entries(recentPullRequestHeadShas)) {
      const headRepo =
        recentPullRequestHeadRepos[Number(prNumber)] ?? gitHubRepoPath(watched.owner, watched.repo);
      if (headSha)
        addPullRequestNumberByHeadRef(
          pullRequestNumbersByHeadRef,
          headRefKey(headRepo, headSha),
          Number(prNumber)
        );
    }
    let partialScan = false;
    let latestRateLimit: GitHubRateLimitInfo | undefined;
    // Track whether this cycle could actually reach the repo. A PAT that
    // validates via /user but lacks repo access makes every endpoint return
    // 403/404; without this the health rollup would treat polling as live.
    let accessible = false;
    let pollErrorMessage: string | null = null;
    // Advanced only when a reaction request actually succeeds this cycle.
    let reactionPolledAt: number | null = null;
    // Stays true only when every tracked reaction target was observed this
    // cycle (polled or returned 304). Any skip — budget exhaustion, a rate
    // limit, or a transient per-PR failure — flips it false so
    // lastReactionPollAt is not advanced: otherwise the first PR's success
    // would mask later PRs whose approvals were never observed, keeping the
    // repo falsely fresh and staleRepoCount at zero.
    let reactionsFullyPolled = true;
    // True when /pulls fetched any page beyond page 1 this cycle. The cutoff
    // may reset processedPages.pulls to 1, but page 1 was not re-fetched, so
    // cursor-seeded heads may be stale. Check-run polling is deferred until
    // page 1 is actually fetched and all tracked heads are confirmed fresh.
    let pullsFetchedResumedPage = false;

    const token = await this.resolveToken();
    // Now that this poll's actual token is resolved, capture its fingerprint so
    // applyRateLimit attributes the rate limit to the right credential. The
    // pollWatchedRepo wrapper cannot set this — lastResolvedToken there may be
    // stale or null before the core resolves its own token.
    this.pollCycleCredentialFingerprint = credentialFingerprint(token);
    for (const endpoint of endpoints) {
      const page = processedPages[endpoint.key] ?? 1;
      if (endpoint.key === 'pulls' && page > 1) pullsFetchedResumedPage = true;
      const query = new URLSearchParams();
      if (endpoint.extra) {
        for (const part of endpoint.extra.split('&')) {
          const [key, value = ''] = part.split('=');
          query.set(key, value);
        }
      }
      // Use this endpoint's own cursor when available. Falling back to the
      // shared committed watermark only preserves migration/initial-poll
      // behavior; after endpoint-local cursors exist, later endpoint scans must
      // not advance this endpoint's `since` and skip events that arrived between
      // endpoint requests.
      const savedEndpointWatermark = endpointLastSeenAt[endpoint.key] ?? 0;
      const seedCommentEndpointWatermark =
        savedEndpointWatermark === 0 &&
        watermarks.committed === 0 &&
        (endpoint.key === 'issue_comments' || endpoint.key === 'review_comments');
      const endpointWatermark = seedCommentEndpointWatermark
        ? Date.now() - COMMENT_ENDPOINT_INITIAL_LOOKBACK_MS
        : savedEndpointWatermark > 0
          ? savedEndpointWatermark
          : watermarks.committed;
      if (seedCommentEndpointWatermark) endpointLastSeenAt[endpoint.key] = endpointWatermark;
      const since = endpointWatermark ? new Date(endpointWatermark).toISOString() : undefined;
      // Seed reaction-poll targets on upgrade: a cursor from before reaction
      // polling shipped may have an `etags.pulls` entry but no
      // `recentPullRequestNumbers`. Suppress both `If-None-Match` and `since`
      // for that one pulls fetch so GitHub returns the full newest list (an
      // empty delta under `since` would leave reaction targets unseeded until
      // unrelated PR metadata changes).
      const pullsNeedsSeed =
        endpoint.key === 'pulls' &&
        (pullsSeedInProgress ||
          recentPullRequestNumbers.length === 0 ||
          (recentPullRequestNumbers.length > 0 &&
            Object.keys(recentPullRequestHeadShas).length === 0));
      if (since && !pullsNeedsSeed) query.set('since', since);
      query.set('per_page', '100');
      query.set('page', String(page));
      const url = `${base}${endpoint.path}?${query.toString()}`;
      const headers = gitHubPollingHeaders(token);
      if (page === 1 && etags[endpoint.key] && !pullsNeedsSeed) {
        headers['If-None-Match'] = etags[endpoint.key];
      }
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers,
          signal: AbortSignal.timeout(GITHUB_POLL_REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        // Network-level failure (connection reset, timeout, DNS…). Record it so
        // the health rollup surfaces an unreachable repo instead of throwing out
        // of pollWatchedRepo before the cursor (and its access/error signal) is
        // committed. Treat it like a failed endpoint and try the next.
        if (!pollErrorMessage) {
          pollErrorMessage = err instanceof Error ? err.message : 'network request failed';
        }
        // A network failure on any primary endpoint must not let the shared
        // lastSeenAt advance past it (same rationale as the HTTP-error branch),
        // so mark the scan partial and keep the watermark pending this cycle.
        partialScan = true;
        continue;
      }
      // Rate-limit check: a 403/429 response with rate-limit evidence OR a low
      // `remaining` counter defers this cycle and reschedules the next poll past
      // the reset epoch. The low-remaining guard is applied *after* processing a
      // successful response so already-fetched events are published and cursors
      // are saved; only the remaining endpoints in this cycle are skipped.
      const rateLimit = parseRateLimitHeaders(response);
      // Preserve a finite remaining budget across 304s: cached responses lack
      // rate-limit headers and parse as `remaining: Infinity`. Overwriting a
      // real low budget with Infinity would let the reaction loop bypass its
      // `< 100` guard and overspend the quota.
      latestRateLimit = mergeRateLimitInfo(latestRateLimit, rateLimit);
      if (rateLimit.limited) {
        // A 429 that does not exhaust the primary bucket (remaining > 0 and no
        // Retry-After) is a secondary/abuse limit. Do not use the unrelated
        // primary reset window; apply the minimum secondary backoff instead.
        if (response.status === 429 && rateLimit.remaining > 0 && !rateLimit.retryAfter) {
          this.applyRateLimit({
            remaining: rateLimit.remaining,
            resetAt: Date.now() + RATE_LIMIT_MIN_BACKOFF_MS,
            limited: true,
            retryAfter: true,
          });
        } else {
          this.applyRateLimit(rateLimit);
        }
        partialScan = true;
        break;
      }
      if (response.status === 304) {
        // A 304 proves GitHub accepted and scoped the request, so the repo is
        // reachable this cycle.
        accessible = true;
        this.pollCycleAccessible = true;
        continue;
      }
      if (!response.ok) {
        // A 403/429 without rate-limit headers can still be a secondary limit
        // if the body contains the right message (e.g. "secondary rate limit").
        // Read the body once and check; when it matches, apply a Retry-After/minimum
        // cooldown (not the unrelated primary reset) and stop hitting additional
        // endpoints until the backoff expires.
        const errorText = await response.text();
        if ((response.status === 403 || response.status === 429) && isRateLimitError(errorText)) {
          const secondaryDelayMs = rateLimit.retryAfter
            ? rateLimit.resetAt - Date.now()
            : RATE_LIMIT_MIN_BACKOFF_MS;
          this.applyRateLimit({
            remaining: rateLimit.remaining,
            resetAt: Date.now() + secondaryDelayMs,
            limited: true,
            retryAfter: true,
          });
          partialScan = true;
          break;
        }
        // Non-rate-limit failure (403/404/etc.) — most likely the token cannot
        // access this repo. Record it so the health rollup does not treat
        // polling as a live path when no endpoint was reachable.
        if (!pollErrorMessage) {
          pollErrorMessage = errorText.trim().slice(0, 160) || `HTTP ${response.status}`;
        }
        // Any failed primary endpoint must not let the shared lastSeenAt
        // advance past it: a later succeeding endpoint could otherwise commit a
        // newer row's timestamp, and the failed endpoint would retry with that
        // advanced `since` and permanently skip the rows in between. Marking
        // the scan partial keeps the watermark pending for this cycle. (For
        // `/pulls` this also skips check-run polling, which derives PR numbers
        // from the fetched `/pulls` data.)
        partialScan = true;
        continue;
      }
      accessible = true;
      this.pollCycleAccessible = true;
      const etag = response.headers.get('ETag');
      if (etag && page === 1) etags[endpoint.key] = etag;
      const payload = await response.json();
      let rows = rowsFromPollingPayload(payload, endpoint.key);
      let pullsBacklogClearedByCutoff = false;
      if (endpoint.key === 'pulls' && !pullsNeedsSeed && savedEndpointWatermark > 0) {
        // GitHub's /pulls endpoint ignores the `since` query param, so the only
        // reliable delta is a client-side cutoff. Rows are sorted by updated_at
        // descending; once a row is older than the endpoint watermark, every
        // subsequent row is older and can be skipped.
        //
        // Only apply the cutoff once a pulls-specific watermark exists. When
        // the cursor falls back to the shared `lastSeenAt` (e.g. a legacy
        // cursor with head SHAs but no endpointLastSeenAt.pulls), the shared
        // watermark may have been advanced by comments/check runs past a PR's
        // own updated_at. Skipping rows in that state would prevent the
        // head/open-state refresh below from running, leaving stale heads in
        // the cursor. Treat it as a seed fetch instead.
        const cutoffIndex = rows.findIndex((row) => {
          const updatedAt = pullRequestUpdatedAt(row);
          return updatedAt > 0 && updatedAt < endpointWatermark;
        });
        if (cutoffIndex !== -1) {
          rows = rows.slice(0, cutoffIndex);
          pullsBacklogClearedByCutoff = true;
        } else if (
          rows.length > 0 &&
          rows.length < 100 &&
          rows.every((row) => {
            const updatedAt = pullRequestUpdatedAt(row);
            return updatedAt > 0 && updatedAt <= endpointWatermark;
          })
        ) {
          // All rows on this partial page are at or before the watermark —
          // GitHub's second-precision timestamps can produce pages of tied rows
          // that never satisfy the strict < cutoff. Clear the backlog so
          // processedPages resets to 1 without dropping the rows (they are
          // re-processed but store-level dedupe suppresses duplicate events).
          // Only fire on partial pages (< 100 rows): a full page may be
          // followed by another tied page whose rows still need fetching for
          // head/open-state refresh.
        }
      }
      if (endpoint.key === 'pulls') {
        for (const row of rows) {
          const headSha = headShaFromPullRequest(row);
          const headRepo = headRepoFromPullRequest(row, watched);
          const prNumber = pullRequestNumberFrom(row);
          if (headSha && prNumber) {
            const previousHeadSha = recentPullRequestHeadShas[prNumber];
            const previousHeadRepo =
              recentPullRequestHeadRepos[prNumber] ?? gitHubRepoPath(watched.owner, watched.repo);
            if (!isPullRequestOpen(row)) {
              if (previousHeadSha) {
                const previousHeadRef = headRefKey(previousHeadRepo, previousHeadSha);
                removePullRequestNumberByHeadRef(
                  pullRequestNumbersByHeadRef,
                  previousHeadRef,
                  prNumber
                );
                clearCheckRunEtagsForHead(checkRunEtags, previousHeadRef);
              }
              delete recentPullRequestHeadShas[prNumber];
              delete recentPullRequestHeadRepos[prNumber];
              continue;
            }
            if (previousHeadSha && (previousHeadSha !== headSha || previousHeadRepo !== headRepo)) {
              const previousHeadRef = headRefKey(previousHeadRepo, previousHeadSha);
              removePullRequestNumberByHeadRef(
                pullRequestNumbersByHeadRef,
                previousHeadRef,
                prNumber
              );
              clearCheckRunEtagsForHead(checkRunEtags, previousHeadRef);
            }
            const headRef = headRefKey(headRepo, headSha);
            const previousHeadPrNumbers = [...(pullRequestNumbersByHeadRef.get(headRef) ?? [])];
            addPullRequestNumberByHeadRef(pullRequestNumbersByHeadRef, headRef, prNumber);
            if (!previousHeadPrNumbers.includes(prNumber)) {
              // A new PR joined this head: clear the ETag and reset the per-head
              // check-run watermark so older failed rows are re-evaluated for the
              // new PR. Store-level dedupe prevents duplicate delivery for PRs
              // that already received the event.
              clearCheckRunEtagsForHead(checkRunEtags, headRef);
              delete checkRunHeadLastSeenAt[headRef];
              delete checkRunHeadPendingLastSeenAt[headRef];
            }
            recentPullRequestHeadShas[prNumber] = headSha;
            recentPullRequestHeadRepos[prNumber] = headRepo;
          }
        }
      }
      if (endpoint.key === 'pulls' && page === 1) {
        // `/pulls?sort=updated&direction=desc` returns PRs newest-first. The
        // `since` watermark turns ordinary polls into deltas (only PRs updated
        // since the last poll arrive), so the response is not a full newest
        // list — replacing the saved targets would drop active PRs that did
        // not change this cycle. Merge instead: PRs observed this cycle
        // (newest-first) move to the front, previously tracked PRs that were
        // absent from the delta stay after them, and the list is capped to
        // LIMIT. Only page 1 is merged; page 2+ during backlog catch-up
        // contains older PRs and must not displace the newest ones.
        const freshNumbers: number[] = [];
        const closedNumbers = new Set<number>();
        for (const row of rows) {
          const prNumber = pullRequestNumberFrom(row);
          if (!prNumber) continue;
          // Reaction approvals are only meaningful on open PRs under review.
          // A previously-tracked PR that the delta now reports as closed/
          // merged must be dropped so it stops occupying a reaction slot.
          if (isPullRequestOpen(row)) {
            if (!freshNumbers.includes(prNumber)) freshNumbers.push(prNumber);
          } else {
            closedNumbers.add(prNumber);
          }
        }
        const next = [
          ...freshNumbers,
          ...recentPullRequestNumbers.filter(
            (n) => !freshNumbers.includes(n) && !closedNumbers.has(n)
          ),
        ];
        recentPullRequestNumbers.length = 0;
        recentPullRequestNumbers.push(...next.slice(0, REACTION_POLL_PR_LIMIT));
      }
      let endpointPending = Math.max(
        endpointWatermark,
        endpointPendingLastSeenAt[endpoint.key] ?? 0
      );
      for (const row of rows) {
        const event = normalizeGitHubPollingRow(watched, row, endpoint.key);
        if (event) {
          await this.publishEvent(watched.spaceId, event, this.context);
          endpointPending = Math.max(endpointPending, event.occurredAt);
          watermarks.pending = Math.max(watermarks.pending, event.occurredAt);
          count++;
        }
      }
      processedPages[endpoint.key] = pullsBacklogClearedByCutoff
        ? 1
        : rows.length >= 100
          ? page + 1
          : 1;
      if (endpoint.key === 'pulls')
        nextPullsSeedInProgress = pullsNeedsSeed && processedPages.pulls > 1;
      // Only advance the per-endpoint watermark once the endpoint's backlog is
      // complete. While pages remain, the next poll must keep using the old
      // watermark so remaining pages are not filtered out by `since`.
      if (processedPages[endpoint.key] === 1) {
        if (
          endpoint.key === 'pulls' &&
          endpointPending > 0 &&
          endpointPending === endpointWatermark
        ) {
          // The backlog cleared without the endpoint pending advancing past
          // the watermark — every processed row was tied at the watermark
          // (GitHub timestamps are second-precision). Without a bump, the next
          // page-1 fetch would recreate the backlog from the same tied rows,
          // permanently starving check-run polling. Advance by 1ms: no PR can
          // have updated_at between watermark and watermark+1ms, so no events
          // are missed, and the strict < cutoff fires on the next cycle.
          endpointPending = endpointWatermark + 1;
        }
        if (endpointPending > 0) {
          endpointLastSeenAt[endpoint.key] = endpointPending;
        } else {
          delete endpointLastSeenAt[endpoint.key];
        }
        delete endpointPendingLastSeenAt[endpoint.key];
      } else {
        endpointPendingLastSeenAt[endpoint.key] = endpointPending;
      }
      if (rateLimit.remaining < RATE_LIMIT_LOW_REMAINING_THRESHOLD) {
        this.applyRateLimit(rateLimit);
        partialScan = true;
        break;
      }
    }

    const hasBacklog = Object.values(processedPages).some((page) => page > 1);
    // pullsHasBacklog is true when /pulls still has unprocessed pages OR when a
    // resumed page (> 1) was fetched this cycle — even if the cutoff cleared
    // processedPages back to 1. In the cutoff case page 1 was not re-fetched,
    // so cursor-seeded heads may be stale (closed/force-pushed). Deferring
    // check-run polling until page 1 is fetched ensures all tracked heads are
    // confirmed fresh before scanning.
    const pullsHasBacklog = (processedPages.pulls ?? 1) > 1 || pullsFetchedResumedPage;

    if (!partialScan && !pullsHasBacklog) {
      const checkRunEndpointKey = 'check_runs';
      let checkRunPermissionDenied = false;
      // Rate-limit / repo-wide denial stops the entire head loop. Transient
      // per-head failures (500/502) skip the failing head but let the loop
      // continue to the next head.
      let checkRunRateLimited = false;
      // The base seed for heads that have no per-head cursor (first scan or
      // reset after a PR-set change). Deliberately excludes
      // endpointLastSeenAt (the max of all committed per-head watermarks) so
      // a reset head is not filtered by another head's advanced cursor.
      const baseCheckRunWatermark = checkRunPollingEnabledAt ?? watermarks.committed;
      const watchedBaseRepoPath = gitHubRepoPath(watched.owner, watched.repo);
      for (const [headRef, prNumbers] of pullRequestNumbersByHeadRef) {
        const { repoPath: headRepoPath, headSha } = parseHeadRefKey(headRef);
        const fallbackPrNumbers = prNumbers;
        const headWatermark =
          checkRunHeadLastSeenAt[headRef] ??
          checkRunHeadPendingLastSeenAt[headRef] ??
          baseCheckRunWatermark;
        let headPending = Math.max(headWatermark, checkRunHeadPendingLastSeenAt[headRef] ?? 0);
        // headSucceeded is only true when EVERY queried repo path completed
        // without error, so a failed fork leg does not advance the per-head
        // cursor past failures the fork leg never saw.
        let headSucceeded = true;
        let headPruned = false;
        // For fork heads, also query the watched base repo because GitHub
        // Actions `pull_request` workflows create check runs under the base
        // repo, not the fork.
        const repoPathsToQuery =
          headRepoPath !== watchedBaseRepoPath
            ? [headRepoPath, watchedBaseRepoPath]
            : [headRepoPath];
        // Track check identity (name + app) whose latest conclusion is
        // non-failure so earlier superseded failures are not replayed. Rows from
        // `filter=all` arrive newest-first, so the first conclusion seen for a
        // name+app is the latest.
        const supersededCheckKeys = new Set<string>();
        const seenCheckRunIds = new Set<number | string>();
        for (const checkRunRepoPath of repoPathsToQuery) {
          if (headPruned) break;
          let page = 1;
          while (true) {
            const query = new URLSearchParams({
              status: 'completed',
              filter: 'all',
              per_page: '100',
              page: String(page),
            });
            const checkRunHeaders = gitHubPollingHeaders(token);
            // ETag key includes the repo path so fork and base repo responses
            // cache independently and do not cross-pollinate If-None-Match.
            const checkRunEtagKey = `${headRef}:${checkRunRepoPath}:page:${page}`;
            if (checkRunEtags[checkRunEtagKey]) {
              checkRunHeaders['If-None-Match'] = checkRunEtags[checkRunEtagKey];
            }
            let response: Response;
            try {
              response = await fetchImpl(
                `${GITHUB_API_BASE}/repos/${checkRunRepoPath}/commits/${encodeURIComponent(headSha)}/check-runs?${query.toString()}`,
                {
                  headers: checkRunHeaders,
                  signal: AbortSignal.timeout(GITHUB_POLL_REQUEST_TIMEOUT_MS),
                }
              );
            } catch (err) {
              // Network-level failure mid-check-run. Record it as a partial
              // error (some primary endpoints already succeeded) and abandon
              // this head rather than aborting the whole cycle.
              if (!pollErrorMessage) {
                pollErrorMessage = err instanceof Error ? err.message : 'network request failed';
              }
              partialScan = true;
              headSucceeded = false;
              break;
            }
            const rateLimit = parseRateLimitHeaders(response);
            latestRateLimit = mergeRateLimitInfo(latestRateLimit, rateLimit);
            if (rateLimit.limited) {
              if (response.status === 429 && rateLimit.remaining > 0 && !rateLimit.retryAfter) {
                this.applyRateLimit({
                  remaining: rateLimit.remaining,
                  resetAt: Date.now() + RATE_LIMIT_MIN_BACKOFF_MS,
                  limited: true,
                  retryAfter: true,
                });
              } else {
                this.applyRateLimit(rateLimit);
              }
              partialScan = true;
              checkRunRateLimited = true;
              headSucceeded = false;
              break;
            }
            if (response.status === 304) {
              break;
            }
            if (!response.ok) {
              const errorText = await response.text();
              if (
                (response.status === 403 || response.status === 429) &&
                isRateLimitError(errorText)
              ) {
                const secondaryDelayMs = rateLimit.retryAfter
                  ? rateLimit.resetAt - Date.now()
                  : RATE_LIMIT_MIN_BACKOFF_MS;
                this.applyRateLimit({
                  remaining: rateLimit.remaining,
                  resetAt: Date.now() + secondaryDelayMs,
                  limited: true,
                  retryAfter: true,
                });
                partialScan = true;
                checkRunRateLimited = true;
                headSucceeded = false;
                break;
              }
              if (response.status === 403) {
                // A 403 on a fork head repository means the token cannot read
                // that contributor fork; skip this repo path but keep scanning
                // the remaining heads. Only treat a 403 on the watched base repo
                // as repo-wide denial.
                if (checkRunRepoPath !== watchedBaseRepoPath) {
                  clearCheckRunEtagsForHead(checkRunEtags, headRef);
                  // Record as a partial error so the health badge reflects that
                  // fork-hosted check runs are unobservable — without this a
                  // successful base-repo leg + primary endpoints would advance
                  // lastPollAt, clear the prior partial error, and badge Healthy
                  // while fork check-run events are repeatedly missed.
                  if (!pollErrorMessage) {
                    pollErrorMessage = 'fork check-runs inaccessible (HTTP 403)';
                  }
                  headSucceeded = false;
                  break;
                }
                checkRunPermissionDenied = true;
                // Record as a partial error so the health badge reflects that
                // check-run events are being dropped (token lacks this scope).
                if (!pollErrorMessage) {
                  pollErrorMessage = 'check-runs permission denied (HTTP 403)';
                }
                headSucceeded = false;
                break;
              }
              if (response.status === 404 || response.status === 422) {
                if (checkRunRepoPath === headRepoPath) {
                  for (const prNumber of prNumbers) {
                    delete recentPullRequestHeadShas[prNumber];
                    delete recentPullRequestHeadRepos[prNumber];
                  }
                  delete checkRunEtags[checkRunEtagKey];
                  pullRequestNumbersByHeadRef.delete(headRef);
                  // Head was pruned — stop scanning all remaining repo paths so
                  // the base-repo leg does not publish for a deleted head.
                  headPruned = true;
                }
                break;
              }
              // Other non-rate-limit failures (500/502/etc.) stop check-run
              // scanning for this repo path but do not block reaction polling.
              if (!pollErrorMessage) {
                pollErrorMessage =
                  errorText.trim().slice(0, 160) || `check-runs HTTP ${response.status}`;
              }
              headSucceeded = false;
              break;
            }
            const rows = rowsFromPollingPayload(await response.json(), checkRunEndpointKey);
            let reachedOldRows = false;
            for (const row of rows) {
              const rowOccurredAt = checkRunOccurredAt(row);
              if (rowOccurredAt < headWatermark) {
                // Rows are newest-first; once we pass the watermark, all
                // remaining rows are older. Stop paginating to conserve API
                // budget.
                reachedOldRows = true;
                break;
              }
              headPending = Math.max(headPending, rowOccurredAt);
              const checkRunId = checkRunIdFrom(row);
              // Dedupe across fork + base repo queries for the same head SHA.
              if (seenCheckRunIds.has(checkRunId)) continue;
              seenCheckRunIds.add(checkRunId);
              const checkName = checkRunNameFrom(row);
              const appKey = checkRunAppKeyFrom(row);
              const supersessionKey = `${checkName}:${appKey}`;
              const conclusion = checkRunConclusionFrom(row);
              // Suppress superseded failures: if a newer run of the same check
              // name+app concluded non-failure, skip this older failed row.
              if (supersededCheckKeys.has(supersessionKey)) continue;
              if (isNonFailureConclusion(conclusion)) {
                supersededCheckKeys.add(supersessionKey);
                continue;
              }
              const checkRunPrNumbers = pullRequestNumbersFromCheckRun(
                row,
                pullRequestNumbersByHeadRef,
                fallbackPrNumbers
              );
              const checkRunLegacyKey = `${checkRunId}:${conclusion}`;
              const recordedLegacyPr = checkRunLegacyPrs[checkRunLegacyKey];
              const unscopedDedupeKey = `${watched.owner.toLowerCase()}/${watched.repo.toLowerCase()}:check_run:${checkRunId}:${conclusion}`;
              const existingEvent =
                recordedLegacyPr === undefined
                  ? this.eventStore.getByDedupe(watched.spaceId, this.sourceId, unscopedDedupeKey)
                  : null;
              const existingLegacyPr =
                existingEvent && typeof existingEvent.event.payload.prNumber === 'number'
                  ? existingEvent.event.payload.prNumber
                  : undefined;
              if (existingLegacyPr !== undefined && !(checkRunLegacyKey in checkRunLegacyPrs)) {
                checkRunLegacyPrs[checkRunLegacyKey] = existingLegacyPr;
              }
              // The unscoped legacy key belongs to the recorded/existing owner,
              // not whichever PR happens to be first in the fan-out list.
              const legacyOwner = recordedLegacyPr ?? existingLegacyPr ?? checkRunPrNumbers[0]!;
              const legacyPrInFanOut = checkRunPrNumbers.includes(legacyOwner);
              for (const checkRunPrNumber of checkRunPrNumbers) {
                const isLegacyPr = legacyPrInFanOut && checkRunPrNumber === legacyOwner;
                const prScopedDedupe = !isLegacyPr;
                const event = normalizeGitHubCheckRun({
                  repo: watched,
                  checkRun: row,
                  source: 'polling',
                  deliveryId: `poll:check_run:${checkRunId}:${checkRunPrNumber}`,
                  rawPayload: row,
                  prNumber: checkRunPrNumber,
                  prScopedDedupe,
                });
                if (!event) continue;
                await this.publishEvent(watched.spaceId, event, this.context);
                if (!prScopedDedupe && !(checkRunLegacyKey in checkRunLegacyPrs)) {
                  checkRunLegacyPrs[checkRunLegacyKey] = checkRunPrNumber;
                }
                watermarks.pending = Math.max(watermarks.pending, event.occurredAt);
                count++;
              }
            }
            if (reachedOldRows) {
              const checkRunEtag = response.headers.get('ETag');
              if (checkRunEtag) checkRunEtags[checkRunEtagKey] = checkRunEtag;
              break;
            }
            if (rateLimit.remaining < RATE_LIMIT_LOW_REMAINING_THRESHOLD) {
              this.applyRateLimit(rateLimit);
              partialScan = true;
              checkRunRateLimited = true;
              headSucceeded = false;
              break;
            }
            const checkRunEtag = response.headers.get('ETag');
            if (rows.length < 100) {
              if (checkRunEtag) checkRunEtags[checkRunEtagKey] = checkRunEtag;
              break;
            }
            delete checkRunEtags[checkRunEtagKey];
            page++;
          }
          if (checkRunRateLimited || checkRunPermissionDenied) break;
        }
        // A skipped/failed head keeps its previous cursor; only successful heads
        // advance their pending watermark this cycle.
        if (headSucceeded) {
          checkRunHeadPendingLastSeenAt[headRef] = headPending;
        }
        if (checkRunRateLimited || checkRunPermissionDenied) break;
      }
      if (checkRunRateLimited || checkRunPermissionDenied || hasBacklog) {
        // Rate-limit or repo-wide denial: leave all per-head watermarks pending
        // so every head resumes from its last committed cursor on the next poll.
      } else {
        // Commit successful heads. Heads that hit transient failures never
        // updated their pending entry, so they keep their prior committed value.
        for (const [headRef, headPending] of Object.entries(checkRunHeadPendingLastSeenAt)) {
          checkRunHeadLastSeenAt[headRef] = headPending;
        }
        checkRunHeadPendingLastSeenAt = {};
        const maxHeadWatermark = Math.max(0, ...Object.values(checkRunHeadLastSeenAt));
        if (maxHeadWatermark > 0) endpointLastSeenAt[checkRunEndpointKey] = maxHeadWatermark;
        delete endpointPendingLastSeenAt[checkRunEndpointKey];
      }
    }

    // Reaction polling: skip entirely if the primary scan was rate-limited,
    // and stop as soon as the remaining budget drops near the floor. Reactions
    // are review-approval signals, not primary content — defer them when the
    // rate-limit budget is tight so comments/reviews/PR metadata keep flowing.
    for (const prNumber of recentPullRequestNumbers.slice(0, REACTION_POLL_PR_LIMIT)) {
      if (partialScan) break;
      if (!canPollReactions(latestRateLimit?.remaining)) {
        // Budget too low to poll the remaining PRs: do NOT advance the shared
        // watermark this cycle. Otherwise the stale-reaction guard would mark
        // skipped +1s as seen next cycle and never publish them. ETags make the
        // next cycle's primary-endpoint re-poll cheap (304s are free).
        reactionsFullyPolled = false;
        partialScan = true;
        break;
      }
      const query = new URLSearchParams({ per_page: '100' });
      const reactionHeaders = gitHubPollingHeaders(token);
      if (reactionEtags[prNumber]) reactionHeaders['If-None-Match'] = reactionEtags[prNumber];
      let response: Response;
      try {
        response = await fetchImpl(`${base}/issues/${prNumber}/reactions?${query.toString()}`, {
          headers: reactionHeaders,
          signal: AbortSignal.timeout(GITHUB_POLL_REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        // Network-level failure mid-reaction: record a partial error and move
        // to the next PR rather than aborting the cycle before the cursor
        // commits its access/error signal.
        if (!pollErrorMessage) {
          pollErrorMessage = err instanceof Error ? err.message : 'network request failed';
        }
        reactionsFullyPolled = false;
        partialScan = true;
        continue;
      }
      const reactionRateLimit = parseRateLimitHeaders(response);
      latestRateLimit = mergeRateLimitInfo(latestRateLimit, reactionRateLimit);
      if (response.status === 304) {
        // Reaction list unchanged since the last poll — keep the ETag and
        // skip the PR. 304s do not count against the rate-limit budget. A 304
        // still proves the reaction endpoint was actually checked this cycle.
        reactionPolledAt = Date.now();
        continue;
      }
      if (reactionRateLimit.limited) {
        // Mirror the primary-endpoint branch: a 429 that does not exhaust the
        // primary bucket (remaining > 0 and no Retry-After) is a secondary /
        // abuse limit. Applying the primary reset window here would stall all
        // polling for up to an hour; use the minimum secondary backoff instead.
        if (
          response.status === 429 &&
          reactionRateLimit.remaining > 0 &&
          !reactionRateLimit.retryAfter
        ) {
          this.applyRateLimit({
            remaining: reactionRateLimit.remaining,
            resetAt: Date.now() + RATE_LIMIT_MIN_BACKOFF_MS,
            limited: true,
            retryAfter: true,
          });
        } else {
          this.applyRateLimit(reactionRateLimit);
        }
        reactionsFullyPolled = false;
        partialScan = true;
        break;
      }
      if (!response.ok) {
        // Mirror the primary-endpoint secondary-limit handling: a 403/429
        // without rate-limit headers can still be a secondary limit when the
        // body says so. Apply the short secondary backoff instead of burning
        // requests on the remaining PRs.
        const errorText = await response.text();
        if ((response.status === 403 || response.status === 429) && isRateLimitError(errorText)) {
          const secondaryDelayMs = reactionRateLimit.retryAfter
            ? reactionRateLimit.resetAt - Date.now()
            : RATE_LIMIT_MIN_BACKOFF_MS;
          this.applyRateLimit({
            remaining: reactionRateLimit.remaining,
            resetAt: Date.now() + secondaryDelayMs,
            limited: true,
            retryAfter: true,
          });
          reactionsFullyPolled = false;
          partialScan = true;
          break;
        }
        // Transient non-rate-limit failure (500/502/503/404/403-scope/etc.).
        // Mark a partial scan so the shared watermark does not advance past this
        // PR's un-observed +1; otherwise the stale-reaction guard would mark it
        // seen next cycle and never publish the approval. Try the next PR.
        if (!pollErrorMessage) {
          pollErrorMessage = errorText.trim().slice(0, 160) || `reactions HTTP ${response.status}`;
        }
        reactionsFullyPolled = false;
        partialScan = true;
        continue;
      }
      reactionPolledAt = Date.now();
      const reactions = (await response.json()) as unknown[];
      const reactionEtag = response.headers.get('ETag');
      if (reactionEtag) reactionEtags[prNumber] = reactionEtag;
      for (const reaction of reactions) {
        if (!isPositiveReaction(reaction)) continue;
        const reactionId = reactionIdFrom(reaction);
        if (seenReactionIds[reactionId]) continue;
        const event = normalizeGitHubReaction(watched, prNumber, reaction);
        if (!event) continue;
        // Suppress historical backfill: on an upgraded repo the first reaction
        // sync would otherwise publish every prior +1 as a fresh
        // `reaction_added`. Only publish reactions at least as new as the
        // committed poll watermark; older ones are marked seen so they never
        // fire on a later cycle either. A brand-new repo (committed == 0) still
        // backfills its first observation, which is the intended bootstrap.
        if (watermarks.committed > 0 && event.occurredAt < watermarks.committed) {
          seenReactionIds[reactionId] = true;
          continue;
        }
        await this.publishEvent(watched.spaceId, event, this.context);
        seenReactionIds[reactionId] = true;
        count++;
      }
      // Mirror the primary-endpoint low-budget guard: a successful reaction
      // response with `remaining` below the safety threshold must apply the
      // shared deferral so `pollEnabledSpaces()` stops hitting the next repo
      // and the next cycle is rescheduled past the reset window.
      if (
        Number.isFinite(reactionRateLimit.remaining) &&
        reactionRateLimit.remaining < RATE_LIMIT_LOW_REMAINING_THRESHOLD
      ) {
        this.applyRateLimit(reactionRateLimit);
        reactionsFullyPolled = false;
        partialScan = true;
        break;
      }
    }

    // Prune reaction ETags for PRs that are no longer reaction-poll targets
    // so the cursor does not grow unbounded across a repo's lifetime.
    const trackedPrSet = new Set(recentPullRequestNumbers);
    for (const key of Object.keys(reactionEtags)) {
      if (!trackedPrSet.has(Number(key))) delete reactionEtags[Number(key)];
    }
    // Prune per-head check-run cursors for heads that are no longer tracked.
    const trackedHeadSet = new Set(pullRequestNumbersByHeadRef.keys());
    for (const key of Object.keys(checkRunHeadLastSeenAt)) {
      if (!trackedHeadSet.has(key)) delete checkRunHeadLastSeenAt[key];
    }
    for (const key of Object.keys(checkRunHeadPendingLastSeenAt)) {
      if (!trackedHeadSet.has(key)) delete checkRunHeadPendingLastSeenAt[key];
    }
    for (const key of Object.keys(checkRunEtags)) {
      let etagTracked = false;
      for (const headRef of trackedHeadSet) {
        if (key.startsWith(`${headRef}:`)) {
          etagTracked = true;
          break;
        }
      }
      if (!etagTracked) delete checkRunEtags[key];
    }
    // After a partial scan, do not advance the shared watermark; skipped
    // endpoints would miss events between the old watermark and the new one.
    // The processed endpoint's own watermark is recorded separately. Also keep
    // the shared cursor pending when check-run polling was deferred due to a
    // resumed /pulls page (pullsFetchedResumedPage): advancing lastSeenAt would
    // shift the check-run baseline for legacy cursors without
    // checkRunPollingEnabledAt, skipping failures on heads first discovered on
    // the cut-off page.
    const pullsCheckRunDeferred = pullsFetchedResumedPage;
    // True when the credential changed under this in-flight cycle — its
    // credential-scoped error observations are obsolete and must not be written
    // back over the values resetRateLimitObservation cleared.
    const credentialGenerationStale =
      this.pollCycleCredentialGeneration !== null &&
      this.pollCycleCredentialGeneration !== this.credentialGeneration;
    // Resolve the committed access-error fields up front so the partial-error
    // rule can reference the full-error one.
    //  - accessible: a clean cycle clears both; a later-endpoint failure records
    //    the partial error (full access error stays null).
    //  - !accessible with a new error: a full access failure this cycle
    //    (supersedes any prior partial error → clear it).
    //  - !accessible with no new error (e.g. a pre-access rate-limit break):
    //    preserve the prior errors — this cycle proved neither recovery nor a
    //    new failure, so a stale cooldown expiry must not badge the repo Healthy
    //    over an still-unresolved prior partial error.
    const committedLastPollError = credentialGenerationStale
      ? null
      : accessible
        ? null
        : (pollErrorMessage ?? cursor.lastPollError ?? null);
    const committedLastPartialPollError = credentialGenerationStale
      ? null
      : accessible
        ? pollErrorMessage != null
          ? pollErrorMessage
          : // Accessible but incomplete (rate-limited/backlog before all required
            // endpoints were checked): preserve a prior partial error if present,
            // otherwise record an incomplete-cycle diagnostic so the rollup
            // degrades (lastPollAt advancing must not badge Healthy when some
            // endpoints went unchecked). A later complete clean cycle clears it.
            partialScan || hasBacklog || pullsCheckRunDeferred
            ? (cursor.lastPartialPollError ?? 'poll cycle incomplete — some endpoints unchecked')
            : null
        : committedLastPollError != null
          ? null
          : (cursor.lastPartialPollError ?? null);
    const cursorPayload: PollCursor = {
      lastSeenAt:
        partialScan || hasBacklog || pullsCheckRunDeferred
          ? watermarks.committed
          : watermarks.pending,
      pendingLastSeenAt:
        partialScan || hasBacklog || pullsCheckRunDeferred ? watermarks.pending : undefined,
      etags,
      processedPages,
      recentPullRequestNumbers,
      recentPullRequestHeadShas,
      recentPullRequestHeadRepos,
      checkRunEtags,
      checkRunLegacyPrs,
      checkRunPollingEnabledAt,
      checkRunHeadLastSeenAt,
      checkRunHeadPendingLastSeenAt,
      pullsSeedInProgress: nextPullsSeedInProgress,
      seenReactionIds,
      reactionEtags,
      endpointLastSeenAt,
      endpointPendingLastSeenAt,
      // Null when this cycle reached at least one endpoint (accessible); the
      // last access error otherwise. Left untouched (preserved) when the cycle
      // broke on a rate-limit before any access attempt. When the credential
      // changed mid-cycle, force null so the obsolete cycle does not write the
      // old credential's errors back over the values resetRateLimitObservation
      // cleared (the new credential re-discovers any persistent error).
      lastPollError: committedLastPollError,
      // A partial failure: some endpoints reached, a later required one failed.
      // Only meaningful when accessible; null on a clean cycle or full failure.
      // Preserved across a pre-access rate-limit break (no new error) so an
      // unresolved prior partial error is not silently cleared.
      lastPartialPollError: committedLastPartialPollError,
      // Advanced only when this cycle observed EVERY tracked reaction target.
      // A partial reaction scan — any PR skipped for budget, a rate limit, or a
      // transient failure — leaves later PRs' approvals unobserved, so the repo
      // must not read as freshly polled off the first PR's success. Preserve the
      // prior committed timestamp when incomplete; persistent skips let it age
      // past the stale window so staleRepoCount surfaces the gap.
      lastReactionPollAt: reactionsFullyPolled
        ? (reactionPolledAt ?? cursor.lastReactionPollAt ?? null)
        : (cursor.lastReactionPollAt ?? null),
      // Durable credential fingerprint: survives restarts (same token → same
      // fingerprint; rotated token → different). The rollup checks this instead
      // of the process-local generation counter.
      lastPollCredentialFingerprint: accessible
        ? credentialFingerprint(token)
        : cursor.lastPollCredentialFingerprint,
    };
    // Only advance `last_poll_at` (the health rollup's polling-freshness signal)
    // when this cycle actually reached an endpoint. A cycle that broke on a
    // short rate-limit before any 200/304 must not stamp a fresh lastPollAt —
    // otherwise a never-accessed repo badges Healthy until the next interval.
    if (accessible) {
      this.repo.updatePollCursor(watched.id, cursorPayload);
    } else {
      this.repo.updatePollCursorJson(watched.id, cursorPayload);
    }
    // Retain the cycle's rate-limit snapshot so the health panel can report the
    // current `remaining`/`reset` budget. Merge (not overwrite) so an all-304
    // cycle — which carries no rate-limit headers and parses as a non-finite
    // snapshot — does not clobber a previously observed finite budget. Only
    // stamp `observedAt` when this cycle actually saw finite rate-limit headers.
    if (latestRateLimit) {
      // Discard if the credential changed mid-cycle — the snapshot belongs to
      // the old token and would mis-report the replacement's budget.
      if (this.pollCycleCredentialGeneration === this.credentialGeneration) {
        this.lastRateLimitInfo = mergeRateLimitInfo(this.lastRateLimitInfo, latestRateLimit);
        if (Number.isFinite(latestRateLimit.remaining)) {
          this.lastRateLimitObservedAt = Date.now();
        }
      }
    }
    return count;
  }
}

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * Required webhook events the remote hook is NOT subscribed to. Empty when the
 * hook is in sync (or subscribes to all events via `*`). Shared by
 * `validateRemoteHook` (to flag the error) and `reconcileWebhookEvents` (to
 * decide whether a daemon-managed hook needs PATCHing back into sync).
 */
function missingRequiredEvents(hook: GitHubHookResponse): string[] {
  const events = new Set(hook.events ?? []);
  if (events.has('*')) return [];
  return REQUIRED_WEBHOOK_EVENTS.filter((event) => !events.has(event));
}

function validateRemoteHook(watched: GitHubWatchedRepo, hook: GitHubHookResponse): string | null {
  if (!hook.active) return 'GitHub webhook is disabled';
  if (watched.webhookUrl && hook.config?.url !== watched.webhookUrl) {
    return 'GitHub webhook URL does not match this HyperNeo endpoint';
  }
  if (hook.config?.content_type !== 'json') {
    return 'GitHub webhook content type must be JSON';
  }
  const missingEvents = missingRequiredEvents(hook);
  if (missingEvents.length > 0) {
    return `GitHub webhook is missing events: ${missingEvents.join(', ')}`;
  }
  return null;
}

/**
 * True when the ONLY thing wrong with `hook` is missing required events — it is
 * active, points at this daemon's endpoint (when one is stored) with JSON
 * content type, and is merely behind the repo-hook event set
 * (`REPO_HOOK_WEBHOOK_EVENTS`). Reconciliation is event-only drift repair: it
 * must NOT fire when the hook is also disabled or has been repointed on GitHub,
 * since `updateRemoteWebhook` would force `active: true` and restore the stored
 * URL/secret, silently reverting a deliberate change. Mirrors the non-event
 * preconditions of `validateRemoteHook`.
 */
function isOnlyMissingEvents(watched: GitHubWatchedRepo, hook: GitHubHookResponse): boolean {
  if (!hook.active) return false;
  if (watched.webhookUrl && hook.config?.url !== watched.webhookUrl) return false;
  if (hook.config?.content_type !== 'json') return false;
  return missingRequiredEvents(hook).length > 0;
}

async function assertRpcConfigEnabled(
  context: ExternalEventExtensionContext,
  sourceId: string
): Promise<void> {
  const global = await context.config.getGlobalConfig(sourceId);
  if (!global.globallyEnabled || !global.capabilities.rpcConfig) {
    throw new Error('GitHub RPC configuration capability is disabled');
  }
}

async function assertWebhookCapabilityEnabled(
  context: ExternalEventExtensionContext,
  sourceId: string
): Promise<void> {
  const global = await context.config.getGlobalConfig(sourceId);
  if (!global.globallyEnabled || global.capabilities.webhooks === false) {
    throw new Error('GitHub webhook capability is disabled');
  }
}

function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Accepted GitHub token prefixes. Limited to user-scoped tokens that the
 * `/user` validation endpoint will accept: classic PATs (`ghp_`), fine-grained
 * PATs (`github_pat_`), and OAuth user tokens (`gho_`). App installation
 * (`ghs_`) and app user-to-server (`ghu_`/`ghr_`) tokens are NOT accepted
 * because they cannot validate via `/user` and would surface as a false
 * "Token invalid" state even though repository API calls would succeed.
 */
const GITHUB_TOKEN_PREFIXES = ['ghp_', 'github_pat_', 'gho_'] as const;
const GITHUB_TOKEN_MIN_LENGTH = 16;

/**
 * Reject tokens that obviously aren't GitHub PATs. Intentionally permissive
 * about length upper bound to accommodate fine-grained PATs; the floor catches
 * accidental whitespace/paste truncation. The GitHub API is the source of
 * truth for actual validity — see `getTokenStatus`.
 */
function validateGitHubTokenFormat(token: string): void {
  if (token.length < GITHUB_TOKEN_MIN_LENGTH) {
    throw new Error(`GitHub token is too short (minimum ${GITHUB_TOKEN_MIN_LENGTH} characters)`);
  }
  const matchesPrefix = GITHUB_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix));
  if (!matchesPrefix) {
    throw new Error(`GitHub token must start with one of: ${GITHUB_TOKEN_PREFIXES.join(', ')}`);
  }
}

/**
 * Extracts the commit SHA from a `status` webhook payload root. The SHA lives at
 * `payload.sha` (with `payload.commit.sha` as a fallback for older payloads).
 * Returns '' when absent so the caller can drop the event.
 */
function statusCommitSha(root: Record<string, unknown>): string {
  if (typeof root.sha === 'string' && root.sha) return root.sha;
  const commit = root.commit;
  if (commit && typeof commit === 'object') {
    const sha = (commit as Record<string, unknown>).sha;
    if (typeof sha === 'string' && sha) return sha;
  }
  return '';
}

/**
 * A durable, non-reversible credential fingerprint: stable for the same token
 * across daemon restarts, different when the token rotates. Used to scope
 * `lastPollAt` access evidence to the credential that produced it, without the
 * restart holes a process-local generation counter has.
 */
function credentialFingerprint(token: string | null | undefined): string {
  if (!token) return 'none';
  return `sha256:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}

function gitHubPollingHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'HyperNeo-Space-GitHub/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function canPollReactions(rateLimitRemaining: number | undefined): boolean {
  return rateLimitRemaining === undefined || rateLimitRemaining >= REACTION_POLL_RATE_LIMIT_FLOOR;
}

/**
 * Merge two rate-limit snapshots, preferring a finite remaining budget.
 *
 * GitHub 304 (ETag hit) responses do not carry rate-limit headers, so
 * `parseRateLimitHeaders` reports `remaining: Infinity`. Naively overwriting
 * a real low budget with such a snapshot would let downstream gates (e.g. the
 * reaction-poll `< 100` guard) treat a cached 304 as "unlimited" and
 * overspend. When the next snapshot is non-finite, keep the previous finite
 * value; otherwise take the new value.
 */
function mergeRateLimitInfo(
  prev: GitHubRateLimitInfo | undefined,
  next: GitHubRateLimitInfo
): GitHubRateLimitInfo {
  if (prev && Number.isFinite(prev.remaining) && !Number.isFinite(next.remaining)) {
    return prev;
  }
  return next;
}

function rowsFromPollingPayload(payload: unknown, endpointKey: string): unknown[] {
  if (endpointKey === 'check_runs') {
    const checkRuns = (payload as { check_runs?: unknown } | null)?.check_runs;
    return Array.isArray(checkRuns) ? checkRuns : [];
  }
  return Array.isArray(payload) ? payload : [];
}

function clearCheckRunEtagsForHead(checkRunEtags: Record<string, string>, headRef: string): void {
  const prefix = `${headRef}:`;
  for (const key of Object.keys(checkRunEtags)) {
    if (key.startsWith(prefix)) delete checkRunEtags[key];
  }
}

function pullRequestNumbersFromCheckRun(
  row: unknown,
  _pullRequestNumbersByHeadSha: Map<string, number[]>,
  fallbackPrNumbers: number[]
): number[] {
  if (!row || typeof row !== 'object') return [];
  const fallbackSet = new Set(fallbackPrNumbers);
  const numbers: number[] = [];
  const prs = (row as { pull_requests?: unknown }).pull_requests;
  if (Array.isArray(prs)) {
    for (const pr of prs) {
      const number = pullRequestNumberFrom(pr);
      if (number && fallbackSet.has(number) && !numbers.includes(number)) numbers.push(number);
    }
  }
  return numbers.length > 0 ? numbers : fallbackPrNumbers;
}

function getConfiguredWebhookUrl(): string {
  const baseUrl = process.env.HYPERNEO_PUBLIC_URL ?? process.env.PUBLIC_URL;
  if (!baseUrl) {
    throw new Error('HYPERNEO_PUBLIC_URL is required to configure GitHub webhooks');
  }

  let url: URL;
  try {
    url = new URL(WEBHOOK_PATH, baseUrl);
  } catch {
    throw new Error('HYPERNEO_PUBLIC_URL must be a valid URL');
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('HYPERNEO_PUBLIC_URL must use HTTPS unless it points to localhost');
  }
  return url.toString();
}

async function formatGitHubApiError(response: Response): Promise<string> {
  let message = `${response.status} ${response.statusText}`.trim();
  try {
    const body = (await response.json()) as { message?: string; documentation_url?: string };
    if (body.message) message = body.message;
  } catch {
    // Ignore non-JSON error bodies.
  }
  if (response.status === 401) {
    return `GitHub token is invalid or expired: ${message}`;
  }
  if (response.status === 403) {
    return `GitHub token lacks permission to manage repository webhooks: ${message}`;
  }
  if (response.status === 404) {
    return `GitHub repository or webhook was not found, or token lacks access: ${message}`;
  }
  return `GitHub API error: ${message}`;
}
