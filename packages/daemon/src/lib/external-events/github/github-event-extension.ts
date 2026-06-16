import type { Database as BunDatabase } from 'bun:sqlite';
import type { MessageHub } from '@neokai/shared';
import { Logger } from '../../logger';
import { verifySignature } from '../../github/webhook-handler';
import type {
  ExternalEventExtensionContext,
  HttpExternalEventExtension,
  RpcExternalEventExtension,
} from '../types';
import {
  normalizeGitHubPollingRow,
  normalizeGitHubWebhook,
  toExternalEvent,
} from './github-normalizer';
import {
  GitHubEventExtensionRepository,
  type GitHubWatchedRepo,
  type PollCursor,
} from './github-repository';

const log = new Logger('github-event-extension');
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const GITHUB_API_BASE = 'https://api.github.com';
/**
 * When the rate-limit `remaining` counter drops to or below this threshold,
 * polling is deferred until the reset epoch. Keeps a safety margin so the
 * extension cannot exhaust the budget on rapid poll cycles.
 */
const RATE_LIMIT_LOW_REMAINING_THRESHOLD = 10;
/** Minimum backoff applied when scheduling the next poll after rate-limit detection. */
const RATE_LIMIT_MIN_BACKOFF_MS = 60_000;

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
 */
export interface GitHubRateLimitInfo {
  remaining: number;
  resetAt: number;
  limited: boolean;
}

/**
 * Parses rate-limit headers from a GitHub API response.
 *
 * Headers are optional — GitHub does not always send them (e.g., 304 Not Modified
 * responses lack rate-limit headers). When absent, `remaining` is `Infinity`
 * and `resetAt` is `0`, so callers can treat the response as "unlimited" and
 * fall back to the configured poll interval.
 */
export function parseRateLimitHeaders(res: Response): GitHubRateLimitInfo {
  const remainingRaw = res.headers.get('X-RateLimit-Remaining');
  const resetRaw = res.headers.get('X-RateLimit-Reset');
  const remaining = remainingRaw ? parseInt(remainingRaw, 10) : Number.NaN;
  const resetSeconds = resetRaw ? parseInt(resetRaw, 10) : Number.NaN;
  return {
    remaining: Number.isNaN(remaining) ? Infinity : remaining,
    resetAt: Number.isNaN(resetSeconds) ? 0 : resetSeconds * 1000,
    limited: res.status === 403 || res.status === 429,
  };
}
const WEBHOOK_EVENTS = [
  'push',
  'pull_request',
  'issue_comment',
  'pull_request_review',
  'pull_request_review_comment',
];
const REQUIRED_WEBHOOK_EVENTS = WEBHOOK_EVENTS.filter((event) => event !== 'push');
const WEBHOOK_PATH = '/webhook/github/space';

interface GitHubEventExtensionOptions {
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
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
  private stopped = true;
  /**
   * Wall-clock epoch (ms) until which polling is deferred because GitHub
   * returned a rate-limit response or the `remaining` budget dropped below
   * the safety threshold. `0` means no deferral is active. Set by
   * `applyRateLimit()`, consulted by `pollEnabledSpaces()` and
   * `runPollCycle()` so the next poll is scheduled after the reset window.
   */
  private rateLimitedUntil = 0;

  constructor(
    db: BunDatabase,
    private readonly githubToken = process.env.GITHUB_TOKEN,
    private readonly options: GitHubEventExtensionOptions = {}
  ) {
    this.repo = new GitHubEventExtensionRepository(db);
  }

  async start(context: ExternalEventExtensionContext): Promise<void> {
    this.context = context;
    this.stopped = false;
    if (!(await this.isPollingGloballyEnabled())) return;
    this.scheduleNextPoll();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    await this.activePollCycle;
  }

