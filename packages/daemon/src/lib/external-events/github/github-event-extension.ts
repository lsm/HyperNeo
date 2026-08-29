import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import { createHash } from 'node:crypto';
import type { MessageHub } from '@hyperneo/shared';
import { Logger } from '../../logger.ts';
import { isRateLimitError } from '../../space/runtime/rate-limit-detector.ts';
import { type CredentialStore } from '../../credentials/credential-store.js';
import { verifySignature } from '../../github/webhook-handler.ts';
import type {
  ExternalEventExtensionContext,
  HttpExternalEventExtension,
  RpcExternalEventExtension,
} from '../types.ts';
import { ExternalEventStore } from '../external-event-store.ts';
import type { ReactiveDatabase } from '../../../storage/reactive-database.ts';
import {
  checkRunAppKeyFrom,
  checkRunConclusionFrom,
  checkRunIdFrom,
  checkRunNameFrom,
  checkRunOccurredAt,
  checkRunTopicAction,
} from './github-check-run-fields.ts';
import {
  gitHubRepoPath,
  headRefKey,
  headRepoFromPullRequest,
  headShaFromPullRequest,
  parseHeadRefKey,
  pickPrNumbersByHeadSha,
  pullRequestNumberFrom,
} from './github-pr-head-ref.ts';
import {
  addPullRequestNumberByHeadRef,
  removePullRequestNumberByHeadRef,
} from './github-pr-head-ref-index.ts';
import { isPullRequestOpen, pullRequestUpdatedAt } from './github-pr-row-state.ts';
import { isPositiveReaction, reactionIdFrom } from './github-reaction-fields.ts';
import {
  normalizeGitHubCheckRun,
  normalizeGitHubDeployment,
  normalizeGitHubDeploymentStatus,
  normalizeGitHubMergeConflict,
  normalizeGitHubPollingRow,
  normalizeGitHubReaction,
  normalizeGitHubReview,
  normalizeGitHubStatus,
  normalizeGitHubWebhook,
  repoFromPayload,
  toExternalEvent,
  type GitHubPollingRepo,
} from './github-normalizer.ts';
import {
  GitHubEventExtensionRepository,
  type GitHubWatchedRepo,
  type PollCursor,
} from './github-repository.ts';

const log = new Logger('github-event-extension');
const DEFAULT_POLL_INTERVAL_MS = 120_000;
const GITHUB_API_BASE = 'https://api.github.com';
const REACTION_POLL_PR_LIMIT = 10;
const REACTION_POLL_RATE_LIMIT_FLOOR = 100;
const RATE_LIMIT_LOW_REMAINING_THRESHOLD = 10;
const RATE_LIMIT_MIN_BACKOFF_MS = 60_000;
const HEALTH_RECENT_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000;
const TOKEN_VALIDATION_TIMEOUT_MS = 5_000;
const TOKEN_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
const GITHUB_POLL_REQUEST_TIMEOUT_MS = 30_000;
const GITHUB_WEBHOOK_REQUEST_TIMEOUT_MS = 30_000;
const DEPLOYMENT_PR_RESOLUTION_TIMEOUT_MS = 5_000;
const REACTION_STALE_INTERVALS = 3;
const REACTION_STALE_MIN_MS = 5 * 60 * 1000;
const COMMENT_ENDPOINT_INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface GitHubRateLimitInfo {
  remaining: number;
  resetAt: number;
  limited: boolean;
  retryAfter: boolean;
}

export function parseRateLimitHeaders(res: Response): GitHubRateLimitInfo {
  const remainingRaw = res.headers.get('X-RateLimit-Remaining');
  const resetRaw = res.headers.get('X-RateLimit-Reset');
  const retryAfterRaw = res.headers.get('Retry-After');
  const remaining = remainingRaw ? parseInt(remainingRaw, 10) : Number.NaN;
  const resetSeconds = resetRaw ? parseInt(resetRaw, 10) : Number.NaN;
  const retryAfterSeconds = retryAfterRaw ? parseInt(retryAfterRaw, 10) : Number.NaN;
  const remainingValue = Number.isNaN(remaining) ? Infinity : remaining;
  const hasRetryAfter = !Number.isNaN(retryAfterSeconds);
  const limited =
    res.status === 429 || (res.status === 403 && (remainingValue === 0 || hasRetryAfter));
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
  'merge_group',
];
const REQUIRED_WEBHOOK_EVENTS = WEBHOOK_EVENTS.filter(
  (event) => event !== 'push' && event !== 'merge_group'
);
const REPO_HOOK_WEBHOOK_EVENTS = WEBHOOK_EVENTS.filter((event) => event !== 'merge_group');
const WEBHOOK_PATH = '/webhook/github/space';

interface GitHubEventExtensionOptions {
  pollIntervalMs?: number;
  getPollIntervalMs?: () => number | undefined;
  fetchImpl?: typeof fetch;
  credentialStore?: CredentialStore;
  reactiveDb?: ReactiveDatabase;
  autoReconcileWebhooks?: boolean;
}

