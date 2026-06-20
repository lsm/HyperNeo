import type { Database as BunDatabase } from 'bun:sqlite';
import type { MessageHub } from '@neokai/shared';
import { Logger } from '../../logger';
import { isRateLimitError } from '../../space/runtime/rate-limit-detector';
import { type CredentialStore } from '../../credentials/credential-store.js';
import { verifySignature } from '../../github/webhook-handler';
import type {
  ExternalEventExtensionContext,
  HttpExternalEventExtension,
  RpcExternalEventExtension,
} from '../types';
import {
  normalizeGitHubPollingRow,
  normalizeGitHubReaction,
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
];
// GitHub does not send issue/PR webhooks for reactions on the PR itself.
// Codex approval reactions are therefore polling-only via /issues/{number}/reactions.
const REQUIRED_WEBHOOK_EVENTS = WEBHOOK_EVENTS.filter((event) => event !== 'push');
const WEBHOOK_PATH = '/webhook/github/space';

interface GitHubEventExtensionOptions {
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Optional credential store used to persist the GitHub PAT outside env vars.
   * When provided, the extension reads the token from the store first and
   * falls back to the constructor-supplied env value.
   */
  credentialStore?: CredentialStore;
}

interface GitHubTokenStatus {
  configured: boolean;
  source: 'keychain' | 'env' | 'none';
  login?: string;
  error?: string;
  autoRegisteredHookCount?: number;
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
  /**
   * True when the active cooldown was derived from a `Retry-After` header.
   * Retry-After values may be shorter than the minimum backoff and should be
   * honored exactly rather than floored to `RATE_LIMIT_MIN_BACKOFF_MS`.
   */
  private rateLimitedFromRetryAfter = false;
  private readonly credentialStore?: CredentialStore;

