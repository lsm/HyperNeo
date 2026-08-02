/**
 * Unit tests for the `space.github.health` integration health snapshot RPC.
 *
 * Covers:
 *   - The handler aggregates token, polling interval, webhook summary,
 *     reaction-poll targets, recent failed deliveries, and a per-repo rollup.
 *   - Rate-limit state retained on the instance (cooldown window + last-seen
 *     remaining/reset) is reflected in the snapshot.
 *   - The handler is gated behind the RPC config capability.
 */
import { Database as BunDatabase } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { InProcessTransport, MessageHub } from '@hyperneo/shared';
import { describe, expect, test } from 'bun:test';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import {
  GitHubEventExtension,
  type GitHubHealthSnapshot,
} from '../../../../src/lib/external-events/github/github-event-extension';
import { ExternalEventStore, type ExternalEvent } from '../../../../src/lib/external-events';
import type {
  ExternalEventExtensionConfigStore,
  SpaceExternalEventSourceConfig,
} from '../../../../src/lib/external-events/types';

function setupDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  createTables(db);
  runMigrations(db, () => {});
  return db;
}

/** Insert a minimal space row so external-event FK constraints are satisfied. */
function seedSpace(db: BunDatabase, spaceId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(spaceId, spaceId, `/tmp/${spaceId}`, spaceId, now, now);
}

class HealthConfigStore implements ExternalEventExtensionConfigStore {
  async getGlobalConfig(source: string) {
    return {
      source,
      globallyEnabled: true,
      capabilities: { webhooks: true, polling: true, rpcConfig: true },
      settings: {},
    };
  }
  async getSpaceConfig(spaceId: string, source: string): Promise<SpaceExternalEventSourceConfig> {
    return { spaceId, source, enabled: true, settings: {} };
  }
  async listEnabledSpaces(): Promise<SpaceExternalEventSourceConfig[]> {
    return [];
  }
  async setGlobalConfig(): Promise<void> {}
  async setSpaceConfig(): Promise<void> {}
}

class RpcDisabledConfigStore implements ExternalEventExtensionConfigStore {
  async getGlobalConfig(source: string) {
    return {
      source,
      globallyEnabled: true,
      capabilities: { webhooks: true, polling: true, rpcConfig: false },
      settings: {},
    };
  }
  async getSpaceConfig(spaceId: string, source: string): Promise<SpaceExternalEventSourceConfig> {
    return { spaceId, source, enabled: true, settings: {} };
  }
  async listEnabledSpaces(): Promise<SpaceExternalEventSourceConfig[]> {
    return [];
  }
  async setGlobalConfig(): Promise<void> {}
  async setSpaceConfig(): Promise<void> {}
}

class WebhooksDisabledConfigStore implements ExternalEventExtensionConfigStore {
  async getGlobalConfig(source: string) {
    return {
      source,
      globallyEnabled: true,
      capabilities: { webhooks: false, polling: true, rpcConfig: true },
      settings: {},
    };
  }
  async getSpaceConfig(spaceId: string, source: string): Promise<SpaceExternalEventSourceConfig> {
    return { spaceId, source, enabled: true, settings: {} };
  }
  async listEnabledSpaces(): Promise<SpaceExternalEventSourceConfig[]> {
    return [];
  }
  async setGlobalConfig(): Promise<void> {}
  async setSpaceConfig(): Promise<void> {}
}

/** In-memory CredentialStore for exercising the setToken/clearToken RPCs. */
class MemoryCredentialStore {
  private readonly entries = new Map<string, string>();
  async get(service: string, account: string): Promise<string | null> {
    return this.entries.get(`${service}:${account}`) ?? null;
  }
  async set(service: string, account: string, data: string): Promise<void> {
    this.entries.set(`${service}:${account}`, data);
  }
  async delete(service: string, account: string): Promise<void> {
    this.entries.delete(`${service}:${account}`);
  }
  async listServices(): Promise<string[]> {
    return [...new Set([...this.entries.keys()].map((k) => k.split(':')[0]))];
  }
}