interface GitHubTokenStatus {
  configured: boolean;
  source: 'keychain' | 'env' | 'none';
  login?: string;
  error?: string;
  authRejected?: boolean;
  autoRegisteredHookCount?: number;
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

export type GitHubHealthEventTypeKey =
  | 'status'
  | 'review_thread'
  | 'deployment'
  | 'check_suite'
  | 'merge_group'
  | 'branch_protection';

const GITHUB_HEALTH_EVENT_TYPES: ReadonlyArray<{ key: GitHubHealthEventTypeKey; label: string }> = [
  { key: 'status', label: 'Commit status' },
  { key: 'review_thread', label: 'Review threads' },
  { key: 'deployment', label: 'Deployments' },
  { key: 'check_suite', label: 'Check suites' },
  { key: 'merge_group', label: 'Merge queue' },
  { key: 'branch_protection', label: 'Branch protection' },
];

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
  suite_cancelled: 'check_suite',
  merge_group_checks_requested: 'merge_group',
  merge_group_destroyed: 'merge_group',
  enqueued: 'merge_group',
  dequeued: 'merge_group',
  branch_protection_created: 'branch_protection',
  branch_protection_edited: 'branch_protection',
  branch_protection_deleted: 'branch_protection',
};

export interface GitHubHealthRepoSummary {
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
}

