import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
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

function fakeUserFetch(login: string): typeof fetch {
  return (async (url: string | URL | Request) => {
    const path = typeof url === 'string' ? url : url.toString();
    if (path.endsWith('/user')) {
      return new Response(JSON.stringify({ login }), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
}

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

    const repoA = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
      webhookActive: true,
      webhookLastCheckedAt: 1_700_000_002_000,
    });
    extension.repo.markWebhookReceived(repoA.id);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'gadgets',
      webhookEnabled: true,
      webhookActive: false,
      webhookLastError: 'GitHub webhook is disabled',
      webhookLastCheckedAt: 1_700_000_003_000,
    });
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
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'enabled-repo',
      webhookEnabled: true,
      webhookActive: true,
    });
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

  test('eventTypes rolls up recent ingestion counts per merge-blocking path', async () => {
    const db = setupDb();
    seedSpace(db, 'space-1');
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const store = new ExternalEventStore(db);
    const now = Date.now();
    const seed = (topic: string, id: string, occurredAt = now) =>
      store.store({
        id,
        spaceId: 'space-1',
        source: 'github',
        topic,
        occurredAt,
        ingestedAt: occurredAt,
        summary: topic,
        dedupeKey: `github:${id}`,
        payload: {},
      });

    seed('github/acme/widgets/pull_request/42.status_failure', 's1');
    seed('github/acme/widgets/pull_request/42.status_success', 's2', now - 60_000);
    seed('github/acme/widgets/pull_request/42.thread_resolved', 't1');
    seed('github/acme/widgets/pull_request/42.deployment_status_success', 'd1');
    seed('github/acme/widgets/repo/main.branch_protection_edited', 'b1');
    seed('github/acme/widgets/pull_request/42.enqueued', 'q1');
    seed('github/acme/widgets/pull_request/42.comment_created', 'x1');
    seed('github/acme/widgets/pull_request/42.status_error', 'old1', now - 48 * 60 * 60 * 1000);

    try {
      const clientHub = await setupHub(extension, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(snapshot.eventTypes.map((e) => e.type)).toEqual([
        'status',
        'review_thread',
        'deployment',
        'check_suite',
        'merge_group',
        'branch_protection',
      ]);
      const byType = new Map(snapshot.eventTypes.map((e) => [e.type, e]));
      expect(byType.get('status')?.count).toBe(2);
      expect(byType.get('status')?.lastAt).toBe(now);
      expect(byType.get('review_thread')?.count).toBe(1);
      expect(byType.get('deployment')?.count).toBe(1);
      expect(byType.get('merge_group')?.count).toBe(1);
      expect(byType.get('branch_protection')?.count).toBe(1);
      expect(byType.get('check_suite')?.count).toBe(0);
      expect(byType.get('check_suite')?.lastAt).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('recentErrors surfaces GitHub failures even when newer failures are from another source', async () => {
    const db = setupDb();
    seedSpace(db, 'space-1');
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: fakeUserFetch('octocat'),
    });
    const store = new ExternalEventStore(db);
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
      expect(snapshot.polling.inaccessibleRepoCount).toBe(0);
      expect(snapshot.polling.partialErrorRepoCount).toBe(1);
      expect(snapshot.repositories[0].lastPartialPollError).toContain('Resource not accessible');
    } finally {
      await extension.stop();
    }
  });

  test('a network-thrown poll records an inaccessible repo instead of aborting', async () => {
    const db = setupDb();
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
    const db = setupDb();
    const credentialStore = new MemoryCredentialStore();
    await credentialStore.set('neokai.external-events.github', 'default', 'ghp_A');
    const extension = new GitHubEventExtension(db, undefined, {
      credentialStore,
      fetchImpl: fakeUserFetch('octocat'),
    });
    const ext = extension as unknown as {
      rateLimitedUntil: number;
      lastRateLimitFingerprint?: string;
    };
    ext.rateLimitedUntil = Date.now() + 3_600_000;
    ext.lastRateLimitFingerprint = fp('ghp_A');
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
    ext.pollCycleCredentialGeneration = ext.credentialGeneration;
    const staleGeneration = ext.credentialGeneration;
    ext.credentialGeneration = staleGeneration + 1;
    ext.applyRateLimit({
      remaining: 0,
      resetAt: Date.now() + 60_000,
      limited: true,
      retryAfter: false,
    });
    expect(ext.rateLimitedUntil).toBe(0);
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
    ext.pollCycleCredentialGeneration = ext.credentialGeneration;
    ext.pollCycleCredentialFingerprint = fp('ghp_token');
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
    ext.lastResolvedToken = 'ghp_A';
    ext.applyRateLimit({
      remaining: 0,
      resetAt: Date.now() + 60_000,
      limited: true,
      retryAfter: false,
    });
    expect(ext.lastRateLimitFingerprint).toBe(fp('ghp_A'));
    expect(ext.rateLimitedUntil).toBe(longUntil);
  });

  test('a shorter rate limit under a DIFFERENT credential replaces the stale cooldown', () => {
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
    ext.lastResolvedToken = 'ghp_B';
    ext.applyRateLimit({
      remaining: 0,
      resetAt: Date.now() + 60_000,
      limited: true,
      retryAfter: false,
    });
    expect(ext.lastRateLimitFingerprint).toBe(fp('ghp_B'));
    expect(ext.rateLimitedUntil).toBeLessThan(Date.now() + 3_600_000);
    expect(ext.rateLimitedUntil).toBeGreaterThan(Date.now());
  });

  test('a validation rate limit is attributed to the validated token, not an in-flight poll credential', async () => {
    const db = setupDb();
    const credentialStore = new MemoryCredentialStore();
    await credentialStore.set('neokai.external-events.github', 'default', 'ghp_B');
    const extension = new GitHubEventExtension(db, undefined, {
      credentialStore,
      fetchImpl: (async (url: string | URL | Request) => {
        const path = typeof url === 'string' ? url : url.toString();
        if (path.endsWith('/user')) {
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
    ext.pollCycleCredentialGeneration = ext.credentialGeneration;
    ext.pollCycleCredentialFingerprint = fp('ghp_A');

    const clientHub = await setupHub(extension, new HealthConfigStore());
    await clientHub.request<GitHubHealthSnapshot>('space.github.health', { spaceId: 'space-1' });
    expect(ext.rateLimitedUntil).toBeGreaterThan(0);
    expect(ext.lastRateLimitFingerprint).toBe(fp('ghp_B'));
    await extension.stop();
  });

  test('a cooldown tagged to the now-effective credential is not cleared by a stale validated fingerprint', async () => {
    const db = setupDb();
    const credentialStore = new MemoryCredentialStore();
    await credentialStore.set('neokai.external-events.github', 'default', 'ghp_A');
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
    expect(ext.rateLimitedUntil).toBeGreaterThan(0);
    expect(ext.lastRateLimitFingerprint).toBe(fp('ghp_B'));
    await extension.stop();
  });

  test('a transient credential-store failure on the final read keeps the active cooldown', async () => {
    const db = setupDb();
    const store = new MemoryCredentialStore();
    await store.set('neokai.external-events.github', 'default', 'ghp_A');
    let getCalls = 0;
    const flakyStore = {
      get: async (service: string, account: string) => {
        getCalls++;
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
    expect(ext.rateLimitedUntil).toBeGreaterThan(0);
    await extension.stop();
  });

  test('a silent rotation after validation marks stale access evidence unverified', async () => {
    const db = setupDb();
    const credentialStore = new MemoryCredentialStore();
    await credentialStore.set('neokai.external-events.github', 'default', 'ghp_A');
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
    extension.repo.updatePollCursor(repo.id, { lastPollCredentialFingerprint: fp('ghp_A') });

    const clientHub = await setupHub(extension, rotatingConfig);
    const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
      spaceId: 'space-1',
    });
    expect(snapshot.polling.neverPolledRepoCount).toBe(1);
    await extension.stop();
  });

  test('pollOnce (global) counts errors only for repos the cycle attempts', async () => {
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
    expect(result.errors).toBeUndefined();
    await extension.stop();
  });

  test('a verified delivery clears a prior "update uncertain" webhook error', () => {
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
    extension.repo.clearWebhookRegistration(repo.id, {});
    expect(extension.repo.getWatchedRepoById(repo.id)?.lastWebhookAt).toBeNull();
  });

  test('scheduled polling runs multiple cycles and clears activePollCycle between them', async () => {
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
      await clientHub.request('space.github.pollOnce', { spaceId: 'space-1' });
      const manualFetches = repoFetches;
      const armedExt = extension as unknown as { pollTimer: unknown };
      const deadline = Date.now() + 6000;
      while (repoFetches < manualFetches + 4 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(manualFetches).toBeGreaterThan(0);
      expect(armedExt.pollTimer).not.toBeNull();
      expect(repoFetches).toBeGreaterThanOrEqual(manualFetches + 4);
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

  test('a rate-limited /user 403 is not treated as a rejected credential', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_token', {
      fetchImpl: (async (url: string | URL | Request) => {
        const path = typeof url === 'string' ? url : url.toString();
        if (path.endsWith('/user')) {
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
      expect(watched?.pollCursor?.lastPollError).toBeNull();
      expect(watched?.pollCursor?.lastPartialPollError).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('a successful /user validation with a normal budget persists the rate-limit observation', async () => {
    const db = setupDb();
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
      expect(snapshot.rateLimit.remaining).toBe(4999);
      expect(snapshot.rateLimit.limited).toBe(false);
      expect(snapshot.rateLimit.observedAt).toBeGreaterThan(0);
    } finally {
      await extension.stop();
    }
  });

  test('a credential change during the keychain read rejects the stale validation', async () => {
    const db = setupDb();
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
      await clientHub.request('space.github.watchRepo', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        webhookEnabled: true,
        webhookSecret: 'new-secret',
      });
      const watched = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets');
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
      await clientHub.request('space.github.health', { spaceId: 'space-1' });
      expect(userCalls).toBe(1);
      await clientHub.request('space.github.health', { spaceId: 'space-1', lightweight: true });
      expect(userCalls).toBe(1);
      await clientHub.request('space.github.health', { spaceId: 'space-1' });
      expect(userCalls).toBe(2);
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
      const first = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(first.token.error).toBe('credential changed during validation');
      expect(first.token.authRejected).toBeFalsy();
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
    extension.repo.updatePollCursor(repo.id, { lastPartialPollError: 'pulls HTTP 403' });
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
    extension.repo.updateWebhookStatus(repo.id, {
      lastCheckedAt: Date.now(),
      lastError: 'check timed out',
    });
    expect(extension.repo.getWatchedRepoById(repo.id)?.webhookLastError).toBe('check timed out');
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
      await clientHub.request('space.github.health', { spaceId: 'space-1' });
      expect(userCalls).toBe(1);
      await clientHub.request('space.github.health', { spaceId: 'space-1', lightweight: true });
      expect(userCalls).toBe(1);
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
    extension.repo.updateWebhookStatus(repo.id, {
      active: false,
      lastCheckedAt: Date.now(),
      lastError: 'GitHub webhook is missing required events',
    });
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
      await setupHub(extension, new HealthConfigStore());
      await extension.pollWatchedRepo(
        extension.repo.listPollingRepos('space-1')[0],
        fakeUserFetch('octocat')
      );
      await extension.stop();

      const extension2 = new GitHubEventExtension(db, 'ghp_token', {
        pollIntervalMs: 60_000,
        fetchImpl: fakeUserFetch('octocat'),
      });
      const clientHub = await setupHub(extension2, new HealthConfigStore());
      const snapshot = await clientHub.request<GitHubHealthSnapshot>('space.github.health', {
        spaceId: 'space-1',
      });
      expect(snapshot.polling.neverPolledRepoCount).toBe(0);
      expect(snapshot.polling.lastPollAt).not.toBeNull();
      await extension2.stop();
    } finally {
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
    extension.repo.updatePollCursor(repo.id, {});
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
    extension.repo.updatePollCursor(repo.id, {
      lastSeenAt: 0,
      lastPollCredentialFingerprint: fp('ghp_B'),
    });
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
      expect(snapshot.polling.neverPolledRepoCount).toBe(1);
      expect(snapshot.polling.lastPollAt).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('validatedFingerprint overrides the pre-validation read for access-scoping', async () => {
    const db = setupDb();
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
    extension.repo.updatePollCursor(repo.id, {
      lastSeenAt: 0,
      lastPollCredentialFingerprint: fp('ghp_OLD'),
    });
    (extension as unknown as { resolveToken: () => Promise<string | null> }).resolveToken =
      async () => 'ghp_OLD';
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
});