  constructor(
    db: BunDatabase,
    private readonly githubToken = process.env.GITHUB_TOKEN,
    private readonly options: GitHubEventExtensionOptions = {}
  ) {
    this.repo = new GitHubEventExtensionRepository(db);
    this.credentialStore = options.credentialStore;
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
      // Re-enabling a space can revive polling-configured rows whose
      // `enabled` flag was just flipped back on. If the global polling
      // capability was cleared while the space was disabled (see
      // disablePollingCapabilityIfUnused), the timer would never restart
      // on its own. Re-arm the capability + timer here when any newly
      // re-enabled polling row exists.
      if (this.repo.listPollingRepos(params.spaceId).length > 0) {
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
      if (watchedRepo.pollingEnabled) {
        // Persist the user's intent to use polling in this space whenever a
        // repo is added/updated with polling enabled. This keeps the connection
        // card checkbox and the no-secret addRepo default consistent even if
        // the row is later removed.
        this.repo.setPollingIntent(params.spaceId, true);
        await this.persistSpaceConfig(context, watchedRepo.spaceId);
        await this.enablePollingCapability(context);
        this.ensurePollingActive();
      } else {
        // Per-row polling was turned off (or the row was added without
        // polling). If the user explicitly disabled the last polling-configured
        // row in this space, clear the per-space intent so the global
        // capability and UI checkbox reflect reality. Adding a non-polling row
        // to a space with intent=true does not clear it.
        if (
          existing?.pollingEnabled &&
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
      const existing = this.repo.getWatchedRepo(params.spaceId, params.owner, params.repo);
      if (existing?.webhookRemoteId && existing.webhookAutoRegistered) {
        await this.deleteRemoteWebhookIfUnshared(existing);
      }
      const removed = this.repo.removeWatchedRepo(params.spaceId, params.owner, params.repo);
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
      const params = (data ?? {}) as { spaceId?: string };
      return {
        count: params.spaceId
          ? await this.pollSpace(params.spaceId)
          : await this.pollEnabledSpaces(),
      };
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
      await this.credentialStore.set(GITHUB_CREDENTIAL_SERVICE, GITHUB_CREDENTIAL_ACCOUNT, token);
      log.info('GitHub token updated', { source: 'keychain' });
      return { success: true };
    });

    hub.onRequest('space.github.getTokenStatus', async () => {
      await assertRpcConfigEnabled(context, this.sourceId);
      return await this.getTokenStatus();
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
      await this.credentialStore.delete(GITHUB_CREDENTIAL_SERVICE, GITHUB_CREDENTIAL_ACCOUNT);
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
    const now = Date.now();
    let delay: number;
    if (now < this.rateLimitedUntil) {
      // Retry-After-based cooldowns may be shorter than the minimum backoff;
      // honor them exactly. Primary reset windows are floored to the minimum.
      delay = this.rateLimitedFromRetryAfter
        ? Math.max(0, this.rateLimitedUntil - now)
        : Math.max(RATE_LIMIT_MIN_BACKOFF_MS, this.rateLimitedUntil - now);
    } else {
      delay = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    }
    this.scheduleNextPollAfter(delay);
  }

  /**
   * Resolve the GitHub PAT from the credential store when wired, falling back
   * to the env-supplied token. Returns undefined when neither is available.
   */
  private async resolveToken(): Promise<string | undefined> {
    if (this.credentialStore) {
      try {
        const stored = await this.credentialStore.get(
          GITHUB_CREDENTIAL_SERVICE,
          GITHUB_CREDENTIAL_ACCOUNT
        );
        if (stored) return stored;
      } catch (error) {
        log.warn('Failed to read GitHub token from credential store', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.githubToken;
  }

  private async getTokenStatus(): Promise<GitHubTokenStatus> {
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
    if (!token && this.githubToken) {
      token = this.githubToken;
      source = 'env';
    }
    if (!token)
      return {
        configured: false,
        source: 'none',
        error: keychainError,
        autoRegisteredHookCount: this.repo.countAllAutoRegisteredHookRefs(),
      };

    try {
      const fetchImpl = this.options.fetchImpl ?? fetch;
      const response = await fetchImpl(`${GITHUB_API_BASE}/user`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'NeoKai-Space-GitHub/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      const autoRegisteredHookCount = this.repo.countAllAutoRegisteredHookRefs();
      if (response.ok) {
        const user = (await response.json()) as { login?: string };
        return { configured: true, source, login: user.login, autoRegisteredHookCount };
      }
      return {
        configured: true,
        source,
        error: `HTTP ${response.status}`,
        autoRegisteredHookCount,
      };
    } catch (error) {
      return {
        configured: true,
        source,
        error: error instanceof Error ? error.message : 'validation failed',
        autoRegisteredHookCount: this.repo.countAllAutoRegisteredHookRefs(),
      };
    }
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

  private ensurePollingActive(): void {
    if (this.stopped) return;
    if (this.pollTimer) return;
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
  private applyRateLimit(rateLimit: GitHubRateLimitInfo): void {
    // When resetAt is derived from Retry-After, honor it directly (not floored to min backoff).
    // When resetAt is derived from X-RateLimit-Reset (or missing), floor to min backoff.
    const resetDelay =
      rateLimit.resetAt > Date.now() ? rateLimit.resetAt - Date.now() : RATE_LIMIT_MIN_BACKOFF_MS;
    const delay = rateLimit.retryAfter
      ? resetDelay
      : Math.max(RATE_LIMIT_MIN_BACKOFF_MS, resetDelay);
    const newRateLimitedUntil = Date.now() + delay;
    // Preserve the longer cooldown to avoid shortening an existing backoff.
    if (newRateLimitedUntil > this.rateLimitedUntil) {
      this.rateLimitedUntil = newRateLimitedUntil;
      this.rateLimitedFromRetryAfter = rateLimit.retryAfter;
    }
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
    if (!(await this.resolveToken())) {
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
      throw error;
    }
  }

  private async githubFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.resolveToken();
    if (!token) {
      throw new Error('GITHUB_TOKEN is required for GitHub API requests');
    }
    const response = await (this.options.fetchImpl ?? fetch)(`${GITHUB_API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
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
    const recentPullRequestNumbers = cursor.recentPullRequestNumbers ?? [];
    const seenReactionIds = cursor.seenReactionIds ?? {};
    const reactionEtags = cursor.reactionEtags ?? {};
    const endpointLastSeenAt = cursor.endpointLastSeenAt ?? {};
    const endpointPendingLastSeenAt = cursor.endpointPendingLastSeenAt ?? {};
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
    let partialScan = false;
    let latestRateLimit: GitHubRateLimitInfo | undefined;

    const token = await this.resolveToken();
    for (const endpoint of endpoints) {
      const page = processedPages[endpoint.key] ?? 1;
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
      const endpointWatermark =
        savedEndpointWatermark > 0 ? savedEndpointWatermark : watermarks.committed;
      const since = endpointWatermark ? new Date(endpointWatermark).toISOString() : undefined;
      // Seed reaction-poll targets on upgrade: a cursor from before reaction
      // polling shipped may have an `etags.pulls` entry but no
      // `recentPullRequestNumbers`. Suppress both `If-None-Match` and `since`
      // for that one pulls fetch so GitHub returns the full newest list (an
      // empty delta under `since` would leave reaction targets unseeded until
      // unrelated PR metadata changes).
      const pullsNeedsSeed = endpoint.key === 'pulls' && recentPullRequestNumbers.length === 0;
      if (since && !pullsNeedsSeed) query.set('since', since);
      query.set('per_page', '100');
      query.set('page', String(page));
      const url = `${base}${endpoint.path}?${query.toString()}`;
      const headers = gitHubPollingHeaders(token);
      if (page === 1 && etags[endpoint.key] && !pullsNeedsSeed) {
        headers['If-None-Match'] = etags[endpoint.key];
      }
      const response = await fetchImpl(url, { headers });
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
      if (response.status === 304) continue;
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
        continue;
      }
      const etag = response.headers.get('ETag');
      if (etag && page === 1) etags[endpoint.key] = etag;
      const rows = (await response.json()) as unknown[];
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
        for (const row of rows) {
          // Reaction approvals are only meaningful on open PRs under review;
          // a +1 on a closed/merged PR is irrelevant and would occupy a slot
          // that an active open PR needs. Filter to open state.
          if (!isPullRequestOpen(row)) continue;
          const prNumber = pullRequestNumberFrom(row);
          if (prNumber && !freshNumbers.includes(prNumber)) freshNumbers.push(prNumber);
        }
        const next = [
          ...freshNumbers,
          ...recentPullRequestNumbers.filter((n) => !freshNumbers.includes(n)),
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
      processedPages[endpoint.key] = rows.length >= 100 ? page + 1 : 1;
      // Only advance the per-endpoint watermark once the endpoint's backlog is
      // complete. While pages remain, the next poll must keep using the old
      // watermark so remaining pages are not filtered out by `since`.
      if (processedPages[endpoint.key] === 1) {
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
        partialScan = true;
        break;
      }
      const query = new URLSearchParams({ per_page: '100' });
      const reactionHeaders = gitHubPollingHeaders(token);
      if (reactionEtags[prNumber]) reactionHeaders['If-None-Match'] = reactionEtags[prNumber];
      const response = await fetchImpl(`${base}/issues/${prNumber}/reactions?${query.toString()}`, {
        headers: reactionHeaders,
      });
      const reactionRateLimit = parseRateLimitHeaders(response);
      latestRateLimit = mergeRateLimitInfo(latestRateLimit, reactionRateLimit);
      if (response.status === 304) {
        // Reaction list unchanged since the last poll — keep the ETag and
        // skip the PR. 304s do not count against the rate-limit budget.
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
          partialScan = true;
          break;
        }
        continue;
      }
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
        partialScan = true;
        break;
      }
    }

    const hasBacklog = Object.values(processedPages).some((page) => page > 1);
    // Prune reaction ETags for PRs that are no longer reaction-poll targets
    // so the cursor does not grow unbounded across a repo's lifetime.
    const trackedPrSet = new Set(recentPullRequestNumbers);
    for (const key of Object.keys(reactionEtags)) {
      if (!trackedPrSet.has(Number(key))) delete reactionEtags[Number(key)];
    }
    // After a partial scan, do not advance the shared watermark; skipped
    // endpoints would miss events between the old watermark and the new one.
    // The processed endpoint's own watermark is recorded separately.
    const cursorPayload: PollCursor = {
      lastSeenAt: partialScan || hasBacklog ? watermarks.committed : watermarks.pending,
      pendingLastSeenAt: partialScan || hasBacklog ? watermarks.pending : undefined,
      etags,
      processedPages,
      recentPullRequestNumbers,
      seenReactionIds,
      reactionEtags,
      endpointLastSeenAt,
      endpointPendingLastSeenAt,
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

function gitHubRepoPath(owner: string, repo: string): string {
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function gitHubPollingHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'NeoKai-Space-GitHub/1.0',
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

function pullRequestNumberFrom(row: unknown): number {
  if (!row || typeof row !== 'object') return 0;
  const number = (row as { number?: unknown }).number;
  return typeof number === 'number' ? number : 0;
}

function isPullRequestOpen(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  const state = (row as { state?: unknown }).state;
  return state === 'open';
}

function isPositiveReaction(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  const content = (row as { content?: unknown }).content;
  return content === '+1' || content === 'thumbs_up';
}

function reactionIdFrom(row: unknown): string {
  if (!row || typeof row !== 'object') return '';
  const id = (row as { id?: unknown }).id;
  return typeof id === 'number' ? String(id) : '';
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