  registerRpcHandlers(hub: MessageHub, context: ExternalEventExtensionContext): void {
    hub.onRequest('space.github.enable', async (data) => {
      await assertRpcConfigEnabled(context, this.sourceId);
      const params = data as { spaceId: string };
      if (!params.spaceId) throw new Error('spaceId is required');
      this.repo.setRepoEnabled(params.spaceId, true);
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
      const existing = this.repo.getWatchedRepo(params.spaceId, params.owner, params.repo);
      const replacingAutoSecret = Boolean(params.webhookSecret && existing?.webhookAutoRegistered);
      const disablingAutoWebhook = Boolean(
        existing?.webhookAutoRegistered &&
          existing.webhookEnabled &&
          params.webhookEnabled === false
      );
      if ((replacingAutoSecret || disablingAutoWebhook) && existing?.webhookRemoteId) {
        await this.deleteRemoteWebhookIfUnshared(existing);
      }
      let watchedRepo = this.repo.upsertWatchedRepo({
        spaceId: params.spaceId,
        owner: params.owner,
        repo: params.repo,
        webhookSecret: params.webhookSecret,
        webhookEnabled: params.webhookEnabled,
        pollingEnabled: params.pollingEnabled,
        enabled: params.enabled,
      });
      if (replacingAutoSecret || disablingAutoWebhook) {
        this.repo.clearWebhookRegistration(watchedRepo.id, { clearSecret: disablingAutoWebhook });
        watchedRepo = this.repo.getWatchedRepoById(watchedRepo.id) ?? watchedRepo;
      }
      await this.persistSpaceConfig(context, watchedRepo.spaceId);
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
      const existing = this.repo.getWatchedRepo(params.spaceId, params.owner, params.repo);
      if (existing?.webhookRemoteId && existing.webhookAutoRegistered) {
        await this.deleteRemoteWebhookIfUnshared(existing);
      }
      const removed = this.repo.removeWatchedRepo(params.spaceId, params.owner, params.repo);
      await this.persistSpaceConfig(context, params.spaceId);
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
      const params = (data ?? {}) as { spaceId?: string };
      return {
        count: params.spaceId
          ? await this.pollSpace(params.spaceId)
          : await this.pollEnabledSpaces(),
      };
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

  async pollOnce(fetchImpl: typeof fetch = fetch): Promise<number> {
    return await this.pollEnabledSpaces(fetchImpl);
  }

  private async pollEnabledSpaces(fetchImpl: typeof fetch = fetch): Promise<number> {
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

  private async pollSpace(spaceId: string, fetchImpl: typeof fetch = fetch): Promise<number> {
    if (!this.context) return 0;
    if (!(await this.isPollingGloballyEnabled())) return 0;
    const spaceConfig = await this.context.config.getSpaceConfig(spaceId, this.sourceId);
    if (spaceConfig && !spaceConfig.enabled) return 0;
    let count = 0;
    for (const repo of this.repo.listPollingRepos(spaceId))
      count += await this.pollWatchedRepo(repo, fetchImpl);
    return count;
  }

  private async isPollingGloballyEnabled(): Promise<boolean> {
    if (!this.context) return false;
    const global = await this.context.config.getGlobalConfig(this.sourceId);
    return global.globallyEnabled && global.capabilities.polling !== false;
  }

  private scheduleNextPoll(): void {
    this.scheduleNextPollAfter(this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
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
        this.activePollCycle = this.runPollCycle().finally(() => {
          this.activePollCycle = undefined;
        });
      },
      Math.max(1_000, delayMs)
    );
    this.pollTimer.unref?.();
  }

  private async runPollCycle(): Promise<void> {
    try {
      await this.pollEnabledSpaces();
    } catch (error) {
      log.warn('GitHub polling cycle failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (!this.stopped) {
        const now = Date.now();
        const delay =
          now < this.rateLimitedUntil
            ? Math.max(RATE_LIMIT_MIN_BACKOFF_MS, this.rateLimitedUntil - now)
            : (this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
        this.scheduleNextPollAfter(delay);
      }
    }
  }

  /**
   * Marks the extension as rate-limited until `rateLimit.resetAt` (or the
   * minimum backoff when the reset header was absent / already past).
   *
   * Idempotent: the latest reset window wins. Callers in `pollWatchedRepo`
   * invoke this once per endpoint that returns 403/429 or a low `remaining`
   * counter, then abort the rest of the cycle.
   */
  private applyRateLimit(rateLimit: GitHubRateLimitInfo): void {
    const resetDelay =
      rateLimit.resetAt > Date.now() ? rateLimit.resetAt - Date.now() : RATE_LIMIT_MIN_BACKOFF_MS;
    const delay = Math.max(RATE_LIMIT_MIN_BACKOFF_MS, resetDelay);
    this.rateLimitedUntil = Date.now() + delay;
    log.warn('GitHub rate limit detected — deferring next poll', {
      remaining: rateLimit.remaining === Infinity ? 'unknown' : rateLimit.remaining,
      resetAt: rateLimit.resetAt ? new Date(rateLimit.resetAt).toISOString() : 'unknown',
      nextPollInMs: delay,
    });
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
    if (!this.githubToken) {
      throw new Error('GITHUB_TOKEN is required to configure GitHub webhooks');
    }
    const webhookUrl = getConfiguredWebhookUrl();
    const existing = this.repo.getWatchedRepo(params.spaceId, params.owner, params.repo);
    const reusable = this.repo.getAutoRegisteredRepo(params.owner, params.repo, webhookUrl);
    const source = existing?.webhookAutoRegistered ? existing : reusable;
    const secret = existing?.webhookAutoRegistered
      ? generateWebhookSecret()
      : (reusable?.webhookSecret ?? generateWebhookSecret());
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
      pollingEnabled: false,
      webhookRemoteId: hook.id,
      webhookUrl: storedUrl,
      webhookAutoRegistered: true,
      webhookActive: hook.active,
      webhookLastCheckedAt: checkedAt,
      webhookLastError: null,
      webhookConfiguredAt: configuredAt,
    });
  }

  private async checkWebhook(
    spaceId: string,
    owner: string,
    repo: string
  ): Promise<GitHubWatchedRepo> {
    if (!this.githubToken) {
      throw new Error('GITHUB_TOKEN is required to check GitHub webhooks');
    }
    const watched = this.repo.getWatchedRepo(spaceId, owner, repo);
    if (!watched) throw new Error(`Repository ${owner}/${repo} is not watched`);
    if (!watched.webhookRemoteId)
      throw new Error(`Repository ${owner}/${repo} has no auto-configured webhook`);
    try {
      const hook = await this.getRemoteWebhook(watched);
      const error = validateRemoteHook(watched, hook);
      this.updateWebhookStatus(watched, {
        active: !error,
        lastCheckedAt: Date.now(),
        lastError: error,
      });
    } catch (error) {
      this.updateWebhookStatus(watched, {
        active: error instanceof GitHubApiError && error.status === 404 ? false : undefined,
        lastCheckedAt: Date.now(),
        lastError: error instanceof Error ? error.message : String(error),
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
        return await this.createRemoteWebhook(params.owner, params.repo, webhookUrl, secret);
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
        events: WEBHOOK_EVENTS,
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
        events: WEBHOOK_EVENTS,
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
    if (!this.githubToken) {
      throw new Error('GITHUB_TOKEN is required to delete GitHub webhooks');
    }
    const repoPath = gitHubRepoPath(watched.owner, watched.repo);
    try {
      await this.githubFetch(`/repos/${repoPath}/hooks/${watched.webhookRemoteId}`, {
        method: 'DELETE',
      });
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return;
      throw error;
    }
  }

  private async githubFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await (this.options.fetchImpl ?? fetch)(`${GITHUB_API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${this.githubToken}`,
        'User-Agent': 'NeoKai-Space-GitHub/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new GitHubApiError(response.status, await formatGitHubApiError(response));
    }
    return response;
  }

  async pollWatchedRepo(
    watched: GitHubWatchedRepo,
    fetchImpl: typeof fetch = fetch
  ): Promise<number> {
    if (!this.context) return 0;
    let count = 0;
    const cursor = watched.pollCursor ?? {};
    const etags = cursor.etags ?? {};
    const processedPages = cursor.processedPages ?? {};
    const watermarks = {
      committed: cursor.lastSeenAt ?? watched.lastPollAt ?? 0,
      pending: cursor.pendingLastSeenAt ?? cursor.lastSeenAt ?? watched.lastPollAt ?? 0,
    };
    const since = watermarks.committed ? new Date(watermarks.committed).toISOString() : undefined;
    const base = `https://api.github.com/repos/${gitHubRepoPath(watched.owner, watched.repo)}`;
    const endpoints = [
      { key: 'issue_comments', path: '/issues/comments' },
      { key: 'review_comments', path: '/pulls/comments' },
      { key: 'pulls', path: '/pulls', extra: 'state=all&sort=updated&direction=desc' },
    ];

    for (const endpoint of endpoints) {
      const page = processedPages[endpoint.key] ?? 1;
      const query = new URLSearchParams();
      if (endpoint.extra) {
        for (const part of endpoint.extra.split('&')) {
          const [key, value = ''] = part.split('=');
          query.set(key, value);
        }
      }
      if (since) query.set('since', since);
      query.set('per_page', '100');
      query.set('page', String(page));
      const url = `${base}${endpoint.path}?${query.toString()}`;
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'NeoKai-Space-GitHub/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (this.githubToken) headers.Authorization = `Bearer ${this.githubToken}`;
      if (page === 1 && etags[endpoint.key]) headers['If-None-Match'] = etags[endpoint.key];
      const response = await fetchImpl(url, { headers });
      // Rate-limit check: a 403/429 response OR a low `remaining` counter
      // defers this cycle and reschedules the next poll past the reset epoch.
      // Done before the 304 / !ok guards so we still defer when GitHub returns
      // 403 with the rate-limit headers attached.
      const rateLimit = parseRateLimitHeaders(response);
      if (rateLimit.limited || rateLimit.remaining < RATE_LIMIT_LOW_REMAINING_THRESHOLD) {
        // Early return skips the end-of-loop cursor save, so events already
        // published from earlier endpoints in this cycle will be re-fetched
        // on the next poll. That is safe: ExternalEventStore dedupes by
        // (spaceId, source, dedupeKey) via ON CONFLICT DO NOTHING, so
        // re-publishing is a no-op.
        this.applyRateLimit(rateLimit);
        return count;
      }
      if (response.status === 304) continue;
      if (!response.ok) continue;
      const etag = response.headers.get('ETag');
      if (etag && page === 1) etags[endpoint.key] = etag;
      const rows = (await response.json()) as unknown[];
      for (const row of rows) {
        const event = normalizeGitHubPollingRow(watched, row, endpoint.key);
        if (event) {
          await this.publishEvent(watched.spaceId, event, this.context);
          watermarks.pending = Math.max(watermarks.pending, event.occurredAt);
          count++;
        }
      }
      processedPages[endpoint.key] = rows.length >= 100 ? page + 1 : 1;
    }
    const hasBacklog = Object.values(processedPages).some((page) => page > 1);
    const cursorPayload: PollCursor = {
      lastSeenAt: hasBacklog ? watermarks.committed : watermarks.pending,
      pendingLastSeenAt: hasBacklog ? watermarks.pending : undefined,
      etags,
      processedPages,
    };
    this.repo.updatePollCursor(watched.id, cursorPayload);
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

function validateRemoteHook(watched: GitHubWatchedRepo, hook: GitHubHookResponse): string | null {
  if (!hook.active) return 'GitHub webhook is disabled';
  if (watched.webhookUrl && hook.config?.url !== watched.webhookUrl) {
    return 'GitHub webhook URL does not match this NeoKai endpoint';
  }
  if (hook.config?.content_type !== 'json') {
    return 'GitHub webhook content type must be JSON';
  }
  const events = new Set(hook.events ?? []);
  if (events.has('*')) return null;
  const missingEvents = REQUIRED_WEBHOOK_EVENTS.filter((event) => !events.has(event));
  if (missingEvents.length > 0) {
    return `GitHub webhook is missing events: ${missingEvents.join(', ')}`;
  }
  return null;
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

function gitHubRepoPath(owner: string, repo: string): string {
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function getConfiguredWebhookUrl(): string {
  const baseUrl = process.env.NEOKAI_PUBLIC_URL ?? process.env.PUBLIC_URL;
  if (!baseUrl) {
    throw new Error('NEOKAI_PUBLIC_URL is required to configure GitHub webhooks');
  }

  let url: URL;
  try {
    url = new URL(WEBHOOK_PATH, baseUrl);
  } catch {
    throw new Error('NEOKAI_PUBLIC_URL must be a valid URL');
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('NEOKAI_PUBLIC_URL must use HTTPS unless it points to localhost');
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
