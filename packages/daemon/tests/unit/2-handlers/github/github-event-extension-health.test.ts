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
    extension.repo.updatePollCursor(repoC.id, { recentPullRequestNumbers: [7, 8] });

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
});