export interface GitHubHealthSnapshot {
  source: 'github';
  spaceId: string;
  timestamp: number;
  token: GitHubTokenStatus;
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
  private reconcileSweepPromise?: Promise<void>;
  private pollQueue: Promise<unknown> = Promise.resolve();
  private stopped = true;
  private webhookConfigQueues = new Map<string, Promise<void>>();
  private rateLimitedUntil = 0;
  private rateLimitedFromRetryAfter = false;
  private lastRateLimitInfo?: GitHubRateLimitInfo;
  private lastRateLimitObservedAt = 0;
  private lastRateLimitFingerprint?: string;
  private lastTokenStatus: GitHubTokenStatus | null = null;
  private lastTokenStatusGeneration = -1;
  private lastTokenStatusAt = 0;
  private credentialGeneration = 0;
  private pollCycleCredentialGeneration: number | null = null;
  private pollCycleCredentialFingerprint: string | null = null;
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
        this.repo.setPollingIntent(params.spaceId, true);
        await this.persistSpaceConfig(context, watchedRepo.spaceId);
        if (this.getPollIntervalMs() > 0) {
          await this.enablePollingCapability(context);
          this.ensurePollingActive();
        }
      } else {
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
      if (this.getPollIntervalMs() <= 0) {
        throw new Error('GitHub polling is disabled (interval is 0)');
      }
      const params = (data ?? {}) as { spaceId?: string };
      const count = await this.runExclusivePoll(() =>
        params.spaceId ? this.pollSpace(params.spaceId) : this.pollEnabledSpaces()
      );
      if (Date.now() < this.rateLimitedUntil) {
        return { count, skipped: 'rate-limited' as const, retryAt: this.rateLimitedUntil };
      }
      const polledRepos = this.repo.listPollingRepos(params.spaceId);
      const errorCount = polledRepos.filter(
        (r) => r.pollCursor?.lastPollError || r.pollCursor?.lastPartialPollError
      ).length;
      return errorCount > 0 ? { count, errors: errorCount } : { count };
    });

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

    hub.onRequest('space.github.health', async (data) => {
      await assertRpcConfigEnabled(context, this.sourceId);
      const params = data as { spaceId?: string; lightweight?: boolean };
      if (!params.spaceId) throw new Error('spaceId is required');
      return await this.buildHealthSnapshot(params.spaceId, {
        lightweight: params.lightweight === true,
      });
    });

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
        this.repo.setPollingIntent(params.spaceId, true);
        await this.enablePollingCapability(context);
        this.ensurePollingActive();
      } else {
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

    if (eventType === 'status') {
      return await this.handleStatusWebhook(deliveryId, payload, signatureMatchedRepos);
    }

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

    if (eventType === 'deployment_status' && statusRoot?.state === 'inactive') {
      for (const watched of targets) {
        this.repo.markWebhookReceived(watched.id);
      }
      return Response.json(
        { message: 'Event ignored', deliveryId, reason: 'inactive' },
        { status: 202 }
      );
    }

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
      return { kind: 'error' };
    }
  }

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
    if (Date.now() < this.rateLimitedUntil) {
      log.warn('GitHub polling cycle skipped — rate limited until', {
        resetAt: new Date(this.rateLimitedUntil).toISOString(),
      });
      return 0;
    }
    let count = 0;
    for (const repo of this.repo.listPollingRepos()) {
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
      if (Date.now() < this.rateLimitedUntil) break;
    }
    return count;
  }

  private async isPollingGloballyEnabled(): Promise<boolean> {
    if (!this.context) return false;
    const global = await this.context.config.getGlobalConfig(this.sourceId);
    return global.globallyEnabled && global.capabilities.polling !== false;
  }

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

  private scheduleNextPollAfter(delayMs: number): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(
      () => {
        if (this.activePollCycle) {
          this.scheduleNextPoll();
          return;
        }
        this.runExclusivePoll(() => this.runPollCycle()).catch(() => {});
      },
      Math.max(1_000, delayMs)
    );
    this.pollTimer.unref?.();
  }

  private runExclusivePoll<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.pollQueue.then(fn, fn);
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

  private runExclusiveWebhookConfig<T>(
    owner: string,
    repo: string,
    fn: () => Promise<T>
  ): Promise<T> {
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

  private lastResolvedToken: string | undefined;

  private async resolveToken(): Promise<string | undefined> {
    return (await this.resolveTokenOrFail()).token;
  }

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
    this.lastResolvedToken = token;
    return { token, readFailed };
  }

  private async getTokenStatus(): Promise<GitHubTokenStatus> {
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
    if (this.credentialGeneration !== validationGeneration) {
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
      const response = await fetchImpl(`${GITHUB_API_BASE}/user`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'HyperNeo-Space-GitHub/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(TOKEN_VALIDATION_TIMEOUT_MS),
      });
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
        if (this.credentialGeneration !== validationGeneration) {
          return {
            configured: true,
            source,
            error: 'credential changed during validation',
            autoRegisteredHookCount,
          };
        }
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
      const validationRateLimit = parseRateLimitHeaders(response);
      let rateLimited = validationRateLimit.limited;
      let secondaryLimitApplied = false;
      if (!rateLimited && (response.status === 403 || response.status === 429)) {
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
        if (secondaryLimitApplied) {
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
        autoRegisteredHookCount: this.repo.countAllAutoRegisteredHookRefs(),
        validatedFingerprint: credentialFingerprint(token),
      };
    }
  }

  private async resolveTokenStatus(lightweight: boolean): Promise<GitHubTokenStatus> {
    if (
      lightweight &&
      this.lastTokenStatus !== null &&
      this.lastTokenStatusGeneration === this.credentialGeneration &&
      Date.now() - this.lastTokenStatusAt < TOKEN_STATUS_CACHE_TTL_MS &&
      credentialFingerprint(this.lastResolvedToken) === this.lastTokenStatus.validatedFingerprint
    ) {
      return this.lastTokenStatus;
    }
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

  private async buildHealthSnapshot(
    spaceId: string,
    options: { lightweight?: boolean } = {}
  ): Promise<GitHubHealthSnapshot> {
    let generationBefore = this.credentialGeneration;
    let currentCredentialFingerprint = credentialFingerprint(await this.resolveToken());
    const token = await this.resolveTokenStatus(options.lightweight === true);
    const globallyEnabled = await this.isPollingGloballyEnabled();
    const webhookDeliveryEnabled = await this.isWebhookDeliveryEnabled();
    const intervalMs = this.getPollIntervalMs();
    for (
      let attempt = 0;
      attempt < 3 && this.credentialGeneration !== generationBefore;
      attempt++
    ) {
      generationBefore = this.credentialGeneration;
      currentCredentialFingerprint = credentialFingerprint(await this.resolveToken());
    }
    const { token: effectiveToken, readFailed: effectiveReadFailed } =
      await this.resolveTokenOrFail();
    const effectiveFingerprint = credentialFingerprint(effectiveToken);
    const credentialRotatedDuringSnapshot =
      !effectiveReadFailed &&
      token.validatedFingerprint !== undefined &&
      effectiveFingerprint !== token.validatedFingerprint;
    if (
      !effectiveReadFailed &&
      this.rateLimitedUntil > 0 &&
      this.lastRateLimitFingerprint &&
      this.lastRateLimitFingerprint !== effectiveFingerprint
    ) {
      this.rateLimitedUntil = 0;
      this.rateLimitedFromRetryAfter = false;
      if (this.pollTimer && !this.activePollCycle && !this.stopped) {
        this.scheduleNextPoll();
      }
    }
    if (this.credentialGeneration !== generationBefore || credentialRotatedDuringSnapshot) {
      currentCredentialFingerprint = '__unstable_credential__';
    } else if (token.validatedFingerprint) {
      currentCredentialFingerprint = token.validatedFingerprint;
    }
    const now = Date.now();
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
    const pollingStaleWindow =
      intervalMs > 0
        ? Math.max(intervalMs * REACTION_STALE_INTERVALS, REACTION_STALE_MIN_MS)
        : REACTION_STALE_MIN_MS;

    for (const repo of watched) {
      if (!repo.enabled) continue;
      if (repo.webhookEnabled) {
        webhookConfigured++;
        if (repo.webhookActive === true) webhookActive++;
        else if (repo.webhookActive === false) webhookInactive++;
        else webhookUnknown++;
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
      const pollFingerprint = repo.pollCursor?.lastPollCredentialFingerprint;
      const accessVerified = pollFingerprint === currentCredentialFingerprint;
      const provenLastPollAt = accessVerified ? repo.lastPollAt : null;
      if (isPollingRepo && !provenLastPollAt && !repo.pollCursor?.lastPollError) {
        neverPolledRepos++;
      }
      if (
        isPollingRepo &&
        provenLastPollAt &&
        !repo.pollCursor?.lastPollError &&
        now - provenLastPollAt > pollingStaleWindow
      ) {
        stalePollingRepos++;
      }
      if (
        isPollingRepo &&
        !repoInaccessible &&
        provenLastPollAt &&
        (lastPollAt === null || provenLastPollAt > lastPollAt)
      ) {
        lastPollAt = provenLastPollAt;
      }
      const reactionAt = isPollingRepo ? (repo.pollCursor?.lastReactionPollAt ?? null) : null;
      if (
        trackedPrs > 0 &&
        reactionAt !== null &&
        (lastReactionActivityAt === null || reactionAt > lastReactionActivityAt)
      ) {
        lastReactionActivityAt = reactionAt;
      }
      if (
        isPollingRepo &&
        trackedPrs > 0 &&
        (reactionAt === null || now - reactionAt > reactionStaleWindow)
      ) {
        staleReactionRepos++;
      }
    }

    if (
      this.lastRateLimitInfo &&
      this.lastRateLimitInfo.resetAt &&
      this.lastRateLimitInfo.resetAt <= now
    ) {
      this.lastRateLimitInfo = undefined;
      this.lastRateLimitObservedAt = 0;
    }
    const rateLimitInfo = this.lastRateLimitInfo;
    const recentCutoff = now - HEALTH_RECENT_ERROR_WINDOW_MS;
    const recentDeliveries = this.eventStore
      .listDeliveryLog({
        spaceId,
        status: 'failed',
        source: 'github',
        limit: 5,
      })
      .filter((delivery) => delivery.updatedAt >= recentCutoff);
    const recentErrorTotal = this.eventStore.countDeliveryLog({
      spaceId,
      status: 'failed',
      source: 'github',
      updatedSince: recentCutoff,
    });

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

  private async enablePollingCapability(context: ExternalEventExtensionContext): Promise<void> {
    const global = await context.config.getGlobalConfig(this.sourceId);
    if (global.capabilities.polling === true) return;
    await context.config.setGlobalConfig(this.sourceId, {
      ...global,
      capabilities: { ...global.capabilities, polling: true },
    });
  }

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

  private resetRateLimitObservation(): void {
    this.lastRateLimitInfo = undefined;
    this.lastRateLimitObservedAt = 0;
    this.rateLimitedUntil = 0;
    this.rateLimitedFromRetryAfter = false;
    this.credentialGeneration++;
    this.repo.clearPollErrorsForAllRepos();
    if (this.pollTimer && !this.activePollCycle && !this.stopped) {
      this.scheduleNextPoll();
    }
  }

  private applyRateLimit(
    rateLimit: GitHubRateLimitInfo,
    bypassGenerationGuard = false,
    credentialFp?: string
  ): void {
    if (
      !bypassGenerationGuard &&
      this.pollCycleCredentialGeneration !== null &&
      this.pollCycleCredentialGeneration !== this.credentialGeneration
    ) {
      return;
    }
    const resetDelay =
      rateLimit.resetAt > Date.now() ? rateLimit.resetAt - Date.now() : RATE_LIMIT_MIN_BACKOFF_MS;
    const delay = rateLimit.retryAfter
      ? resetDelay
      : Math.max(RATE_LIMIT_MIN_BACKOFF_MS, resetDelay);
    const newRateLimitedUntil = Date.now() + delay;
    const newFingerprint =
      credentialFp ??
      this.pollCycleCredentialFingerprint ??
      credentialFingerprint(this.lastResolvedToken);
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

  private recordRateLimitObservation(rateLimit: GitHubRateLimitInfo): void {
    if (!Number.isFinite(rateLimit.remaining)) return;
    this.lastRateLimitInfo = mergeRateLimitInfo(this.lastRateLimitInfo, rateLimit);
    this.lastRateLimitObservedAt = Date.now();
  }

  private async publishEvent(
    spaceId: string,
    event: import('./github-normalizer.ts').NormalizedGitHubEvent,
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
            webhookRemoteId: hook.id,
            webhookUrl: storedUrl,
            webhookAutoRegistered: true,
            webhookActive: hook.active,
            webhookLastCheckedAt: checkedAt,
            webhookLastError: null,
            webhookConfiguredAt: configuredAt,
          });
        } catch (error) {
          const hookConfirmedGone = (error as Error & { hookConfirmedDeleted?: boolean })
            .hookConfirmedDeleted;
          if (hookConfirmedGone && source && source.webhookRemoteId) {
            this.updateWebhookStatus(source, {
              active: false,
              lastCheckedAt: Date.now(),
              lastError: error instanceof Error ? error.message : String(error),
            });
          } else if (!(error instanceof GitHubApiError) && source && source.webhookRemoteId) {
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
      let effective = watched;
      let selfHealPatched = false;
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
          error = validateRemoteHook(effective, hook);
        } catch (healError) {
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
      const currentError = this.repo.getWatchedRepoById(effective.id)?.webhookLastError ?? null;
      const priorErrorIsUpdateUncertain = currentError?.includes('update uncertain') ?? false;
      this.updateWebhookStatus(effective, {
        active: !error,
        lastCheckedAt: Date.now(),
        lastError: priorErrorIsUpdateUncertain && !selfHealPatched ? currentError : error,
      });
    } catch (error) {
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
    if (!isOnlyMissingEvents(watched, hook)) return { hook, patched: false };
    const webhookUrl = watched.webhookUrl ?? getConfiguredWebhookUrl();
    try {
      hook = await this.updateRemoteWebhook(watched, webhookUrl, watched.webhookSecret);
    } catch (error) {
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

  async reconcileManagedWebhooks(): Promise<void> {
    if (!(await this.resolveToken())) return;
    if (!(await this.isWebhookDeliveryEnabled())) return;
    if (Date.now() < this.rateLimitedUntil) return;
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

  private async reconcileSharedHook(spaceId: string, owner: string, repo: string): Promise<void> {
    await this.runExclusiveWebhookConfig(owner, repo, async () => {
      const current = this.repo.getWatchedRepo(spaceId, owner, repo);
      if (!current) return;
      const result = await this.reconcileWebhookEvents(current);
      if (!result) return;
      const { hook, patched } = result;
      const error = validateRemoteHook(current, hook);
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
        try {
          return await this.createRemoteWebhook(params.owner, params.repo, webhookUrl, secret);
        } catch (createError) {
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
    const requestGeneration = this.credentialGeneration;
    const token = await this.resolveToken();
    if (!token) {
      throw new Error('GITHUB_TOKEN is required for GitHub API requests');
    }
    const response = await (this.options.fetchImpl ?? fetch)(`${GITHUB_API_BASE}${path}`, {
      ...init,
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
      const errorText = await formatGitHubApiError(response);
      const rateLimit = parseRateLimitHeaders(response);
      const secondaryLimit =
        (response.status === 403 || response.status === 429) && isRateLimitError(errorText);
      if (
        requestGeneration === this.credentialGeneration &&
        (rateLimit.limited || secondaryLimit)
      ) {
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
    this.pollCycleCredentialGeneration = this.credentialGeneration;
    try {
      return await this.pollWatchedRepoCore(watched, fetchImpl);
    } catch (err) {
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
    const mergeConflictStates = cursor.mergeConflictStates ?? {};
    const mergeConflictSequences = cursor.mergeConflictSequences ?? {};
    const mergeConflictEtags = cursor.mergeConflictEtags ?? {};
    const seenReviewIds = cursor.seenReviewIds ?? {};
    const reviewEtags = cursor.reviewEtags ?? {};
    const reviewLastSeenAt = cursor.reviewLastSeenAt ?? {};
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
    let accessible = false;
    let pollErrorMessage: string | null = null;
    let reactionPolledAt: number | null = null;
    let reactionsFullyPolled = true;
    let pullsFetchedResumedPage = false;

    const token = await this.resolveToken();
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
        if (!pollErrorMessage) {
          pollErrorMessage = err instanceof Error ? err.message : 'network request failed';
        }
        partialScan = true;
        continue;
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
        break;
      }
      if (response.status === 304) {
        accessible = true;
        this.pollCycleAccessible = true;
        continue;
      }
      if (!response.ok) {
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
        if (!pollErrorMessage) {
          pollErrorMessage = errorText.trim().slice(0, 160) || `HTTP ${response.status}`;
        }
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
        const freshNumbers: number[] = [];
        const closedNumbers = new Set<number>();
        for (const row of rows) {
          const prNumber = pullRequestNumberFrom(row);
          if (!prNumber) continue;
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
      if (processedPages[endpoint.key] === 1) {
        if (
          endpoint.key === 'pulls' &&
          endpointPending > 0 &&
          endpointPending === endpointWatermark
        ) {
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
    const pullsHasBacklog = (processedPages.pulls ?? 1) > 1 || pullsFetchedResumedPage;

    if (!partialScan && !pullsHasBacklog) {
      const checkRunEndpointKey = 'check_runs';
      let checkRunPermissionDenied = false;
      let checkRunRateLimited = false;
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
        let headSucceeded = true;
        let headPruned = false;
        const repoPathsToQuery =
          headRepoPath !== watchedBaseRepoPath
            ? [headRepoPath, watchedBaseRepoPath]
            : [headRepoPath];
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
                if (checkRunRepoPath !== watchedBaseRepoPath) {
                  clearCheckRunEtagsForHead(checkRunEtags, headRef);
                  if (!pollErrorMessage) {
                    pollErrorMessage = 'fork check-runs inaccessible (HTTP 403)';
                  }
                  headSucceeded = false;
                  break;
                }
                checkRunPermissionDenied = true;
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
                  headPruned = true;
                }
                break;
              }
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
                reachedOldRows = true;
                break;
              }
              headPending = Math.max(headPending, rowOccurredAt);
              const checkRunId = checkRunIdFrom(row);
              if (seenCheckRunIds.has(checkRunId)) continue;
              seenCheckRunIds.add(checkRunId);
              const checkName = checkRunNameFrom(row);
              const appKey = checkRunAppKeyFrom(row);
              const supersessionKey = `${checkName}:${appKey}`;
              const conclusion = checkRunConclusionFrom(row);
              const topicAction = checkRunTopicAction(conclusion);
              if (supersededCheckKeys.has(supersessionKey)) continue;
              if (topicAction === null) {
                supersededCheckKeys.add(supersessionKey);
                continue;
              }
              if (topicAction !== 'failed') {
                supersededCheckKeys.add(supersessionKey);
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
        if (headSucceeded) {
          checkRunHeadPendingLastSeenAt[headRef] = headPending;
        }
        if (checkRunRateLimited || checkRunPermissionDenied) break;
      }
      if (checkRunRateLimited || checkRunPermissionDenied || hasBacklog) {
      } else {
        for (const [headRef, headPending] of Object.entries(checkRunHeadPendingLastSeenAt)) {
          checkRunHeadLastSeenAt[headRef] = headPending;
        }
        checkRunHeadPendingLastSeenAt = {};
        const maxHeadWatermark = Math.max(0, ...Object.values(checkRunHeadLastSeenAt));
        if (maxHeadWatermark > 0) endpointLastSeenAt[checkRunEndpointKey] = maxHeadWatermark;
        delete endpointPendingLastSeenAt[checkRunEndpointKey];
      }
    }

    for (const prNumber of recentPullRequestNumbers.slice(0, REACTION_POLL_PR_LIMIT)) {
      if (partialScan) break;
      if (!canPollReactions(latestRateLimit?.remaining)) {
        partialScan = true;
        break;
      }
      const mergeHeaders = gitHubPollingHeaders(token);
      if (mergeConflictEtags[prNumber])
        mergeHeaders['If-None-Match'] = mergeConflictEtags[prNumber];
      let mergeResponse: Response;
      try {
        mergeResponse = await fetchImpl(`${base}/pulls/${prNumber}`, {
          headers: mergeHeaders,
          signal: AbortSignal.timeout(GITHUB_POLL_REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (!pollErrorMessage) {
          pollErrorMessage = err instanceof Error ? err.message : 'network request failed';
        }
        partialScan = true;
        continue;
      }
      const mergeRateLimit = parseRateLimitHeaders(mergeResponse);
      latestRateLimit = mergeRateLimitInfo(latestRateLimit, mergeRateLimit);
      if (mergeResponse.status === 304) continue;
      if (mergeRateLimit.limited) {
        if (
          mergeResponse.status === 429 &&
          mergeRateLimit.remaining > 0 &&
          !mergeRateLimit.retryAfter
        ) {
          this.applyRateLimit({
            remaining: mergeRateLimit.remaining,
            resetAt: Date.now() + RATE_LIMIT_MIN_BACKOFF_MS,
            limited: true,
            retryAfter: true,
          });
        } else {
          this.applyRateLimit(mergeRateLimit);
        }
        partialScan = true;
        break;
      }
      if (!mergeResponse.ok) {
        const errorText = await mergeResponse.text();
        if (
          (mergeResponse.status === 403 || mergeResponse.status === 429) &&
          isRateLimitError(errorText)
        ) {
          const secondaryDelayMs = mergeRateLimit.retryAfter
            ? mergeRateLimit.resetAt - Date.now()
            : RATE_LIMIT_MIN_BACKOFF_MS;
          this.applyRateLimit({
            remaining: mergeRateLimit.remaining,
            resetAt: Date.now() + secondaryDelayMs,
            limited: true,
            retryAfter: true,
          });
          partialScan = true;
          break;
        }
        if (!pollErrorMessage) {
          pollErrorMessage =
            errorText.trim().slice(0, 160) || `pull request detail HTTP ${mergeResponse.status}`;
        }
        partialScan = true;
        continue;
      }
      const mergeEtag = mergeResponse.headers.get('ETag');
      if (mergeEtag) mergeConflictEtags[prNumber] = mergeEtag;
      const pullDetail = asPollingObject(await mergeResponse.json());
      if (pullDetail.state !== 'open') {
        delete mergeConflictStates[prNumber];
        continue;
      }
      const mergeable = typeof pullDetail.mergeable === 'boolean' ? pullDetail.mergeable : null;
      const mergeableState =
        typeof pullDetail.mergeable_state === 'string' ? pullDetail.mergeable_state : '';
      if (mergeable === null && mergeableState !== 'dirty') continue;
      const conflicting = mergeable === false || mergeableState === 'dirty';
      const previousConflict = mergeConflictStates[prNumber];
      mergeConflictStates[prNumber] = conflicting;
      if (conflicting === (previousConflict ?? false)) continue;
      const sequence = (mergeConflictSequences[prNumber] ?? 0) + 1;
      mergeConflictSequences[prNumber] = sequence;
      const mergeConflictEvent = normalizeGitHubMergeConflict({
        repo: watched,
        pullRequest: pullDetail,
        prNumber,
        conflicting,
        mergeable,
        mergeableState,
        sequence,
        deliveryId: `poll:merge_conflict:${prNumber}`,
      });
      if (mergeConflictEvent) {
        await this.publishEvent(watched.spaceId, mergeConflictEvent, this.context);
        count++;
      }
      if (
        Number.isFinite(mergeRateLimit.remaining) &&
        mergeRateLimit.remaining < RATE_LIMIT_LOW_REMAINING_THRESHOLD
      ) {
        this.applyRateLimit(mergeRateLimit);
        partialScan = true;
        break;
      }
    }

    for (const prNumber of recentPullRequestNumbers.slice(0, REACTION_POLL_PR_LIMIT)) {
      if (partialScan) break;
      if (!canPollReactions(latestRateLimit?.remaining)) {
        partialScan = true;
        break;
      }
      const reviewQuery = new URLSearchParams({ per_page: '100' });
      if (!(prNumber in reviewLastSeenAt)) {
        reviewLastSeenAt[prNumber] = watermarks.committed;
      }
      let reviewPage = 1;
      let reviewScanComplete = false;
      let reviewScanSinglePage = false;
      let reviewPendingEtag: string | null = null;
      while (true) {
        const reviewHeaders = gitHubPollingHeaders(token);
        if (reviewPage === 1 && reviewEtags[prNumber]) {
          reviewHeaders['If-None-Match'] = reviewEtags[prNumber];
        }
        if (reviewPage > 1) reviewQuery.set('page', String(reviewPage));
        let reviewResponse: Response;
        try {
          reviewResponse = await fetchImpl(
            `${base}/pulls/${prNumber}/reviews?${reviewQuery.toString()}`,
            {
              headers: reviewHeaders,
              signal: AbortSignal.timeout(GITHUB_POLL_REQUEST_TIMEOUT_MS),
            }
          );
        } catch (err) {
          if (!pollErrorMessage) {
            pollErrorMessage = err instanceof Error ? err.message : 'network request failed';
          }
          partialScan = true;
          break;
        }
        const reviewRateLimit = parseRateLimitHeaders(reviewResponse);
        latestRateLimit = mergeRateLimitInfo(latestRateLimit, reviewRateLimit);
        if (reviewResponse.status === 304) {
          reviewScanComplete = true;
          reviewScanSinglePage = true;
          reviewPendingEtag = reviewEtags[prNumber] ?? reviewResponse.headers.get('ETag');
          break;
        }
        if (reviewRateLimit.limited) {
          if (
            reviewResponse.status === 429 &&
            reviewRateLimit.remaining > 0 &&
            !reviewRateLimit.retryAfter
          ) {
            this.applyRateLimit({
              remaining: reviewRateLimit.remaining,
              resetAt: Date.now() + RATE_LIMIT_MIN_BACKOFF_MS,
              limited: true,
              retryAfter: true,
            });
          } else {
            this.applyRateLimit(reviewRateLimit);
          }
          partialScan = true;
          break;
        }
        if (!reviewResponse.ok) {
          const errorText = await reviewResponse.text();
          if (
            (reviewResponse.status === 403 || reviewResponse.status === 429) &&
            isRateLimitError(errorText)
          ) {
            const secondaryDelayMs = reviewRateLimit.retryAfter
              ? reviewRateLimit.resetAt - Date.now()
              : RATE_LIMIT_MIN_BACKOFF_MS;
            this.applyRateLimit({
              remaining: reviewRateLimit.remaining,
              resetAt: Date.now() + secondaryDelayMs,
              limited: true,
              retryAfter: true,
            });
            partialScan = true;
            break;
          }
          if (!pollErrorMessage) {
            pollErrorMessage =
              errorText.trim().slice(0, 160) || `reviews HTTP ${reviewResponse.status}`;
          }
          partialScan = true;
          break;
        }
        if (reviewPage === 1) {
          reviewPendingEtag = reviewResponse.headers.get('ETag');
        }
        const reviews = await reviewResponse.json();
        if (!Array.isArray(reviews) || reviews.length === 0) {
          reviewScanComplete = true;
          reviewScanSinglePage = reviewPage === 1;
          break;
        }
        for (const review of reviews) {
          const reviewId = reviewRowIdFrom(review);
          if (!reviewId || seenReviewIds[reviewId]) continue;
          const event = normalizeGitHubReview(watched, prNumber, review);
          if (!event) continue;
          const reviewWatermark = reviewLastSeenAt[prNumber] ?? watermarks.committed;
          if (reviewWatermark > 0 && event.occurredAt < reviewWatermark) {
            seenReviewIds[reviewId] = true;
            continue;
          }
          await this.publishEvent(watched.spaceId, event, this.context);
          seenReviewIds[reviewId] = true;
          reviewLastSeenAt[prNumber] = Math.max(reviewLastSeenAt[prNumber] ?? 0, event.occurredAt);
          count++;
        }
        if (reviews.length < 100) {
          reviewScanComplete = true;
          reviewScanSinglePage = reviewPage === 1;
          break;
        }
        if (!canPollReactions(reviewRateLimit.remaining)) {
          partialScan = true;
          break;
        }
        reviewPage++;
      }
      if (reviewScanComplete && reviewScanSinglePage && reviewPendingEtag) {
        reviewEtags[prNumber] = reviewPendingEtag;
      } else {
        delete reviewEtags[prNumber];
      }
      if (partialScan) break;
      if (
        latestRateLimit &&
        Number.isFinite(latestRateLimit.remaining) &&
        latestRateLimit.remaining < RATE_LIMIT_LOW_REMAINING_THRESHOLD
      ) {
        this.applyRateLimit(latestRateLimit);
        partialScan = true;
        break;
      }
    }

    for (const prNumber of recentPullRequestNumbers.slice(0, REACTION_POLL_PR_LIMIT)) {
      if (partialScan) break;
      if (!canPollReactions(latestRateLimit?.remaining)) {
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
        reactionPolledAt = Date.now();
        continue;
      }
      if (reactionRateLimit.limited) {
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
        if (watermarks.committed > 0 && event.occurredAt < watermarks.committed) {
          seenReactionIds[reactionId] = true;
          continue;
        }
        await this.publishEvent(watched.spaceId, event, this.context);
        seenReactionIds[reactionId] = true;
        count++;
      }
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

    const trackedPrSet = new Set(recentPullRequestNumbers);
    for (const key of Object.keys(reactionEtags)) {
      if (!trackedPrSet.has(Number(key))) delete reactionEtags[Number(key)];
    }
    for (const key of Object.keys(mergeConflictEtags)) {
      if (!trackedPrSet.has(Number(key))) delete mergeConflictEtags[Number(key)];
    }
    for (const key of Object.keys(reviewEtags)) {
      if (!trackedPrSet.has(Number(key))) delete reviewEtags[Number(key)];
    }
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
    const pullsCheckRunDeferred = pullsFetchedResumedPage;
    const credentialGenerationStale =
      this.pollCycleCredentialGeneration !== null &&
      this.pollCycleCredentialGeneration !== this.credentialGeneration;
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
          : partialScan || hasBacklog || pullsCheckRunDeferred
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
      mergeConflictStates,
      mergeConflictSequences,
      mergeConflictEtags,
      seenReviewIds,
      reviewEtags,
      reviewLastSeenAt,
      endpointLastSeenAt,
      endpointPendingLastSeenAt,
      lastPollError: committedLastPollError,
      lastPartialPollError: committedLastPartialPollError,
      lastReactionPollAt: reactionsFullyPolled
        ? (reactionPolledAt ?? cursor.lastReactionPollAt ?? null)
        : (cursor.lastReactionPollAt ?? null),
      lastPollCredentialFingerprint: accessible
        ? credentialFingerprint(token)
        : cursor.lastPollCredentialFingerprint,
    };
    if (accessible) {
      this.repo.updatePollCursor(watched.id, cursorPayload);
    } else {
      this.repo.updatePollCursorJson(watched.id, cursorPayload);
    }
    if (latestRateLimit) {
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

const GITHUB_TOKEN_PREFIXES = ['ghp_', 'github_pat_', 'gho_'] as const;
const GITHUB_TOKEN_MIN_LENGTH = 16;

function validateGitHubTokenFormat(token: string): void {
  if (token.length < GITHUB_TOKEN_MIN_LENGTH) {
    throw new Error(`GitHub token is too short (minimum ${GITHUB_TOKEN_MIN_LENGTH} characters)`);
  }
  const matchesPrefix = GITHUB_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix));
  if (!matchesPrefix) {
    throw new Error(`GitHub token must start with one of: ${GITHUB_TOKEN_PREFIXES.join(', ')}`);
  }
}

export function statusCommitSha(root: Record<string, unknown>): string {
  if (typeof root.sha === 'string' && root.sha) return root.sha;
  const commit = root.commit;
  if (commit && typeof commit === 'object') {
    const sha = (commit as Record<string, unknown>).sha;
    if (typeof sha === 'string' && sha) return sha;
  }
  return '';
}

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

function asPollingObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function reviewRowIdFrom(review: unknown): string {
  const id = asPollingObject(review).id;
  return typeof id === 'number' ? String(id) : '';
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
  } catch {}
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