/** Minimal fetch impl that validates the PAT against a fake /user endpoint. */
function fakeUserFetch(login: string): typeof fetch {
  return (async (url: string | URL | Request) => {
    const path = typeof url === 'string' ? url : url.toString();
    if (path.endsWith('/user')) {
      return new Response(JSON.stringify({ login }), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
}

/** Mirrors the daemon's credentialFingerprint helper (SHA-256) for test seeding. */
function fp(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}

function buildEvent(spaceId: string, id: string): ExternalEvent {
  return {
    id,
    spaceId,
    source: 'github',
    topic: `github/acme/widgets/pull_request/${id}.opened`,
    occurredAt: 1_700_000_000_000,
    ingestedAt: 1_700_000_001_000,
    summary: `PR #${id} opened`,
    dedupeKey: `github:pr:${id}:opened`,
    payload: { number: Number(id), action: 'opened' },
  };
}

async function setupHub(
  extension: GitHubEventExtension,
  configStore: ExternalEventExtensionConfigStore
) {
  const clientHub = new MessageHub();
  const hub = new MessageHub();
  const [clientTransport, serverTransport] = InProcessTransport.createPair();
  clientHub.registerTransport(clientTransport);
  hub.registerTransport(serverTransport);
  await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
  const context = {
    publisher: { publish: async () => {} },
    config: configStore,
    onSourceConfigChanged() {},
  };
  await extension.start(context);
  extension.registerRpcHandlers(hub, context);
  return clientHub;
}

describe('GitHubEventExtension health snapshot (space.github.health)', () => {
  test('aggregates token, polling, webhook, reaction, and recent-error state', async () => {
    const db = setupDb();
    const configStore = new HealthConfigStore();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      pollIntervalMs: 90_000,
      fetchImpl: fakeUserFetch('octocat'),
    });

    // Repo A: webhook delivery, active hook.
    const repoA = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
      webhookActive: true,
      webhookLastCheckedAt: 1_700_000_002_000,
    });
    extension.repo.markWebhookReceived(repoA.id);
    // Repo B: webhook delivery, inactive hook with an error.
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'gadgets',
      webhookEnabled: true,
      webhookActive: false,
      webhookLastError: 'GitHub webhook is disabled',
      webhookLastCheckedAt: 1_700_000_003_000,
    });
    // Repo C: polling-only with two PRs tracked for reaction polling.
    const repoC = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'sprockets',
      webhookEnabled: false,
      pollingEnabled: true,
    });
    extension.repo.updatePollCursor(repoC.id, {
      recentPullRequestNumbers: [7, 8],
      lastReactionPollAt: 1_700_000_000_000,
      lastPollCredentialFingerprint: fp('ghp_token'),
    });

    // Seed a failed delivery so recentErrors is non-empty.
    seedSpace(db, 'space-1');
    const store = new ExternalEventStore(db);
    const { event } = store.store(buildEvent('space-1', '42'));
    store.registerExpectedDelivery(event.id, 'delivery-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.markDeliveryFailed(event.id, 'delivery-1', {
      terminal: true,
      reason: 'agent session missing',
    });

    // Simulate rate-limit state retained from a prior poll cycle.
    const resetAt = Date.now() + 120_000;
    const ext = extension as unknown as {
      rateLimitedUntil: number;
      lastRateLimitInfo: {
        remaining: number;
        resetAt: number;
        limited: boolean;
        retryAfter: boolean;
      };
      lastRateLimitObservedAt: number;
    };
    ext.rateLimitedUntil = Date.now() + 60_000;
    ext.lastRateLimitInfo = { remaining: 3, resetAt, limited: true, retryAfter: false };
    ext.lastRateLimitObservedAt = Date.now() - 5_000;

    try {
      const clientHub = await setupHub(extension, configStore);
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });

      expect(snapshot.source).toBe('github');
      expect(snapshot.spaceId).toBe('space-1');
      expect(snapshot.token).toMatchObject({ configured: true, source: 'env', login: 'octocat' });
      expect(snapshot.polling.intervalMs).toBe(90_000);
      expect(snapshot.polling.globallyEnabled).toBe(true);
      expect(snapshot.polling.pollingRepoCount).toBe(1);
      expect(snapshot.polling.lastPollAt).toBeGreaterThan(0);

      expect(snapshot.rateLimit.limited).toBe(true);
      expect(snapshot.rateLimit.until).toBeGreaterThan(Date.now());
      expect(snapshot.rateLimit.remaining).toBe(3);
      expect(snapshot.rateLimit.resetAt).toBe(resetAt);
      expect(snapshot.rateLimit.observedAt).toBeGreaterThan(0);

      expect(snapshot.webhook).toMatchObject({ total: 3, configured: 2, active: 1, inactive: 1 });
      expect(snapshot.webhook.errors).toEqual([
        expect.objectContaining({
          owner: 'acme',
          repo: 'gadgets',
          error: 'GitHub webhook is disabled',
        }),
      ]);
      expect(snapshot.webhook.lastWebhookAt).toBeGreaterThan(0);

      expect(snapshot.reactions.trackedPullRequests).toBe(2);
      expect(snapshot.reactions.lastActivityAt).toBeGreaterThan(0);

      expect(snapshot.recentErrors).toHaveLength(1);
      expect(snapshot.recentErrors[0]).toMatchObject({
        topic: 'github/acme/widgets/pull_request/42.opened',
        agentName: 'coder',
        failureReason: 'agent session missing',
      });

      expect(snapshot.repositories).toHaveLength(3);
      const sprockets = snapshot.repositories.find((r) => r.repo === 'sprockets');
      expect(sprockets?.pollingEnabled).toBe(true);
      expect(sprockets?.reactionTrackedPullRequests).toBe(2);
    } finally {
      await extension.stop();
    }
  });

  test('rate-limit remaining is null and limited is false before any poll observes it', async () => {
    const db = setupDb();
    const configStore = new HealthConfigStore();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });

    try {
      const clientHub = await setupHub(extension, configStore);
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(snapshot.rateLimit.limited).toBe(false);
      expect(snapshot.rateLimit.until).toBe(0);
      expect(snapshot.rateLimit.remaining).toBeNull();
      expect(snapshot.rateLimit.resetAt).toBeNull();
      expect(snapshot.rateLimit.observedAt).toBe(0);
      expect(snapshot.recentErrors).toEqual([]);
      expect(snapshot.webhook.total).toBe(0);
    } finally {
      await extension.stop();
    }
  });

  test('is gated behind the RPC config capability', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const clientHub = await setupHub(extension, new RpcDisabledConfigStore());

    await expect(clientHub.request('space.github.health', { spaceId: 'space-1' })).rejects.toThrow(
      'GitHub RPC configuration capability is disabled'
    );
    await extension.stop();
  });

  test('requires a spaceId', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const clientHub = await setupHub(extension, new HealthConfigStore());
    await expect(clientHub.request('space.github.health', {})).rejects.toThrow(
      'spaceId is required'
    );
    await extension.stop();
  });

  test('an all-304 poll cycle preserves a previously observed finite rate-limit budget', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    const repo = extension.repo.listPollingRepos('space-1')[0];
    // Simulate a finite budget observed by an earlier cycle.
    const ext = extension as unknown as {
      lastRateLimitInfo: {
        remaining: number;
        resetAt: number;
        limited: boolean;
        retryAfter: boolean;
      };
      lastRateLimitObservedAt: number;
    };
    const priorReset = Date.now() + 3_600_000;
    ext.lastRateLimitInfo = {
      remaining: 1234,
      resetAt: priorReset,
      limited: false,
      retryAfter: false,
    };
    ext.lastRateLimitObservedAt = Date.now() - 1_000;

    // Every endpoint responds 304 (cached, no rate-limit headers) — the steady
    // state. This must NOT overwrite the prior finite observation.
    const notModified = (() => new Response(null, { status: 304 })) as typeof fetch;
    await extension.pollWatchedRepo(repo, notModified);

    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(snapshot.rateLimit.remaining).toBe(1234);
      expect(snapshot.rateLimit.resetAt).toBe(priorReset);
      expect(snapshot.rateLimit.observedAt).toBeGreaterThan(0);
    } finally {
      await extension.stop();
    }
  });

  test('disabled repositories do not contribute to the webhook health summary', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    // Enabled repo with an active hook.
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'enabled-repo',
      webhookEnabled: true,
      webhookActive: true,
    });
    // Disabled repo (space.github.disable flips this) that still carries an
    // active remote hook — it must not inflate the active tally.
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'disabled-repo',
      enabled: false,
      webhookEnabled: true,
      webhookActive: true,
    });

    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(snapshot.webhook.total).toBe(2);
      expect(snapshot.webhook.configured).toBe(1);
      expect(snapshot.webhook.active).toBe(1);
    } finally {
      await extension.stop();
    }
  });

  test('reports webhook delivery disabled when the webhooks capability is off', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
      webhookActive: true,
    });

    try {
      const clientHub = await setupHub(extension, new WebhooksDisabledConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(snapshot.webhook.deliveryEnabled).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('excludes terminal delivery failures outside the recent-error window', async () => {
    const db = setupDb();
    seedSpace(db, 'space-1');
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const store = new ExternalEventStore(db);
    const { event } = store.store(buildEvent('space-1', '42'));
    store.registerExpectedDelivery(event.id, 'delivery-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.markDeliveryFailed(event.id, 'delivery-1', {
      terminal: true,
      reason: 'agent session missing',
    });
    // Backdate the failure beyond the 24h health window so it is historical only.
    db.prepare('UPDATE space_external_event_deliveries SET updated_at = ? WHERE event_id = ?').run(
      Date.now() - 48 * 60 * 60 * 1000,
      event.id
    );

    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(snapshot.recentErrors).toEqual([]);
    } finally {
      await extension.stop();
    }
  });

  test('recentErrors surfaces GitHub failures even when newer failures are from another source', async () => {
    // The source filter must apply before the LIMIT, otherwise 5 newer
    // non-GitHub failures would crowd out a still-recent GitHub failure.
    const db = setupDb();
    seedSpace(db, 'space-1');
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const store = new ExternalEventStore(db);
    // One GitHub failure.
    const gh = store.store(buildEvent('space-1', '100'));
    store.registerExpectedDelivery(gh.event.id, 'gh-delivery', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.markDeliveryFailed(gh.event.id, 'gh-delivery', {
      terminal: true,
      reason: 'agent session missing',
    });
    // Five NEWER failures from a different registered source (updated_at desc).
    for (let i = 0; i < 5; i++) {
      const other = store.store({
        ...buildEvent('space-1', `other-${i}`),
        source: 'space',
        topic: `space/acme/widgets/${i}`,
        dedupeKey: `space:${i}`,
      });
      store.registerExpectedDelivery(other.event.id, `other-delivery-${i}`, {
        workflowRunId: 'run-1',
        taskId: 'task-1',
        nodeId: 'node-1',
        agentName: 'coder',
      });
      store.markDeliveryFailed(other.event.id, `other-delivery-${i}`, {
        terminal: true,
        reason: 'gitlab failure',
      });
      // Backdate slightly so the GitHub failure is older than the GitLab ones.
      db.prepare(
        'UPDATE space_external_event_deliveries SET updated_at = ? WHERE event_id = ?'
      ).run(Date.now() - 60_000, other.event.id);
    }

    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(snapshot.recentErrors).toHaveLength(1);
      expect(snapshot.recentErrors[0].eventId).toBe(gh.event.id);
    } finally {
      await extension.stop();
    }
  });

  test('a toggled-off webhook does not contribute historical delivery to the rollup', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    // Repo delivered via webhook, then had webhooks toggled off. The row stays
    // enabled and retains lastWebhookAt, but must not read as a live path.
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
    });
    extension.repo.markWebhookReceived(repo.id);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: false,
    });

    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(snapshot.webhook.lastWebhookAt).toBeNull();
      expect(snapshot.webhook.errors).toEqual([]);
    } finally {
      await extension.stop();
    }
  });

  test('pollOnce RPC is rejected when the global poll interval is 0', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      pollIntervalMs: 0,
      fetchImpl: fakeUserFetch('octocat'),
    });
    const clientHub = await setupHub(extension, new HealthConfigStore());

    await expect(
      clientHub.request('space.github.pollOnce', { spaceId: 'space-1' })
    ).rejects.toThrow('GitHub polling is disabled (interval is 0)');
    await extension.stop();
  });

  test('a valid-but-unauthorized PAT records an inaccessible polling repo', async () => {
    const db = setupDb();
    // /user validates (token is "valid"), but every repo endpoint is denied.
    const deniedFetch = (async (url: string | URL | Request) => {
      const path = typeof url === 'string' ? url : url.toString();
      if (path.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'Resource not accessible' }), {
        status: 403,
      });
    }) as typeof fetch;
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      pollIntervalMs: 60_000,
      fetchImpl: deniedFetch,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });

    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      // Run one poll cycle so the inaccessibility is recorded on the cursor.
      await extension.pollWatchedRepo(extension.repo.listPollingRepos('space-1')[0], deniedFetch);
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(snapshot.polling.inaccessibleRepoCount).toBe(1);
      expect(snapshot.repositories[0].lastPollError).toContain('Resource not accessible');
    } finally {
      await extension.stop();
    }
  });

  test('a partially accessible repo records a partial poll error, not inaccessible', async () => {
    const db = setupDb();
    // issue_comments/review_comments succeed, /pulls is denied (e.g. a
    // fine-grained PAT with issue-comment but no pull-request access).
    const partialFetch = (async (url: string | URL | Request) => {
      const path = typeof url === 'string' ? url : url.toString();
      if (path.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
      }
      if (path.includes('/pulls?')) {
        return new Response(JSON.stringify({ message: 'Resource not accessible' }), {
          status: 403,
        });
      }
      return new Response('[]', { status: 200 });
    }) as typeof fetch;
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      pollIntervalMs: 60_000,
      fetchImpl: partialFetch,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });

    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      await extension.pollWatchedRepo(extension.repo.listPollingRepos('space-1')[0], partialFetch);
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      // Reached some endpoints, so it is NOT fully inaccessible.
      expect(snapshot.polling.inaccessibleRepoCount).toBe(0);
      // But /pulls failed, so it is a partial (Degraded) condition.
      expect(snapshot.polling.partialErrorRepoCount).toBe(1);
      expect(snapshot.repositories[0].lastPartialPollError).toContain('Resource not accessible');
    } finally {
      await extension.stop();
    }
  });

  test('a network-thrown poll records an inaccessible repo instead of aborting', async () => {
    const db = setupDb();
    // Every repo endpoint rejects (connection reset / timeout / DNS).
    const throwingFetch = (async (url: string | URL | Request) => {
      const path = typeof url === 'string' ? url : url.toString();
      if (path.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
      }
      throw new Error('connect ECONNRESET');
    }) as typeof fetch;
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      pollIntervalMs: 60_000,
      fetchImpl: throwingFetch,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });

    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      // Must not throw — the failure is recorded on the cursor instead.
      await extension.pollWatchedRepo(extension.repo.listPollingRepos('space-1')[0], throwingFetch);
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(snapshot.polling.inaccessibleRepoCount).toBe(1);
      expect(snapshot.repositories[0].lastPollError).toContain('ECONNRESET');
    } finally {
      await extension.stop();
    }
  });

  test('clearing the token resets the cached rate-limit observation', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const ext = extension as unknown as {
      lastRateLimitInfo?: {
        remaining: number;
        resetAt: number;
        limited: boolean;
        retryAfter: boolean;
      };
      lastRateLimitObservedAt: number;
      rateLimitedUntil: number;
      rateLimitedFromRetryAfter: boolean;
      resetRateLimitObservation: () => void;
    };
    ext.lastRateLimitInfo = {
      remaining: 5,
      resetAt: Date.now() + 60_000,
      limited: false,
      retryAfter: false,
    };
    ext.lastRateLimitObservedAt = Date.now();
    ext.rateLimitedUntil = Date.now() + 3_600_000;
    ext.rateLimitedFromRetryAfter = true;

    ext.resetRateLimitObservation();
    expect(ext.lastRateLimitInfo).toBeUndefined();
    expect(ext.lastRateLimitObservedAt).toBe(0);
    expect(ext.rateLimitedUntil).toBe(0);
    expect(ext.rateLimitedFromRetryAfter).toBe(false);
  });

  test('clearToken RPC clears the active cooldown so a fresh PAT can poll', async () => {
    // Drive the call site (the RPC), not just the private method, so a revert
    // of the setToken/clearToken wiring is caught.
    const db = setupDb();
    const credentialStore = new MemoryCredentialStore();
    const extension = new GitHubEventExtension(db, undefined, {
      credentialStore,
      fetchImpl: fakeUserFetch('octocat'),
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    const ext = extension as unknown as { rateLimitedUntil: number };
    ext.rateLimitedUntil = Date.now() + 3_600_000;

    const clientHub = await setupHub(extension, new HealthConfigStore());
    await clientHub.request('space.github.setToken', { token: 'ghp_newcredential' });

    expect(ext.rateLimitedUntil).toBe(0);
    const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
      spaceId: 'space-1',
    });
    expect(snapshot.rateLimit.limited).toBe(false);
    expect(snapshot.rateLimit.until).toBe(0);
    await extension.stop();
  });

  test('a silent keychain rotation (no generation bump) clears a stale rate-limit cooldown', async () => {
    // The cooldown-clear block in buildHealthSnapshot compares
    // lastRateLimitFingerprint (the credential that observed the cooldown)
    // against the just-validated fingerprint. A keychain rotation performed
    // OUTSIDE the setToken/clearToken RPCs does not bump credentialGeneration,
    // so the generation-guarded clears (the setToken/clearToken paths above)
    // cannot fire — only this fingerprint-mismatch path catches it. This was the
    // dead/broken half across rounds 58-60; commit it so a regression is caught
    // by the suite, not a throwaway repro.
    const db = setupDb();
    const credentialStore = new MemoryCredentialStore();
    // Initial credential that observed the cooldown.
    await credentialStore.set('neokai.external-events.github', 'default', 'ghp_A');
    const extension = new GitHubEventExtension(db, undefined, {
      credentialStore,
      fetchImpl: fakeUserFetch('octocat'),
    });
    const ext = extension as unknown as {
      rateLimitedUntil: number;
      lastRateLimitFingerprint?: string;
    };
    // A cooldown observed by ghp_A, tagged with its fingerprint.
    ext.rateLimitedUntil = Date.now() + 3_600_000;
    ext.lastRateLimitFingerprint = fp('ghp_A');
    // Silent rotation to a different credential — a direct store write, no
    // setToken RPC — so credentialGeneration does NOT bump and the generation-
    // guarded clear path cannot fire. Only the fingerprint-mismatch path can.
    await credentialStore.set('neokai.external-events.github', 'default', 'ghp_B');

    const clientHub = await setupHub(extension, new HealthConfigStore());
    const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
      spaceId: 'space-1',
    });
    expect(ext.rateLimitedUntil).toBe(0);
    expect(snapshot.rateLimit.limited).toBe(false);
    expect(snapshot.rateLimit.until).toBe(0);
    await extension.stop();
  });

  test('rate-limit observations from a superseded credential are discarded', () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const ext = extension as unknown as {
      credentialGeneration: number;
      pollCycleCredentialGeneration: number | null;
      applyRateLimit: (rateLimit: {
        remaining: number;
        resetAt: number;
        limited: boolean;
        retryAfter: boolean;
      }) => void;
      rateLimitedUntil: number;
    };
    // A poll cycle is in flight under generation G.
    ext.pollCycleCredentialGeneration = ext.credentialGeneration;
    const staleGeneration = ext.credentialGeneration;
    // The credential changes mid-cycle (setToken/clearToken bumped generation).
    ext.credentialGeneration = staleGeneration + 1;
    // The stale cycle's rate-limit write must be ignored.
    ext.applyRateLimit({
      remaining: 0,
      resetAt: Date.now() + 60_000,
      limited: true,
      retryAfter: false,
    });
    expect(ext.rateLimitedUntil).toBe(0);
    // A cycle whose generation still matches applies normally.
    ext.pollCycleCredentialGeneration = ext.credentialGeneration;
    ext.applyRateLimit({
      remaining: 0,
      resetAt: Date.now() + 60_000,
      limited: true,
      retryAfter: false,
    });
    expect(ext.rateLimitedUntil).toBeGreaterThan(0);
  });

  test('a poll-cycle rate limit is tagged with the cycle fingerprint, not a concurrently-mutated lastResolvedToken', () => {
    // pollWatchedRepoCore captures pollCycleCredentialFingerprint from the token
    // it actually resolves (after resolveToken), so applyRateLimit attributes a
    // rate limit to the right credential even if a concurrent health refresh
    // overwrites the shared lastResolvedToken field during the poll's await.
    // Before this fix the capture ran in the wrapper before resolveToken, where
    // lastResolvedToken could be null ('none') — the cooldown was then wrongly
    // tagged and cleared on the next validation. The cycle fingerprint must win
    // over lastResolvedToken in the applyRateLimit precedence chain.
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const ext = extension as unknown as {
      credentialGeneration: number;
      pollCycleCredentialGeneration: number | null;
      pollCycleCredentialFingerprint: string | null;
      lastResolvedToken: string | undefined;
      applyRateLimit: (rateLimit: {
        remaining: number;
        resetAt: number;
        limited: boolean;
        retryAfter: boolean;
      }) => void;
      lastRateLimitFingerprint?: string;
    };
    // The core resolved ghp_token and captured its fingerprint for this cycle.
    ext.pollCycleCredentialGeneration = ext.credentialGeneration;
    ext.pollCycleCredentialFingerprint = fp('ghp_token');
    // A concurrent health refresh resolved a rotated token and overwrote the
    // shared field during the poll's in-flight await — must NOT win.
    ext.lastResolvedToken = 'ghp_rotated_token';
    ext.applyRateLimit({
      remaining: 0,
      resetAt: Date.now() + 60_000,
      limited: true,
      retryAfter: false,
    });
    expect(ext.lastRateLimitFingerprint).toBe(fp('ghp_token'));
  });

  test('a shorter rate limit under the SAME credential preserves the longer cooldown', () => {
    // Token A owns a long cooldown. A SHORTER rate limit observed again for the
    // SAME token A must not shorten the existing backoff (preserve-longer) and
    // must not retag the fingerprint. Preserve-longer applies only within a
    // credential — a different credential's observation replaces (see the
    // cross-credential replace test below).
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_A', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const ext = extension as unknown as {
      rateLimitedUntil: number;
      lastRateLimitFingerprint?: string;
      lastResolvedToken: string | undefined;
      applyRateLimit: (rateLimit: {
        remaining: number;
        resetAt: number;
        limited: boolean;
        retryAfter: boolean;
      }) => void;
    };
    const longUntil = Date.now() + 3_600_000;
    ext.rateLimitedUntil = longUntil;
    ext.lastRateLimitFingerprint = fp('ghp_A');
    // Same credential (A) observes a shorter window — preserve-longer keeps A's
    // longer deadline and fingerprint.
    ext.lastResolvedToken = 'ghp_A';
    ext.applyRateLimit({
      remaining: 0,
      resetAt: Date.now() + 60_000,
      limited: true,
      retryAfter: false,
    });
    expect(ext.lastRateLimitFingerprint).toBe(fp('ghp_A'));
    // Deadline preserved at A's long window (not shortened to the 60s observation).
    expect(ext.rateLimitedUntil).toBe(longUntil);
  });

  test('a shorter rate limit under a DIFFERENT credential replaces the stale cooldown', () => {
    // Token A owns a long cooldown. A silent rotation to B is validated with a
    // shorter active rate-limit window. A's deadline is irrelevant to B, so B's
    // observation REPLACES it (preserve-longer does not apply across credentials)
    // — otherwise buildHealthSnapshot would clear A's deadline and leave B with
    // no cooldown while it is still rate-limited.
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_A', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const ext = extension as unknown as {
      rateLimitedUntil: number;
      lastRateLimitFingerprint?: string;
      lastResolvedToken: string | undefined;
      applyRateLimit: (rateLimit: {
        remaining: number;
        resetAt: number;
        limited: boolean;
        retryAfter: boolean;
      }) => void;
    };
    ext.rateLimitedUntil = Date.now() + 3_600_000;
    ext.lastRateLimitFingerprint = fp('ghp_A');
    // B (a different credential) observes a shorter window — replaces A's cooldown.
    ext.lastResolvedToken = 'ghp_B';
    ext.applyRateLimit({
      remaining: 0,
      resetAt: Date.now() + 60_000,
      limited: true,
      retryAfter: false,
    });
    expect(ext.lastRateLimitFingerprint).toBe(fp('ghp_B'));
    // B's shorter deadline applies (A's longer one is discarded as stale).
    expect(ext.rateLimitedUntil).toBeLessThan(Date.now() + 3_600_000);
    expect(ext.rateLimitedUntil).toBeGreaterThan(Date.now());
  });

  test('a validation rate limit is attributed to the validated token, not an in-flight poll credential', async () => {
    // An in-flight repo poll under token A has set pollCycleCredentialFingerprint
    // to fp(A). A concurrent /user validation of token B observes a low budget
    // and applies a cooldown via applyRateLimit(..., true). It must be tagged to
    // B (the validated token) — otherwise buildHealthSnapshot sees fp(A) !== the
    // validated fp(B) and immediately clears B's cooldown, re-enabling polling
    // against an exhausted quota.
    const db = setupDb();
    const credentialStore = new MemoryCredentialStore();
    await credentialStore.set('neokai.external-events.github', 'default', 'ghp_B');
    const extension = new GitHubEventExtension(db, undefined, {
      credentialStore,
      fetchImpl: (async (url: string | URL | Request) => {
        const path = typeof url === 'string' ? url : url.toString();
        if (path.endsWith('/user')) {
          // Low budget for B → applyRateLimit fires on the success path.
          return new Response(JSON.stringify({ login: 'octocat' }), {
            status: 200,
            headers: {
              'X-RateLimit-Remaining': '0',
              'X-RateLimit-Reset': String(Math.floor((Date.now() + 3_600_000) / 1000)),
            },
          });
        }
        return new Response('[]', { status: 200 });
      }) as typeof fetch,
    });
    const ext = extension as unknown as {
      credentialGeneration: number;
      pollCycleCredentialGeneration: number | null;
      pollCycleCredentialFingerprint: string | null;
      rateLimitedUntil: number;
      lastRateLimitFingerprint?: string;
    };
    // Simulate an in-flight poll under token A (different from the validated B).
    ext.pollCycleCredentialGeneration = ext.credentialGeneration;
    ext.pollCycleCredentialFingerprint = fp('ghp_A');

    const clientHub = await setupHub(extension, new HealthConfigStore());
    await clientHub.request<GitHubHealthSnapshot>('space.github.health', { spaceId: 'space-1' });
    // Cooldown attributed to B (the validated token), so it survives the
    // snapshot's stale-cooldown clear (fp(B) === validated fp(B)).
    expect(ext.rateLimitedUntil).toBeGreaterThan(0);
    expect(ext.lastRateLimitFingerprint).toBe(fp('ghp_B'));
    await extension.stop();
  });

  test('a cooldown tagged to the now-effective credential is not cleared by a stale validated fingerprint', async () => {
    // resolveTokenStatus validates token A; during the config reads the keychain
    // rotates to B and a concurrent poll/validation tags a cooldown to B. The
    // clear block must compare against the EFFECTIVE credential (B), not the stale
    // validatedFingerprint (A) — otherwise B's valid cooldown is cleared and
    // polling re-arms against an exhausted quota.
    const db = setupDb();
    const credentialStore = new MemoryCredentialStore();
    await credentialStore.set('neokai.external-events.github', 'default', 'ghp_A');
    // Pre-seed a cooldown tagged to B (the post-rotation credential), standing in
    // for one a concurrent poll/validation would record during the config awaits.
    const extension = new GitHubEventExtension(db, undefined, {
      credentialStore,
      fetchImpl: fakeUserFetch('octocat'),
    });
    const ext = extension as unknown as {
      rateLimitedUntil: number;
      lastRateLimitFingerprint?: string;
    };
    ext.rateLimitedUntil = Date.now() + 3_600_000;
    ext.lastRateLimitFingerprint = fp('ghp_B');
    // Rotate A→B on the 3rd getGlobalConfig call (buildHealthSnapshot's
    // isPollingGloballyEnabled, AFTER resolveTokenStatus validated A).
    let getGlobalConfigCalls = 0;
    let rotated = false;
    const rotatingConfig: ExternalEventExtensionConfigStore = {
      async getGlobalConfig(source: string) {
        getGlobalConfigCalls++;
        if (!rotated && getGlobalConfigCalls >= 3) {
          rotated = true;
          await credentialStore.set('neokai.external-events.github', 'default', 'ghp_B');
        }
        return {
          source,
          globallyEnabled: true,
          capabilities: { webhooks: true, polling: true, rpcConfig: true },
          settings: {},
        };
      },
      async getSpaceConfig(spaceId: string, source: string) {
        return { spaceId, source, enabled: true, settings: {} };
      },
      async listEnabledSpaces() {
        return [];
      },
      async setGlobalConfig() {},
      async setSpaceConfig() {},
    };

    const clientHub = await setupHub(extension, rotatingConfig);
    await clientHub.request<GitHubHealthSnapshot>('space.github.health', { spaceId: 'space-1' });
    // B's cooldown survives — it belongs to the effective credential.
    expect(ext.rateLimitedUntil).toBeGreaterThan(0);
    expect(ext.lastRateLimitFingerprint).toBe(fp('ghp_B'));
    await extension.stop();
  });

  test('a transient credential-store failure on the final read keeps the active cooldown', async () => {
    // The keychain is readable during validation (token A validated) but throws
    // on buildHealthSnapshot's final credential read. The fallback fingerprint
    // (env/none) differs from lastRateLimitFingerprint, but this is a read
    // failure, not a rotation — the cooldown must NOT be cleared, or polling
    // re-arms against the still-rate-limited token before its reset.
    const db = setupDb();
    const store = new MemoryCredentialStore();
    await store.set('neokai.external-events.github', 'default', 'ghp_A');
    let getCalls = 0;
    const flakyStore = {
      get: async (service: string, account: string) => {
        getCalls++;
        // Reads #1 (resolveToken) and #2 (getTokenStatus) succeed; the final
        // resolveTokenOrFail read (#3) throws.
        if (getCalls >= 3) throw new Error('keychain locked');
        return store.get(service, account);
      },
      set: (service: string, account: string, data: string) => store.set(service, account, data),
      delete: (service: string, account: string) => store.delete(service, account),
      listServices: () => store.listServices(),
    };
    const extension = new GitHubEventExtension(db, undefined, {
      credentialStore: flakyStore,
      fetchImpl: fakeUserFetch('octocat'),
    });
    const ext = extension as unknown as {
      rateLimitedUntil: number;
      lastRateLimitFingerprint?: string;
    };
    ext.rateLimitedUntil = Date.now() + 3_600_000;
    ext.lastRateLimitFingerprint = fp('ghp_A');

    const clientHub = await setupHub(extension, new HealthConfigStore());
    await clientHub.request<GitHubHealthSnapshot>('space.github.health', { spaceId: 'space-1' });
    // Cooldown preserved — the failed read is not treated as an authoritative rotation.
    expect(ext.rateLimitedUntil).toBeGreaterThan(0);
    await extension.stop();
  });

  test('a silent rotation after validation marks stale access evidence unverified', async () => {
    // resolveTokenStatus validates token A; then a config read silently rotates
    // the keychain to B before buildHealthSnapshot's final credential read. The
    // validated fingerprint is A's while B is effective — the rollup must not
    // trust A's persisted lastPollAt as access proof for B, so the repo reads as
    // never-polled under the (unverified) current credential.
    const db = setupDb();
    const credentialStore = new MemoryCredentialStore();
    await credentialStore.set('neokai.external-events.github', 'default', 'ghp_A');
    // Rotating config: flips the keychain A→B on the THIRD getGlobalConfig call.
    // Calls 1 (extension.start's isPollingGloballyEnabled) and 2 (the health
    // RPC's assertRpcConfigEnabled) fire BEFORE buildHealthSnapshot; call 3 is
    // buildHealthSnapshot's isPollingGloballyEnabled, which runs AFTER
    // resolveTokenStatus validated A. Rotating there lands the silent rotation
    // between validation and the snapshot's final credential read.
    let getGlobalConfigCalls = 0;
    let rotated = false;
    const rotatingConfig: ExternalEventExtensionConfigStore = {
      async getGlobalConfig(source: string) {
        getGlobalConfigCalls++;
        if (!rotated && getGlobalConfigCalls >= 3) {
          rotated = true;
          await credentialStore.set('neokai.external-events.github', 'default', 'ghp_B');
        }
        return {
          source,
          globallyEnabled: true,
          capabilities: { webhooks: true, polling: true, rpcConfig: true },
          settings: {},
        };
      },
      async getSpaceConfig(spaceId: string, source: string) {
        return { spaceId, source, enabled: true, settings: {} };
      },
      async listEnabledSpaces() {
        return [];
      },
      async setGlobalConfig() {},
      async setSpaceConfig() {},
    };
    const extension = new GitHubEventExtension(db, undefined, {
      credentialStore,
      fetchImpl: fakeUserFetch('octocat'),
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    const repo = extension.repo.listPollingRepos('space-1')[0];
    // A successful poll recorded under A's fingerprint (also sets lastPollAt).
    extension.repo.updatePollCursor(repo.id, { lastPollCredentialFingerprint: fp('ghp_A') });

    const clientHub = await setupHub(extension, rotatingConfig);
    const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
      spaceId: 'space-1',
    });
    // A's lastPollAt is not trusted for the now-effective B → never polled.
    expect(snapshot.polling.neverPolledRepoCount).toBe(1);
    await extension.stop();
  });

  test('pollOnce (global) counts errors only for repos the cycle attempts', async () => {
    // A disabled repo that still carries a persisted poll error must NOT be
    // counted: pollEnabledSpaces skips disabled rows (listPollingRepos), so the
    // result must use the same enabled set, not listAllPollingConfiguredRepos.
    // seedSpace is required so listAllPollingConfiguredRepos's JOIN on `spaces`
    // includes the disabled repo — without it the buggy query also returns
    // empty and the assertion cannot distinguish fixed from buggy code.
    const db = setupDb();
    seedSpace(db, 'space-1');
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'live',
      pollingEnabled: true,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'dead',
      enabled: false,
      pollingEnabled: true,
    });
    const dead = extension.repo.listWatchedRepos('space-1').find((r) => r.repo === 'dead');
    expect(dead).toBeTruthy();
    extension.repo.recordPollFailure(dead!.id, 'HTTP 404', false);

    const clientHub = await setupHub(extension, new HealthConfigStore());
    const result = await clientHub.request<{ count: number; errors?: number }>(
      'space.github.pollOnce',
      {}
    );
    // No errors surfaced from the disabled repo the cycle never attempted.
    expect(result.errors).toBeUndefined();
    await extension.stop();
  });

  test('a verified delivery clears a prior "update uncertain" webhook error', () => {
    // A PATCH that timed out leaves the secret uncertain (a GET cannot read
    // GitHub's stored secret). A later delivery whose signature verifies proves
    // GitHub is still signing with this row's secret, resolving the uncertainty —
    // so markWebhookReceived clears it, instead of degrading the panel forever.
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
    });
    extension.repo.updateWebhookStatus(repo.id, {
      active: true,
      lastError: 'webhook update uncertain: timeout',
    });
    expect(extension.repo.getWatchedRepoById(repo.id)?.webhookLastError).toContain(
      'update uncertain'
    );
    extension.repo.markWebhookReceived(repo.id);
    expect(extension.repo.getWatchedRepoById(repo.id)?.webhookLastError).toBeNull();
  });

  test('a verified delivery preserves a configuration error (webhook_active = 0)', () => {
    // A delivery does not prove the hook emits every event type, so a persistent
    // configuration error (recorded alongside webhook_active = 0) is kept.
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
    });
    extension.repo.updateWebhookStatus(repo.id, { active: false, lastError: 'missing events' });
    extension.repo.markWebhookReceived(repo.id);
    expect(extension.repo.getWatchedRepoById(repo.id)?.webhookLastError).toBe('missing events');
  });

  test('clearWebhookRegistration clears the stale delivery timestamp', () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
    });
    extension.repo.markWebhookReceived(repo.id);
    expect(extension.repo.getWatchedRepoById(repo.id)?.lastWebhookAt).not.toBeNull();
    // Secret rotation / disabling clears the remote hook; the delivery history
    // from the deleted hook must not survive as a false live path.
    extension.repo.clearWebhookRegistration(repo.id, {});
    expect(extension.repo.getWatchedRepoById(repo.id)?.lastWebhookAt).toBeNull();
  });

  test('scheduled polling runs multiple cycles and clears activePollCycle between them', async () => {
    // Regression guard: the scheduled timer callback must not overwrite
    // activePollCycle (managed by runExclusivePoll), or the overlap guard
    // reschedules forever and polling dies after the first cycle.
    let repoFetches = 0;
    const countingFetch = (async (url: string | URL | Request) => {
      const path = typeof url === 'string' ? url : url.toString();
      if (path.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
      }
      repoFetches++;
      return new Response('[]', { status: 200 });
    }) as typeof fetch;
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      pollIntervalMs: 1000,
      fetchImpl: countingFetch,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });

    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      // Confirm the poll path works and the timer was armed on start.
      await clientHub.request('space.github.pollOnce', { spaceId: 'space-1' });
      const manualFetches = repoFetches;
      const armedExt = extension as unknown as { pollTimer: unknown };
      // The scheduled timer fires at the 1s floor. Wait for at least two
      // scheduled cycles — with the regression, only the first cycle ever runs.
      const deadline = Date.now() + 6000;
      while (repoFetches < manualFetches + 4 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // Manual poll path works, and the scheduled timer armed on start.
      expect(manualFetches).toBeGreaterThan(0);
      expect(armedExt.pollTimer).not.toBeNull();
      // ≥2 scheduled cycles ran (regression: only one ever runs).
      expect(repoFetches).toBeGreaterThanOrEqual(manualFetches + 4);
      // activePollCycle must return to undefined between cycles (not stuck).
      const ext = extension as unknown as { activePollCycle?: Promise<void> };
      let cleared = false;
      for (let i = 0; i < 30; i++) {
        if (ext.activePollCycle === undefined) {
          cleared = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(cleared).toBe(true);
    } finally {
      await extension.stop();
    }
  }, 15000);

  // autoConfigureWebhook's webhook remote calls use this.githubFetch (not
  // options.fetchImpl), so the polling-preservation one-liner
  // (pollingEnabled: existing?.pollingEnabled ?? false) is verified via the
  // upsert path rather than an RPC integration test here.

  test('a rate-limited /user 403 is not treated as a rejected credential', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: (async (url: string | URL | Request) => {
        const path = typeof url === 'string' ? url : url.toString();
        if (path.endsWith('/user')) {
          // GitHub primary rate limit: 403 with remaining: 0.
          return new Response(JSON.stringify({ message: 'rate limit exceeded' }), {
            status: 403,
            headers: {
              'X-RateLimit-Remaining': '0',
              'X-RateLimit-Reset': String(Math.floor((Date.now() + 60_000) / 1000)),
            },
          });
        }
        return new Response('[]', { status: 200 });
      }) as typeof fetch,
    });
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(snapshot.token.error).toBeTruthy();
      expect(snapshot.token.authRejected).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('a headerless secondary-rate-limit /user 403 is not treated as rejected', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: (async (url: string | URL | Request) => {
        const path = typeof url === 'string' ? url : url.toString();
        if (path.endsWith('/user')) {
          // Secondary/abuse limit: 403 with a rate-limit body but NO headers.
          return new Response(
            JSON.stringify({ message: 'You have exceeded a secondary rate limit' }),
            { status: 403 }
          );
        }
        return new Response('[]', { status: 200 });
      }) as typeof fetch,
    });
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(snapshot.token.error).toContain('rate limited');
      expect(snapshot.token.authRejected).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('a polling repo with tracked PRs but no reaction activity counts as stale', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      pollIntervalMs: 90_000,
      fetchImpl: fakeUserFetch('octocat'),
    });
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    // Tracked PRs but lastReactionPollAt never set (reactions never succeeded).
    extension.repo.updatePollCursor(repo.id, { recentPullRequestNumbers: [7] });

    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(snapshot.reactions.trackedPullRequests).toBe(1);
      expect(snapshot.reactions.staleRepoCount).toBe(1);
    } finally {
      await extension.stop();
    }
  });

  test('a fresh reaction repo does not mask another repo whose reactions are stale', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      pollIntervalMs: 90_000,
      fetchImpl: fakeUserFetch('octocat'),
    });
    // Repo A: tracked PRs with FRESH reaction activity (within the window).
    const repoA = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'fresh',
      pollingEnabled: true,
    });
    extension.repo.updatePollCursor(repoA.id, {
      recentPullRequestNumbers: [1],
      lastReactionPollAt: Date.now() - 60_000,
    });
    // Repo B: tracked PRs but reactions never succeeded (stale / null).
    const repoB = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'stale',
      pollingEnabled: true,
    });
    extension.repo.updatePollCursor(repoB.id, { recentPullRequestNumbers: [2] });

    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      // Aggregate freshness reflects the fresh repo, but the per-repo count is
      // NOT masked — only the stale repo contributes.
      expect(snapshot.reactions.lastActivityAt).not.toBeNull();
      expect(snapshot.reactions.staleRepoCount).toBe(1);
    } finally {
      await extension.stop();
    }
  });

  test('setToken clears stale per-repo poll errors from the old credential', async () => {
    const db = setupDb();
    const credentialStore = new MemoryCredentialStore();
    const extension = new GitHubEventExtension(db, undefined, {
      credentialStore,
      fetchImpl: fakeUserFetch('octocat'),
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    // Simulate the old credential's access failure persisted on the cursor.
    extension.repo.updatePollCursor(extension.repo.listPollingRepos('space-1')[0].id, {
      recentPullRequestNumbers: [],
      lastPollError: 'Resource not accessible',
      lastPartialPollError: 'check-runs HTTP 403',
    });

    const clientHub = await setupHub(extension, new HealthConfigStore());
    await clientHub.request('space.github.setToken', { token: 'ghp_newcredential' });

    const repo = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets');
    expect(repo?.pollCursor?.lastPollError).toBeNull();
    expect(repo?.pollCursor?.lastPartialPollError).toBeNull();
    await extension.stop();
  });

  test('an in-flight poll does not commit its errors after the credential changes mid-fetch', async () => {
    // The cursor-commit guard: pollWatchedRepo captures the generation at entry;
    // if the credential rotates while the fetch is in flight (setToken/clearToken
    // bumped the generation), the obsolete cycle must not write its access
    // failure back over the values resetRateLimitObservation cleared.
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      pollIntervalMs: 60_000,
      fetchImpl: fakeUserFetch('octocat'),
    });
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });

    // A fetch that rotates the credential on the first repo-endpoint call, then
    // returns a permission 403 (the old token's access failure).
    const rotateAndDenyFetch = (async (url: string | URL | Request) => {
      const path = typeof url === 'string' ? url : url.toString();
      if (path.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
      }
      (
        extension as unknown as { resetRateLimitObservation: () => void }
      ).resetRateLimitObservation();
      return new Response(JSON.stringify({ message: 'Resource not accessible' }), {
        status: 403,
        headers: { 'X-RateLimit-Remaining': '4999' },
      });
    }) as typeof fetch;

    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      await extension.pollWatchedRepo(
        extension.repo.listPollingRepos('space-1')[0],
        rotateAndDenyFetch
      );
      void clientHub;
      const watched = extension.repo.getWatchedRepoById(repo.id);
      // Without the guard these would be 'Resource not accessible…'; with it,
      // the stale cycle forces null so the new credential re-discovers any
      // persistent error on its own poll.
      expect(watched?.pollCursor?.lastPollError).toBeNull();
      expect(watched?.pollCursor?.lastPartialPollError).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('a successful /user validation with a normal budget persists the rate-limit observation', async () => {
    const db = setupDb();
    // /user succeeds with a healthy remaining budget and no repos polled yet.
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: (async (url: string | URL | Request) => {
        const path = typeof url === 'string' ? url : url.toString();
        if (path.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'octocat' }), {
            status: 200,
            headers: {
              'X-RateLimit-Remaining': '4999',
              'X-RateLimit-Reset': String(Math.floor((Date.now() + 3_600_000) / 1000)),
            },
          });
        }
        return new Response('[]', { status: 200 });
      }) as typeof fetch,
    });
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      // The validation's quota is reflected immediately (not "Unknown / no poll
      // yet)"), and no cooldown was applied because the budget was healthy.
      expect(snapshot.rateLimit.remaining).toBe(4999);
      expect(snapshot.rateLimit.limited).toBe(false);
      expect(snapshot.rateLimit.observedAt).toBeGreaterThan(0);
    } finally {
      await extension.stop();
    }
  });

  test('a credential change during the keychain read rejects the stale validation', async () => {
    const db = setupDb();
    // A credential store whose async read completes AFTER setToken landed
    // (bumping the generation mid-read), returning the stale token A.
    const extensionHolder: { reset?: () => void } = {};
    const rotatingStore = {
      async get(): Promise<string | null> {
        extensionHolder.reset?.();
        return 'ghp_A';
      },
      async set(): Promise<void> {},
      async delete(): Promise<void> {},
      async listServices(): Promise<string[]> {
        return [];
      },
    };
    let userPolled = false;
    const extension = new GitHubEventExtension(db, undefined, {
      credentialStore: rotatingStore as unknown as MemoryCredentialStore,
      fetchImpl: (async (url: string | URL | Request) => {
        const path = typeof url === 'string' ? url : url.toString();
        if (path.endsWith('/user')) {
          userPolled = true;
          // A rate limit for the stale token — must NOT be applied to token B.
          return new Response(JSON.stringify({ message: 'rate limit exceeded' }), {
            status: 403,
            headers: { 'X-RateLimit-Remaining': '0' },
          });
        }
        return new Response('[]', { status: 200 });
      }) as typeof fetch,
    });
    extensionHolder.reset = () =>
      (
        extension as unknown as { resetRateLimitObservation: () => void }
      ).resetRateLimitObservation();
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      // The stale token's validation was rejected before /user ran, so its
      // rate limit is not applied to the current credential.
      expect(snapshot.token.error).toBe('credential changed during validation');
      expect(snapshot.token.authRejected).toBeFalsy();
      expect(userPolled).toBe(false);
      expect(snapshot.rateLimit.limited).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('a poll cycle that throws after its fetches resolves records a partial error', async () => {
    const db = setupDb();
    // Endpoints return 200 (so the repo is reachable) but a malformed JSON body:
    // response.json() rejects after the fetch resolved, escaping the cursor
    // commit so lastPollAt never advances and no error is recorded without the
    // wrapper guard.
    const malformedFetch = (async (url: string | URL | Request) => {
      const path = typeof url === 'string' ? url : url.toString();
      if (path.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
      }
      return new Response('not-json', { status: 200 });
    }) as typeof fetch;
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      pollIntervalMs: 60_000,
      fetchImpl: malformedFetch,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      await expect(
        extension.pollWatchedRepo(extension.repo.listPollingRepos('space-1')[0], malformedFetch)
      ).rejects.toThrow();
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      // The post-fetch failure is recorded as a partial error (Degraded), not
      // silently Healthy with a null lastPollAt.
      expect(snapshot.polling.partialErrorRepoCount).toBe(1);
      expect(snapshot.repositories[0].lastPartialPollError).toBeTruthy();
    } finally {
      await extension.stop();
    }
  });

  test('a manual webhook secret rotation clears the stale delivery timestamp', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    // A manually-configured repo (not auto-registered) with a prior delivery
    // under the old secret.
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
      webhookSecret: 'old-secret',
    });
    extension.repo.markWebhookReceived(repo.id);
    expect(extension.repo.getWatchedRepoById(repo.id)?.lastWebhookAt).not.toBeNull();
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      // Re-add the same manual repo with a DIFFERENT secret.
      await clientHub.request('space.github.watchRepo', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        webhookEnabled: true,
        webhookSecret: 'new-secret',
      });
      const watched = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets');
      // The new secret is stored, but the delivery under the old secret is
      // cleared — it must not keep the webhook path live.
      expect(watched?.webhookSecret).toBe('new-secret');
      expect(watched?.lastWebhookAt).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('a lightweight health refresh reuses the cached token status without re-validating', async () => {
    const db = setupDb();
    let userCalls = 0;
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: (async (url: string | URL | Request) => {
        const path = typeof url === 'string' ? url : url.toString();
        if (path.endsWith('/user')) {
          userCalls += 1;
          return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      }) as typeof fetch,
    });
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      // A full request validates the token (/user).
      await clientHub.request('space.github.health', { spaceId: 'space-1' });
      expect(userCalls).toBe(1);
      // A lightweight request reuses the cached status — no additional /user.
      await clientHub.request('space.github.health', { spaceId: 'space-1', lightweight: true });
      expect(userCalls).toBe(1);
      // A later full request re-validates and refreshes the cache.
      await clientHub.request('space.github.health', { spaceId: 'space-1' });
      expect(userCalls).toBe(2);
      // The next lightweight request reuses the refreshed cache again.
      await clientHub.request('space.github.health', { spaceId: 'space-1', lightweight: true });
      expect(userCalls).toBe(2);
    } finally {
      await extension.stop();
    }
  });

  test('a credential rotation during /user does not cache the stale validation', async () => {
    const db = setupDb();
    let userCalls = 0;
    const extension = new GitHubEventExtension(db, 'ghp_A', {
      fetchImpl: (async (url: string | URL | Request) => {
        const path = typeof url === 'string' ? url : url.toString();
        if (path.endsWith('/user')) {
          userCalls += 1;
          if (userCalls === 1) {
            // setToken(B) lands during the in-flight /user for A; A is rejected.
            (
              extension as unknown as { resetRateLimitObservation: () => void }
            ).resetRateLimitObservation();
            return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
          }
          return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      }) as typeof fetch,
    });
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      // Full request: A's /user rotates the credential mid-fetch; the stale 401
      // must not be returned as the current credential's rejection.
      const first = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(first.token.error).toBe('credential changed during validation');
      expect(first.token.authRejected).toBeFalsy();
      // A lightweight refresh re-validates — the stale rejection was not cached
      // for the new credential.
      const second = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
        lightweight: true,
      });
      expect(second.token.error).toBeFalsy();
      expect(second.token.login).toBe('octocat');
    } finally {
      await extension.stop();
    }
  });

  test('a rate limit before any successful access does not advance lastPollAt', async () => {
    const db = setupDb();
    // Every repo endpoint rate-limits (403 with remaining: 0) before any 200/304,
    // so the cycle never marks the repo accessible.
    const rateLimitedFetch = (async (url: string | URL | Request) => {
      const path = typeof url === 'string' ? url : url.toString();
      if (path.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'rate limit exceeded' }), {
        status: 403,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.floor((Date.now() + 60_000) / 1000)),
        },
      });
    }) as typeof fetch;
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      pollIntervalMs: 60_000,
      fetchImpl: rateLimitedFetch,
    });
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      await extension.pollWatchedRepo(
        extension.repo.listPollingRepos('space-1')[0],
        rateLimitedFetch
      );
      void clientHub;
      const watched = extension.repo.getWatchedRepoById(repo.id);
      // No endpoint ever succeeded (accessible=false); lastPollAt must not have
      // advanced, so the repo is not falsely badged freshly polled.
      expect(watched?.lastPollAt).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('a pre-access rate limit preserves an unresolved prior partial error', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      pollIntervalMs: 60_000,
      fetchImpl: fakeUserFetch('octocat'),
    });
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    // A prior, still-unresolved partial error from an earlier cycle.
    extension.repo.updatePollCursor(repo.id, { lastPartialPollError: 'pulls HTTP 403' });
    // Next cycle rate-limits before any 200/304 (accessible=false, no new error).
    const rateLimitedFetch = (async (url: string | URL | Request) => {
      const path = typeof url === 'string' ? url : url.toString();
      if (path.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'rate limit exceeded' }), {
        status: 403,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.floor((Date.now() + 60_000) / 1000)),
        },
      });
    }) as typeof fetch;
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      await extension.pollWatchedRepo(
        extension.repo.listPollingRepos('space-1')[0],
        rateLimitedFetch
      );
      void clientHub;
      const watched = extension.repo.getWatchedRepoById(repo.id);
      // Recovery is unproven — the prior partial error must survive, not be
      // cleared just because this cycle rate-limited before trying.
      expect(watched?.pollCursor?.lastPartialPollError).toBe('pulls HTTP 403');
    } finally {
      await extension.stop();
    }
  });

  test('an accessible-but-incomplete cycle preserves an unresolved prior partial error', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      pollIntervalMs: 60_000,
      fetchImpl: fakeUserFetch('octocat'),
    });
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    extension.repo.updatePollCursor(repo.id, { lastPartialPollError: 'pulls HTTP 403' });
    // issue_comments succeeds (accessible=true), then review_comments rate-limits
    // (partialScan=true, break) before the failed /pulls endpoint is retried.
    const partialThenLimitedFetch = (async (url: string | URL | Request) => {
      const path = typeof url === 'string' ? url : url.toString();
      if (path.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
      }
      if (path.endsWith('/issues/comments')) return new Response('[]', { status: 200 });
      return new Response(JSON.stringify({ message: 'rate limit exceeded' }), {
        status: 403,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.floor((Date.now() + 60_000) / 1000)),
        },
      });
    }) as typeof fetch;
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      await extension.pollWatchedRepo(
        extension.repo.listPollingRepos('space-1')[0],
        partialThenLimitedFetch
      );
      void clientHub;
      const watched = extension.repo.getWatchedRepoById(repo.id);
      // The cycle did not retry /pulls, so the prior partial error is unresolved
      // and must survive (not be cleared just because one endpoint succeeded).
      expect(watched?.pollCursor?.lastPartialPollError).toBe('pulls HTTP 403');
    } finally {
      await extension.stop();
    }
  });

  test('a stale polling repo is counted per-repo and not masked by a fresh one', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      pollIntervalMs: 90_000,
      fetchImpl: fakeUserFetch('octocat'),
    });
    const repoA = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'fresh',
      pollingEnabled: true,
    });
    const repoB = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'stale',
      pollingEnabled: true,
    });
    // Repo A polled just now; repo B polled 10h ago (past the staleness window).
    extension.repo.updatePollCursor(repoA.id, { lastPollCredentialFingerprint: fp('ghp_token') });
    extension.repo.updatePollCursorJson(repoB.id, {
      lastPollCredentialFingerprint: fp('ghp_token'),
    });
    db.prepare('UPDATE space_github_watched_repos SET last_poll_at = ? WHERE id = ?').run(
      Date.now() - 10 * 60 * 60 * 1000,
      repoB.id
    );
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(snapshot.polling.stalePollingRepoCount).toBe(1);
      expect(snapshot.polling.neverPolledRepoCount).toBe(0);
    } finally {
      await extension.stop();
    }
  });

  test('a replaced token does not inherit the prior credential repo access', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, {
      credentialStore: new MemoryCredentialStore(),
      pollIntervalMs: 60_000,
      fetchImpl: (async (url: string | URL | Request) => {
        const path = typeof url === 'string' ? url : url.toString();
        if (path.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      }) as typeof fetch,
    });
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      // Establish a successful poll under the current credential, then rotate
      // the token. The old credential's lastPollAt must not prove access for the
      // new (unconfirmed) credential.
      await extension.pollWatchedRepo(extension.repo.listPollingRepos('space-1')[0], (async (
        url: string | URL | Request
      ) => {
        const path = typeof url === 'string' ? url : url.toString();
        if (path.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      }) as typeof fetch);
      await clientHub.request('space.github.setToken', { token: 'ghp_newcredential' });

      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      // The repo's prior poll was under the old credential; the new credential
      // has not re-confirmed access, so it counts as not-yet-polled (not live).
      expect(snapshot.polling.neverPolledRepoCount).toBe(1);
      expect(snapshot.polling.lastPollAt).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('an exhausted rate-limit observation expires after its reset window', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const ext = extension as unknown as {
      lastRateLimitInfo?: {
        remaining: number;
        resetAt: number;
        limited: boolean;
        retryAfter: boolean;
      };
      lastRateLimitObservedAt: number;
    };
    // A finite observation whose reset epoch is already in the past.
    ext.lastRateLimitInfo = {
      remaining: 0,
      resetAt: Date.now() - 60_000,
      limited: true,
      retryAfter: false,
    };
    ext.lastRateLimitObservedAt = Date.now() - 120_000;
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      // The stale exhausted-quota observation is dropped (no fresh observation),
      // so remaining is unknown rather than a misleading zero.
      expect(snapshot.rateLimit.remaining).toBeNull();
      expect(ext.lastRateLimitInfo).toBeUndefined();
    } finally {
      await extension.stop();
    }
  });

  test('a successful webhook delivery supersedes a transient check error', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
    });
    // A prior transient check error.
    extension.repo.updateWebhookStatus(repo.id, {
      lastCheckedAt: Date.now(),
      lastError: 'check timed out',
    });
    expect(extension.repo.getWatchedRepoById(repo.id)?.webhookLastError).toBe('check timed out');
    // A correctly signed delivery lands — it proves the hook works.
    extension.repo.markWebhookReceived(repo.id);
    expect(extension.repo.getWatchedRepoById(repo.id)?.webhookLastError).toBeNull();
    await extension.stop();
  });

  test('a lightweight refresh revalidates after the token-status cache expires', async () => {
    const db = setupDb();
    let userCalls = 0;
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: (async (url: string | URL | Request) => {
        const path = typeof url === 'string' ? url : url.toString();
        if (path.endsWith('/user')) {
          userCalls += 1;
          return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      }) as typeof fetch,
    });
    const ext = extension as unknown as { lastTokenStatusAt: number };
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      // Prime the cache with a full request.
      await clientHub.request('space.github.health', { spaceId: 'space-1' });
      expect(userCalls).toBe(1);
      // Lightweight within the TTL reuses the cache (no extra /user).
      await clientHub.request('space.github.health', { spaceId: 'space-1', lightweight: true });
      expect(userCalls).toBe(1);
      // Once the cache expires, a lightweight refresh revalidates (catches a
      // remotely-revoked PAT rather than serving it forever).
      ext.lastTokenStatusAt = Date.now() - 10 * 60 * 1000;
      await clientHub.request('space.github.health', { spaceId: 'space-1', lightweight: true });
      expect(userCalls).toBe(2);
    } finally {
      await extension.stop();
    }
  });

  test('a delivery preserves a persistent configuration webhook error', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
    });
    // A persistent config error (validateRemoteHook) is recorded with active=false.
    extension.repo.updateWebhookStatus(repo.id, {
      active: false,
      lastCheckedAt: Date.now(),
      lastError: 'GitHub webhook is missing required events',
    });
    // A correctly signed delivery lands, but the hook is still misconfigured.
    extension.repo.markWebhookReceived(repo.id);
    expect(extension.repo.getWatchedRepoById(repo.id)?.webhookLastError).toBe(
      'GitHub webhook is missing required events'
    );
    await extension.stop();
  });

  test('an incomplete accessible cycle records a diagnostic when there was no prior partial error', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      pollIntervalMs: 60_000,
      fetchImpl: fakeUserFetch('octocat'),
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    // issue_comments succeeds (accessible=true), then review_comments rate-limits
    // (partialScan=true, break) — no prior partial error, no new error.
    const incompleteFetch = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
      }
      if (path.endsWith('/issues/comments')) return new Response('[]', { status: 200 });
      return new Response(JSON.stringify({ message: 'rate limit exceeded' }), {
        status: 403,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.floor((Date.now() + 60_000) / 1000)),
        },
      });
    }) as typeof fetch;
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      await extension.pollWatchedRepo(
        extension.repo.listPollingRepos('space-1')[0],
        incompleteFetch
      );
      void clientHub;
      const watched = extension.repo.listPollingRepos('space-1')[0];
      // No prior error existed, but the cycle was incomplete — a diagnostic is
      // recorded so the rollup degrades instead of badging Healthy.
      expect(watched?.pollCursor?.lastPartialPollError).toContain('incomplete');
    } finally {
      await extension.stop();
    }
  });

  test('recentErrorTotal reports the true count beyond the 5-row display cap', async () => {
    const db = setupDb();
    seedSpace(db, 'space-1');
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const store = new ExternalEventStore(db);
    for (let i = 0; i < 7; i++) {
      const ev = store.store(buildEvent('space-1', `fail-${i}`));
      store.registerExpectedDelivery(ev.event.id, `delivery-${i}`, {
        workflowRunId: 'run-1',
        taskId: 'task-1',
        nodeId: 'node-1',
        agentName: 'coder',
      });
      store.markDeliveryFailed(ev.event.id, `delivery-${i}`, {
        terminal: true,
        reason: 'boom',
      });
    }
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      // The display list is capped at 5, but the total reflects all 7 failures.
      expect(snapshot.recentErrors).toHaveLength(5);
      expect(snapshot.recentErrorTotal).toBe(7);
    } finally {
      await extension.stop();
    }
  });

  test('a credential fingerprint survives a daemon restart with the same token', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      pollIntervalMs: 60_000,
      fetchImpl: fakeUserFetch('octocat'),
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    try {
      // First instance: poll under the current token (stamps the fingerprint).
      await setupHub(extension, new HealthConfigStore());
      await extension.pollWatchedRepo(
        extension.repo.listPollingRepos('space-1')[0],
        fakeUserFetch('octocat')
      );
      await extension.stop();

      // Second instance (same DB, same token): simulates a restart. The
      // fingerprint persisted by the first instance should still match.
      const extension2 = new GitHubEventExtension(db, 'ghp_token', {
        pollIntervalMs: 60_000,
        fetchImpl: fakeUserFetch('octocat'),
      });
      const clientHub = await setupHub(extension2, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      // The same token's fingerprint survives restart → access still verified.
      expect(snapshot.polling.neverPolledRepoCount).toBe(0);
      expect(snapshot.polling.lastPollAt).not.toBeNull();
      await extension2.stop();
    } finally {
      // Best-effort cleanup.
    }
  });

  test('a cursor without a credential fingerprint reads as unverified', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      pollIntervalMs: 60_000,
      fetchImpl: fakeUserFetch('octocat'),
    });
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    // Seed lastPollAt WITHOUT a fingerprint (simulates a legacy cursor or a
    // manual seed). The rollup must treat it as unverified (neverPolled),
    // not accept the timestamp as proof of access.
    extension.repo.updatePollCursor(repo.id, {});
    // Wipe the fingerprint that updatePollCursor might have left (it doesn't
    // set one — only pollWatchedRepo does), confirming the cursor has none.
    const watched = extension.repo.getWatchedRepoById(repo.id);
    expect(watched?.pollCursor?.lastPollCredentialFingerprint).toBeUndefined();
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(snapshot.polling.neverPolledRepoCount).toBe(1);
      expect(snapshot.polling.lastPollAt).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('a rate-limited 403 from /user is NOT cached (transient)', async () => {
    const db = setupDb();
    let userCalls = 0;
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: (async (url: string | URL | Request) => {
        const path = typeof url === 'string' ? url : url.toString();
        if (path.endsWith('/user')) {
          userCalls += 1;
          return new Response(JSON.stringify({ message: 'rate limit exceeded' }), {
            status: 403,
            headers: {
              'X-RateLimit-Remaining': '0',
              'X-RateLimit-Reset': String(Math.floor((Date.now() + 60_000) / 1000)),
            },
          });
        }
        return new Response('[]', { status: 200 });
      }) as typeof fetch,
    });
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      await clientHub.request('space.github.health', { spaceId: 'space-1' });
      expect(userCalls).toBe(1);
      // A lightweight refresh within the TTL MUST re-validate — the rate-limited
      // 403 is transient and must not be served from cache.
      await clientHub.request('space.github.health', { spaceId: 'space-1', lightweight: true });
      expect(userCalls).toBe(2);
    } finally {
      await extension.stop();
    }
  });

  test('a permission-only 403 from /user IS cached (stable)', async () => {
    const db = setupDb();
    let userCalls = 0;
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: (async (url: string | URL | Request) => {
        const path = typeof url === 'string' ? url : url.toString();
        if (path.endsWith('/user')) {
          userCalls += 1;
          // Non-rate-limited 403: installation token rejected by /user.
          return new Response(JSON.stringify({ message: 'Resource not accessible' }), {
            status: 403,
          });
        }
        return new Response('[]', { status: 200 });
      }) as typeof fetch,
    });
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      await clientHub.request('space.github.health', { spaceId: 'space-1' });
      expect(userCalls).toBe(1);
      // A lightweight refresh within the TTL reuses the cached permission-403 —
      // it's stable (same token → same 403), so re-validating wastes API budget.
      await clientHub.request('space.github.health', { spaceId: 'space-1', lightweight: true });
      expect(userCalls).toBe(1);
    } finally {
      await extension.stop();
    }
  });

  test('exhausted fingerprint retries mark repos as unverified', async () => {
    const db = setupDb();
    let tokenCall = 0;
    const extension = new GitHubEventExtension(db, 'ghp_A', {
      pollIntervalMs: 60_000,
      fetchImpl: (async (url: string | URL | Request) => {
        const path = typeof url === 'string' ? url : url.toString();
        if (path.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      }) as typeof fetch,
    });
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    // Seed a successful poll under token B.
    extension.repo.updatePollCursor(repo.id, {
      lastSeenAt: 0,
      lastPollCredentialFingerprint: fp('ghp_B'),
    });
    // Override resolveToken to bump credentialGeneration on each call (churning)
    // while returning a CONSTANT token (ghp_B). The generation churn drives the
    // retry loop/sentinel; without the sentinel, the fingerprint would match
    // ghp_B and the repo would read verified. With the sentinel, the exhausted
    // retry path overrides to an unmatchable fingerprint.
    (extension as unknown as { resolveToken: () => Promise<string | null> }).resolveToken =
      async () => {
        tokenCall += 1;
        (extension as unknown as { credentialGeneration: number }).credentialGeneration += 1;
        return 'ghp_B';
      };
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      // The credential kept changing across all 3 retries — the sentinel fires
      // and the repo reads as unverified (neverPolled), not trusted.
      expect(snapshot.polling.neverPolledRepoCount).toBe(1);
      expect(snapshot.polling.lastPollAt).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('validatedFingerprint overrides the pre-validation read for access-scoping', async () => {
    const db = setupDb();
    // The keychain changes WITHOUT a setToken/clearToken (credentialGeneration
    // doesn't bump). The pre-validation resolveToken returns the OLD token, but
    // getTokenStatus's internal resolveToken reads the NEW one from the store.
    // The validatedFingerprint binding must override the stale pre-read.
    const store = new MemoryCredentialStore();
    await store.set('neokai.external-events.github', 'default', 'ghp_NEW');
    const extension = new GitHubEventExtension(db, undefined, {
      credentialStore: store,
      pollIntervalMs: 60_000,
      fetchImpl: (async (url: string | URL | Request) => {
        const path = typeof url === 'string' ? url : url.toString();
        if (path.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      }) as typeof fetch,
    });
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    // Seed a poll under the OLD token's fingerprint.
    extension.repo.updatePollCursor(repo.id, {
      lastSeenAt: 0,
      lastPollCredentialFingerprint: fp('ghp_OLD'),
    });
    // Override resolveToken to return the OLD token (simulating a stale read
    // before the keychain change is visible to it), while getTokenStatus's
    // internal resolveToken reads ghp_NEW from the store.
    (extension as unknown as { resolveToken: () => Promise<string | null> }).resolveToken =
      async () => 'ghp_OLD';
    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      // Without the validatedFingerprint binding, the pre-read (fp('ghp_OLD'))
      // matches the repo's seeded fingerprint → verified → Healthy. With it,
      // getTokenStatus validated ghp_NEW → fp('ghp_NEW') overrides → unverified.
      expect(snapshot.polling.neverPolledRepoCount).toBe(1);
      expect(snapshot.polling.lastPollAt).toBeNull();
    } finally {
      await extension.stop();
    }
  });
});
