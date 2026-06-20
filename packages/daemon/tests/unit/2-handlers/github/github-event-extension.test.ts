import { Database as BunDatabase } from 'bun:sqlite';
import { InProcessTransport, MessageHub } from '@neokai/shared';
import { describe, expect, test } from 'bun:test';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import {
  ExternalEventService,
  ExternalEventStore,
  type ExternalEvent,
} from '../../../../src/lib/external-events';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github';
import {
  mapEventType,
  normalizeGitHubWebhook,
  toExternalEvent,
} from '../../../../src/lib/external-events/github/github-normalizer';
import type {
  ExternalEventExtensionConfigStore,
  SpaceExternalEventSourceConfig,
} from '../../../../src/lib/external-events/types';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';

async function createSignature(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const buffer = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(payload));
  return `sha256=${Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
}

function setupDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  createTables(db);
  runMigrations(db, () => {});
  return db;
}

class StaticExternalEventExtensionConfigStore implements ExternalEventExtensionConfigStore {
  readonly spaceConfigs = new Map<string, SpaceExternalEventSourceConfig>();

  constructor(
    private readonly options: { globallyEnabled?: boolean; webhooks?: boolean; polling?: boolean }
  ) {}

  async getGlobalConfig(source: string) {
    return {
      source,
      globallyEnabled: this.options.globallyEnabled ?? true,
      capabilities: {
        webhooks: this.options.webhooks ?? true,
        polling: this.options.polling ?? true,
        rpcConfig: true,
      },
      settings: {},
    };
  }

  async getSpaceConfig(
    spaceId: string,
    source: string
  ): Promise<SpaceExternalEventSourceConfig | null> {
    return (
      this.spaceConfigs.get(`${spaceId}:${source}`) ?? {
        spaceId,
        source,
        enabled: true,
        settings: {},
      }
    );
  }

  async listEnabledSpaces(_source: string): Promise<SpaceExternalEventSourceConfig[]> {
    return [];
  }

  async setGlobalConfig(
    _source: string,
    _config: Awaited<ReturnType<ExternalEventExtensionConfigStore['getGlobalConfig']>>
  ): Promise<void> {}

  async setSpaceConfig(
    spaceId: string,
    source: string,
    config: SpaceExternalEventSourceConfig
  ): Promise<void> {
    this.spaceConfigs.set(`${spaceId}:${source}`, config);
  }
}

const baseRepo = {
  id: 1,
  name: 'widgets',
  full_name: 'Acme/Widgets',
  owner: { login: 'Acme' },
};

function payloadFor(event: string): unknown {
  if (event === 'issue_comment') {
    return {
      action: 'created',
      repository: baseRepo,
      sender: { login: 'bot', type: 'Bot' },
      issue: { number: 7, title: 'PR', pull_request: { url: 'api' } },
      comment: {
        id: 101,
        body: 'looks good',
        html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-101',
        user: { login: 'bot', type: 'Bot' },
        created_at: '2026-01-01T00:00:00Z',
      },
    };
  }
  return {
    action: 'synchronize',
    repository: baseRepo,
    sender: { login: 'dev', type: 'User' },
    pull_request: {
      id: 77,
      number: 7,
      body: 'pr body',
      html_url: 'https://github.com/acme/widgets/pull/7',
      user: { login: 'dev', type: 'User' },
      updated_at: '2026-01-01T00:00:00Z',
    },
  };
}

function webhookRequest(payload: unknown, event: string, signature?: string): Request {
  const headers: Record<string, string> = {
    'X-GitHub-Event': event,
    'X-GitHub-Delivery': 'delivery-1',
  };
  if (signature) headers['X-Hub-Signature-256'] = signature;
  return new Request('http://localhost/webhook/github/space', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
}

function setupExternalEventService(db: BunDatabase): {
  service: ExternalEventService;
  received: ExternalEvent[];
} {
  db.prepare(
    `INSERT OR IGNORE INTO spaces (id, slug, name, workspace_path, status, created_at, updated_at) VALUES ('space-1', 'space-1', 'Space', '/tmp', 'active', 1, 1)`
  ).run();
  const bus = createDaemonInternalEventBus();
  const service = new ExternalEventService(new ExternalEventStore(db), bus);
  const received: ExternalEvent[] = [];
  bus.subscribe(
    'externalEvent.published',
    (payload) => {
      received.push({
        id: payload.eventId,
        spaceId: payload.spaceId,
        topic: payload.topic,
        occurredAt: payload.occurredAt,
        ingestedAt: payload.ingestedAt,
        source: payload.source,
        summary: payload.summary,
        externalUrl: payload.externalUrl,
        payload: payload.payload,
        dedupeKey: payload.dedupeKey,
      });
    },
    { subscriberName: 'github-event-extension-test' }
  );
  return { service, received };
}

function pollingResponse(body: unknown[], remaining = 5_000): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'X-RateLimit-Remaining': String(remaining) },
  });
}

function createPullRequestRow(number: number): Record<string, unknown> {
  return {
    id: number * 10,
    number,
    state: 'open',
    title: `PR ${number}`,
    body: `Body ${number}`,
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    user: { login: 'dev', type: 'User' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function createReactionRow(
  overrides: Partial<{
    id: number;
    content: string;
    created_at: string;
    user: { login: string; type: string };
  }> = {}
): Record<string, unknown> {
  return {
    id: 9001,
    content: '+1',
    created_at: '2026-01-02T00:00:00Z',
    user: { login: 'codex[bot]', type: 'Bot' },
    ...overrides,
  };
}

describe('GitHubEventExtension', () => {
  test('normalizes webhooks and constructs canonical topics', () => {
    const normalized = normalizeGitHubWebhook(
      'issue_comment',
      'delivery-1',
      payloadFor('issue_comment')
    )!;
    expect(normalized.repoOwner).toBe('Acme');
    expect(normalized.repoName).toBe('widgets');
    expect(mapEventType(normalized.eventType, normalized.action, normalized.entityId)).toEqual({
      resource: 'pull_request',
      entityId: '7',
      action: 'comment_created',
    });

    const event = toExternalEvent('space-1', normalized);
    expect(event.topic).toBe('github/acme/widgets/pull_request/7.comment_created');
    expect(event.source).toBe('github');
    expect(event.payload.prNumber).toBe(7);
    expect(event.payload.repoOwner).toBe('acme');
    expect(event.dedupeKey).toBe('acme/widgets:issue_comment:101:created');
  });

  test('webhook verifies signatures, checks enablement, and publishes ExternalEventService event', async () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO spaces (id, slug, name, workspace_path, status, created_at, updated_at) VALUES ('space-1', 'space-1', 'Space', '/tmp', 'active', 1, 1)`
    ).run();
    const { service, received } = setupExternalEventService(db);
    const extension = new GitHubEventExtension(db);
    const context = {
      publisher: service,
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
    });

    const payload = payloadFor('issue_comment');
    const raw = JSON.stringify(payload);
    const ok = await extension.routes[0].handle(
      webhookRequest(payload, 'issue_comment', await createSignature(raw, 'secret'))
    );
    expect(ok.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].topic).toBe('github/acme/widgets/pull_request/7.comment_created');
    expect(db.prepare('SELECT COUNT(*) AS c FROM space_external_events').get()).toEqual({ c: 1 });

    const duplicate = await extension.routes[0].handle(
      webhookRequest(payload, 'issue_comment', await createSignature(raw, 'secret'))
    );
    expect(duplicate.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS c FROM space_external_events').get()).toEqual({ c: 1 });

    const bad = await extension.routes[0].handle(
      webhookRequest(payload, 'issue_comment', await createSignature(raw, 'wrong'))
    );
    expect(bad.status).toBe(401);

    const missingSignature = await extension.routes[0].handle(
      webhookRequest(payload, 'issue_comment')
    );
    expect(missingSignature.status).toBe(401);

    const otherRepoPayload = {
      ...(payload as Record<string, unknown>),
      repository: {
        id: 2,
        name: 'other',
        full_name: 'acme/other',
        owner: { login: 'acme' },
      },
    };
    const otherRaw = JSON.stringify(otherRepoPayload);
    const repoNotWatched = await extension.routes[0].handle(
      webhookRequest(otherRepoPayload, 'issue_comment', await createSignature(otherRaw, 'secret'))
    );
    expect(repoNotWatched.status).toBe(404);

    await extension.stop();
  });

  test('treats omitted webhook capability as enabled', async () => {
    const db = setupDb();
    const published: ExternalEvent[] = [];
    const extension = new GitHubEventExtension(db);
    const context = {
      publisher: { publish: async (event: ExternalEvent) => published.push(event) },
      config: {
        async getGlobalConfig(source: string) {
          return { source, globallyEnabled: true, capabilities: {} };
        },
        async getSpaceConfig(spaceId: string, source: string) {
          return { spaceId, source, enabled: true, settings: {} };
        },
        async listEnabledSpaces() {
          return [];
        },
      },
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
    });

    const payload = payloadFor('issue_comment');
    const raw = JSON.stringify(payload);
    const response = await extension.routes[0].handle(
      webhookRequest(payload, 'issue_comment', await createSignature(raw, 'secret'))
    );

    expect(response.status).toBe(200);
    expect(published).toHaveLength(1);
    await extension.stop();
  });

  test('accepts and ignores matching webhooks when the source is disabled globally', async () => {
    const db = setupDb();
    const published: ExternalEvent[] = [];
    const extension = new GitHubEventExtension(db);
    const context = {
      publisher: { publish: async (event: ExternalEvent) => published.push(event) },
      config: {
        async getGlobalConfig(source: string) {
          return {
            source,
            globallyEnabled: false,
            capabilities: { webhooks: true, polling: true },
          };
        },
        async getSpaceConfig(spaceId: string, source: string) {
          return { spaceId, source, enabled: true, settings: {} };
        },
        async listEnabledSpaces() {
          return [];
        },
      },
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
    });

    const payload = payloadFor('issue_comment');
    const raw = JSON.stringify(payload);
    const response = await extension.routes[0].handle(
      webhookRequest(payload, 'issue_comment', await createSignature(raw, 'secret'))
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ reason: 'github_extension_disabled' });
    expect(published).toHaveLength(0);
    await extension.stop();
  });

  test('accepts and ignores matching webhooks when the webhook capability is disabled', async () => {
    const db = setupDb();
    const published: ExternalEvent[] = [];
    const extension = new GitHubEventExtension(db);
    const context = {
      publisher: { publish: async (event: ExternalEvent) => published.push(event) },
      config: {
        async getGlobalConfig(source: string) {
          return {
            source,
            globallyEnabled: true,
            capabilities: { webhooks: false, polling: true },
          };
        },
        async getSpaceConfig(spaceId: string, source: string) {
          return { spaceId, source, enabled: true, settings: {} };
        },
        async listEnabledSpaces() {
          return [];
        },
      },
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
    });

    const payload = payloadFor('issue_comment');
    const raw = JSON.stringify(payload);
    const response = await extension.routes[0].handle(
      webhookRequest(payload, 'issue_comment', await createSignature(raw, 'secret'))
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ reason: 'github_extension_disabled' });
    expect(published).toHaveLength(0);
    await extension.stop();
  });

  test('accepts and ignores matching webhooks when the watched repository is disabled', async () => {
    const db = setupDb();
    const published: ExternalEvent[] = [];
    const extension = new GitHubEventExtension(db);
    const context = {
      publisher: { publish: async (event: ExternalEvent) => published.push(event) },
      config: {
        async getGlobalConfig(source: string) {
          return { source, globallyEnabled: true, capabilities: { webhooks: true, polling: true } };
        },
        async getSpaceConfig(spaceId: string, source: string) {
          return { spaceId, source, enabled: true, settings: {} };
        },
        async listEnabledSpaces() {
          return [];
        },
      },
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
      enabled: false,
    });

    const payload = payloadFor('issue_comment');
    const raw = JSON.stringify(payload);
    const response = await extension.routes[0].handle(
      webhookRequest(payload, 'issue_comment', await createSignature(raw, 'secret'))
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ spaces: 0 });
    expect(published).toHaveLength(0);
    await extension.stop();
  });

  test('does not publish when a matched space is disabled', async () => {
    const db = setupDb();
    const published: ExternalEvent[] = [];
    const extension = new GitHubEventExtension(db);
    const context = {
      publisher: { publish: async (event: ExternalEvent) => published.push(event) },
      config: {
        async getGlobalConfig(source: string) {
          return { source, globallyEnabled: true, capabilities: { webhooks: true, polling: true } };
        },
        async getSpaceConfig(spaceId: string, source: string) {
          return { spaceId, source, enabled: false, settings: {} };
        },
        async listEnabledSpaces() {
          return [];
        },
      },
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
    });

    const payload = payloadFor('issue_comment');
    const raw = JSON.stringify(payload);
    const response = await extension.routes[0].handle(
      webhookRequest(payload, 'issue_comment', await createSignature(raw, 'secret'))
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ spaces: 0 });
    expect(published).toHaveLength(0);
    await extension.stop();
  });

  test('RPC disable persists for newly watched repositories', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db);
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);

    await clientHub.request('space.github.disable', { spaceId: 'space-1' });
    await clientHub.request('space.github.watchRepo', {
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });

    expect(extension.repo.listWatchedRepos('space-1')[0].enabled).toBe(false);
    await extension.stop();
  });

  test('RPC unwatchRepo removes watched repositories', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db);
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    await clientHub.request('space.github.watchRepo', {
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
    });

    const result = await clientHub.request<{ removed: boolean }>('space.github.unwatchRepo', {
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
    });

    expect(result.removed).toBe(true);
    expect(extension.repo.listWatchedRepos('space-1')).toHaveLength(0);
    await extension.stop();
  });

  test('RPC unwatchRepo preserves explicit space enablement after removing last repository', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db);
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const config = new StaticExternalEventExtensionConfigStore({ globallyEnabled: true });
    const context = {
      publisher: { publish: async () => {} },
      config,
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    await clientHub.request('space.github.enable', { spaceId: 'space-1' });
    await clientHub.request('space.github.watchRepo', {
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
    });

    await clientHub.request('space.github.unwatchRepo', {
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
    });

    expect(extension.repo.listWatchedRepos('space-1')).toHaveLength(0);
    expect((await config.getSpaceConfig('space-1', 'github'))?.enabled).toBe(true);
    await extension.stop();
  });

  test('space-scoped pollOnce respects global polling disable', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db);
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    let publishCount = 0;
    const context = {
      publisher: {
        publish: async () => {
          publishCount++;
        },
      },
      config: new StaticExternalEventExtensionConfigStore({
        globallyEnabled: true,
        polling: false,
      }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });

    await expect(
      clientHub.request('space.github.pollOnce', { spaceId: 'space-1' })
    ).rejects.toThrow('GitHub polling capability is disabled');
    expect(publishCount).toBe(0);
    await extension.stop();
  });

  test('RPC autoConfigureWebhook encodes GitHub API repository path segments', async () => {
    const previousPublicUrl = process.env.NEOKAI_PUBLIC_URL;
    process.env.NEOKAI_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: typeof url === 'string' || url instanceof URL ? String(url) : url.url,
          init,
        });
        return new Response(
          JSON.stringify({
            id: 123,
            active: true,
            config: { url: 'https://example.com/webhook/github/space', content_type: 'json' },
          }),
          { status: 201 }
        );
      }) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);

      await clientHub.request('space.github.autoConfigureWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: '../../orgs/acme',
      });

      expect(calls[0].url).toBe('https://api.github.com/repos/acme/..%2F..%2Forgs%2Facme/hooks');
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.NEOKAI_PUBLIC_URL;
      else process.env.NEOKAI_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('RPC autoConfigureWebhook creates GitHub hook and stores masked metadata', async () => {
    const previousPublicUrl = process.env.NEOKAI_PUBLIC_URL;
    process.env.NEOKAI_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: typeof url === 'string' || url instanceof URL ? String(url) : url.url,
          init,
        });
        return new Response(
          JSON.stringify({
            id: 123,
            active: true,
            config: { url: 'https://example.com/webhook/github/space', content_type: 'json' },
          }),
          { status: 201 }
        );
      }) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);

      const result = await clientHub.request<{
        watchedRepo: { webhookSecret: string; webhookRemoteId: number };
      }>('space.github.autoConfigureWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });

      expect(calls[0].url).toBe('https://api.github.com/repos/acme/widgets/hooks');
      expect(calls[0].init?.headers).toMatchObject({
        'Content-Type': 'application/json',
      });
      const body = JSON.parse(String(calls[0].init?.body)) as {
        events: string[];
        config: { content_type: string; secret: string; url: string };
      };
      expect(body.events).toEqual([
        'push',
        'pull_request',
        'issue_comment',
        'pull_request_review',
        'pull_request_review_comment',
      ]);
      expect(body.config).toMatchObject({
        url: 'https://example.com/webhook/github/space',
        content_type: 'json',
      });
      expect(body.config.secret).toHaveLength(64);
      expect(result.watchedRepo.webhookSecret).toBe('configured');
      expect(result.watchedRepo.webhookRemoteId).toBe(123);
      const stored = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      expect(stored.webhookSecret).toHaveLength(64);
      expect(stored.webhookAutoRegistered).toBe(true);
      expect(stored.webhookActive).toBe(true);
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.NEOKAI_PUBLIC_URL;
      else process.env.NEOKAI_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('RPC autoConfigureWebhook updates existing auto-registered hook without deleting first', async () => {
    const previousPublicUrl = process.env.NEOKAI_PUBLIC_URL;
    process.env.NEOKAI_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: typeof url === 'string' || url instanceof URL ? String(url) : url.url,
          init,
        });
        return new Response(
          JSON.stringify({
            id: 123,
            active: true,
            events: [
              'push',
              'pull_request',
              'issue_comment',
              'pull_request_review',
              'pull_request_review_comment',
            ],
            config: { url: 'https://example.com/webhook/github/space', content_type: 'json' },
          }),
          { status: 200 }
        );
      }) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        webhookSecret: 'old-secret',
        webhookEnabled: true,
        pollingEnabled: false,
        webhookRemoteId: 123,
        webhookUrl: 'https://old.example.com/webhook/github/space',
        webhookAutoRegistered: true,
        webhookActive: true,
      });
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);

      await clientHub.request('space.github.autoConfigureWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });

      expect(calls.map((call) => `${call.init?.method ?? 'GET'} ${call.url}`)).toEqual([
        'PATCH https://api.github.com/repos/acme/widgets/hooks/123',
      ]);
      const body = JSON.parse(String(calls[0].init?.body)) as { config: { secret: string } };
      expect(body.config.secret).toHaveLength(64);
      expect(extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')?.webhookRemoteId).toBe(
        123
      );
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.NEOKAI_PUBLIC_URL;
      else process.env.NEOKAI_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('RPC autoConfigureWebhook rejects when webhook capability is disabled', async () => {
    const previousPublicUrl = process.env.NEOKAI_PUBLIC_URL;
    process.env.NEOKAI_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    let fetchCalled = false;
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async () => {
        fetchCalled = true;
        return new Response('{}', { status: 201 });
      }) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({
        globallyEnabled: true,
        webhooks: false,
      }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      await expect(
        clientHub.request('space.github.autoConfigureWebhook', {
          spaceId: 'space-1',
          owner: 'acme',
          repo: 'widgets',
        })
      ).rejects.toThrow('GitHub webhook capability is disabled');
      expect(fetchCalled).toBe(false);
    } finally {
      if (previousPublicUrl === undefined) delete process.env.NEOKAI_PUBLIC_URL;
      else process.env.NEOKAI_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('RPC autoConfigureWebhook recreates stale auto-registered hooks', async () => {
    const previousPublicUrl = process.env.NEOKAI_PUBLIC_URL;
    process.env.NEOKAI_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: typeof url === 'string' || url instanceof URL ? String(url) : url.url,
          init,
        });
        if (init?.method === 'PATCH') {
          return new Response(JSON.stringify({ message: 'Not Found' }), {
            status: 404,
            statusText: 'Not Found',
          });
        }
        return new Response(
          JSON.stringify({
            id: 456,
            active: true,
            config: { url: 'https://example.com/webhook/github/space', content_type: 'json' },
          }),
          { status: 201 }
        );
      }) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        webhookSecret: 'old-secret',
        webhookEnabled: true,
        pollingEnabled: false,
        webhookRemoteId: 123,
        webhookUrl: 'https://example.com/webhook/github/space',
        webhookAutoRegistered: true,
        webhookActive: true,
      });
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);

      await clientHub.request('space.github.autoConfigureWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });

      expect(calls.map((call) => `${call.init?.method ?? 'GET'} ${call.url}`)).toEqual([
        'PATCH https://api.github.com/repos/acme/widgets/hooks/123',
        'POST https://api.github.com/repos/acme/widgets/hooks',
      ]);
      const stored = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      expect(stored.webhookRemoteId).toBe(456);
      expect(stored.webhookSecret).not.toBe('old-secret');
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.NEOKAI_PUBLIC_URL;
      else process.env.NEOKAI_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('RPC autoConfigureWebhook reuses existing repository hook across spaces', async () => {
    const previousPublicUrl = process.env.NEOKAI_PUBLIC_URL;
    process.env.NEOKAI_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: typeof url === 'string' || url instanceof URL ? String(url) : url.url,
          init,
        });
        return new Response(
          JSON.stringify({
            id: 123,
            active: true,
            config: { url: 'https://example.com/webhook/github/space', content_type: 'json' },
          }),
          { status: 200 }
        );
      }) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        webhookSecret: 'shared-secret',
        webhookEnabled: true,
        pollingEnabled: false,
        webhookRemoteId: 123,
        webhookUrl: 'https://example.com/webhook/github/space',
        webhookAutoRegistered: true,
        webhookActive: true,
      });
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);

      await clientHub.request('space.github.autoConfigureWebhook', {
        spaceId: 'space-2',
        owner: 'acme',
        repo: 'widgets',
      });

      expect(calls.map((call) => `${call.init?.method ?? 'GET'} ${call.url}`)).toEqual([
        'PATCH https://api.github.com/repos/acme/widgets/hooks/123',
      ]);
      const stored = extension.repo.getWatchedRepo('space-2', 'acme', 'widgets')!;
      expect(stored.webhookRemoteId).toBe(123);
      expect(stored.webhookSecret).toBe('shared-secret');
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.NEOKAI_PUBLIC_URL;
      else process.env.NEOKAI_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('RPC autoConfigureWebhook keeps shared auto-hook secrets in sync', async () => {
    const previousPublicUrl = process.env.NEOKAI_PUBLIC_URL;
    process.env.NEOKAI_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            id: 123,
            active: true,
            config: { url: 'https://example.com/webhook/github/space', content_type: 'json' },
          }),
          { status: 200 }
        )) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      for (const spaceId of ['space-1', 'space-2']) {
        extension.repo.upsertWatchedRepo({
          spaceId,
          owner: 'acme',
          repo: 'widgets',
          webhookSecret: 'shared-secret',
          webhookEnabled: true,
          pollingEnabled: false,
          webhookRemoteId: 123,
          webhookUrl: 'https://example.com/webhook/github/space',
          webhookAutoRegistered: true,
          webhookActive: true,
        });
      }
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);

      await clientHub.request('space.github.autoConfigureWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });

      const first = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      const second = extension.repo.getWatchedRepo('space-2', 'acme', 'widgets')!;
      expect(first.webhookRemoteId).toBe(123);
      expect(second.webhookRemoteId).toBe(123);
      expect(first.webhookSecret).not.toBe('shared-secret');
      expect(second.webhookSecret).toBe(first.webhookSecret);
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.NEOKAI_PUBLIC_URL;
      else process.env.NEOKAI_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('RPC autoConfigureWebhook updates shared rows after recreating stale hooks', async () => {
    const previousPublicUrl = process.env.NEOKAI_PUBLIC_URL;
    process.env.NEOKAI_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          return new Response(JSON.stringify({ message: 'Not Found' }), {
            status: 404,
            statusText: 'Not Found',
          });
        }
        return new Response(
          JSON.stringify({
            id: 456,
            active: true,
            config: { url: 'https://example.com/webhook/github/space', content_type: 'json' },
          }),
          { status: 201 }
        );
      }) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      for (const spaceId of ['space-1', 'space-2']) {
        extension.repo.upsertWatchedRepo({
          spaceId,
          owner: 'acme',
          repo: 'widgets',
          webhookSecret: 'shared-secret',
          webhookEnabled: true,
          pollingEnabled: false,
          webhookRemoteId: 123,
          webhookUrl: 'https://example.com/webhook/github/space',
          webhookAutoRegistered: true,
          webhookActive: true,
        });
      }
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);

      await clientHub.request('space.github.autoConfigureWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });

      const first = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      const second = extension.repo.getWatchedRepo('space-2', 'acme', 'widgets')!;
      expect(first.webhookRemoteId).toBe(456);
      expect(second.webhookRemoteId).toBe(456);
      expect(second.webhookSecret).toBe(first.webhookSecret);
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.NEOKAI_PUBLIC_URL;
      else process.env.NEOKAI_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('RPC autoConfigureWebhook keeps existing hook when replacement update fails', async () => {
    const previousPublicUrl = process.env.NEOKAI_PUBLIC_URL;
    process.env.NEOKAI_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: 'Validation failed' }), {
          status: 422,
          statusText: 'Unprocessable Entity',
        })) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        webhookSecret: 'old-secret',
        webhookEnabled: true,
        pollingEnabled: false,
        webhookRemoteId: 123,
        webhookUrl: 'https://old.example.com/webhook/github/space',
        webhookAutoRegistered: true,
        webhookActive: true,
      });
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);

      await expect(
        clientHub.request('space.github.autoConfigureWebhook', {
          spaceId: 'space-1',
          owner: 'acme',
          repo: 'widgets',
        })
      ).rejects.toThrow('GitHub API error: Validation failed');

      const stored = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      expect(stored.webhookRemoteId).toBe(123);
      expect(stored.webhookSecret).toBe('old-secret');
      expect(stored.webhookActive).toBe(true);
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.NEOKAI_PUBLIC_URL;
      else process.env.NEOKAI_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('RPC watchRepo cleans up auto-hook metadata when disabling webhooks', async () => {
    const db = setupDb();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: typeof url === 'string' || url instanceof URL ? String(url) : url.url,
          init,
        });
        return new Response('', { status: 204 });
      }) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        webhookSecret: 'managed-secret',
        webhookEnabled: true,
        pollingEnabled: false,
        webhookRemoteId: 123,
        webhookUrl: 'https://example.com/webhook/github/space',
        webhookAutoRegistered: true,
        webhookActive: true,
      });
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);

      await clientHub.request('space.github.watchRepo', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        webhookEnabled: false,
        pollingEnabled: true,
      });

      expect(calls.map((call) => `${call.init?.method ?? 'GET'} ${call.url}`)).toEqual([
        'DELETE https://api.github.com/repos/acme/widgets/hooks/123',
      ]);
      const stored = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      expect(stored.webhookEnabled).toBe(false);
      expect(stored.pollingEnabled).toBe(true);
      expect(stored.webhookAutoRegistered).toBe(false);
      expect(stored.webhookRemoteId).toBeNull();
      expect(stored.webhookSecret).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('RPC checkWebhook rejects when webhook capability is disabled', async () => {
    const db = setupDb();
    let fetchCalled = false;
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({
        globallyEnabled: true,
        webhooks: false,
      }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
      webhookEnabled: true,
      pollingEnabled: false,
      webhookRemoteId: 123,
      webhookAutoRegistered: true,
      webhookActive: true,
    });

    await expect(
      clientHub.request('space.github.checkWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      })
    ).rejects.toThrow('GitHub webhook capability is disabled');
    expect(fetchCalled).toBe(false);
    await extension.stop();
  });

  test('RPC checkWebhook stores inactive status and unwatch deletes auto-registered hook', async () => {
    const db = setupDb();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: typeof url === 'string' || url instanceof URL ? String(url) : url.url,
          init,
        });
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        return new Response(
          JSON.stringify({
            id: 123,
            active: false,
            events: [
              'push',
              'pull_request',
              'issue_comment',
              'pull_request_review',
              'pull_request_review_comment',
            ],
            config: { url: 'https://example.com/webhook/github/space', content_type: 'json' },
          }),
          { status: 200 }
        );
      }) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
      webhookEnabled: true,
      pollingEnabled: false,
      webhookRemoteId: 123,
      webhookAutoRegistered: true,
      webhookActive: true,
    });

    const result = await clientHub.request<{ watchedRepo: { webhookActive: boolean } }>(
      'space.github.checkWebhook',
      {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      }
    );
    await clientHub.request('space.github.unwatchRepo', {
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
    });

    expect(result.watchedRepo.webhookActive).toBe(false);
    expect(calls.map((call) => `${call.init?.method ?? 'GET'} ${call.url}`)).toEqual([
      'GET https://api.github.com/repos/acme/widgets/hooks/123',
      'DELETE https://api.github.com/repos/acme/widgets/hooks/123',
    ]);
    expect(extension.repo.listWatchedRepos('space-1')).toHaveLength(0);
    await extension.stop();
  });

  test('RPC checkWebhook propagates shared webhook status', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            id: 123,
            active: false,
            events: ['pull_request', 'issue_comment'],
            config: { url: 'https://example.com/webhook/github/space', content_type: 'json' },
          }),
          { status: 200 }
        )) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      for (const spaceId of ['space-1', 'space-2']) {
        extension.repo.upsertWatchedRepo({
          spaceId,
          owner: 'acme',
          repo: 'widgets',
          webhookSecret: 'shared-secret',
          webhookEnabled: true,
          pollingEnabled: false,
          webhookRemoteId: 123,
          webhookUrl: 'https://example.com/webhook/github/space',
          webhookAutoRegistered: true,
          webhookActive: true,
        });
      }
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);

      await clientHub.request('space.github.checkWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });

      const first = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      const second = extension.repo.getWatchedRepo('space-2', 'acme', 'widgets')!;
      expect(first.webhookActive).toBe(false);
      expect(second.webhookActive).toBe(false);
      expect(second.webhookLastError).toBe('GitHub webhook is disabled');
    } finally {
      await extension.stop();
    }
  });

  test('RPC checkWebhook does not require ignored push webhooks', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            id: 123,
            active: true,
            events: [
              'pull_request',
              'issue_comment',
              'pull_request_review',
              'pull_request_review_comment',
            ],
            config: { url: 'https://example.com/webhook/github/space', content_type: 'json' },
          }),
          { status: 200 }
        )) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
      webhookEnabled: true,
      pollingEnabled: false,
      webhookRemoteId: 123,
      webhookUrl: 'https://example.com/webhook/github/space',
      webhookAutoRegistered: true,
      webhookActive: false,
    });

    const result = await clientHub.request<{
      watchedRepo: { webhookActive: boolean; webhookLastError: string | null };
    }>('space.github.checkWebhook', {
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
    });

    expect(result.watchedRepo.webhookActive).toBe(true);
    expect(result.watchedRepo.webhookLastError).toBeNull();
    await extension.stop();
  });

  test('RPC checkWebhook accepts wildcard event subscriptions', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            id: 123,
            active: true,
            events: ['*'],
            config: { url: 'https://example.com/webhook/github/space', content_type: 'json' },
          }),
          { status: 200 }
        )) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
      webhookEnabled: true,
      pollingEnabled: false,
      webhookRemoteId: 123,
      webhookUrl: 'https://example.com/webhook/github/space',
      webhookAutoRegistered: true,
      webhookActive: false,
    });

    const result = await clientHub.request<{
      watchedRepo: { webhookActive: boolean; webhookLastError: string | null };
    }>('space.github.checkWebhook', {
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
    });

    expect(result.watchedRepo.webhookActive).toBe(true);
    expect(result.watchedRepo.webhookLastError).toBeNull();
    await extension.stop();
  });

  test('RPC checkWebhook marks content type mismatches inactive', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            id: 123,
            active: true,
            events: [
              'pull_request',
              'issue_comment',
              'pull_request_review',
              'pull_request_review_comment',
            ],
            config: { url: 'https://example.com/webhook/github/space', content_type: 'form' },
          }),
          { status: 200 }
        )) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
      webhookEnabled: true,
      pollingEnabled: false,
      webhookRemoteId: 123,
      webhookUrl: 'https://example.com/webhook/github/space',
      webhookAutoRegistered: true,
      webhookActive: true,
    });

    const result = await clientHub.request<{
      watchedRepo: { webhookActive: boolean; webhookLastError: string | null };
    }>('space.github.checkWebhook', {
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
    });

    expect(result.watchedRepo.webhookActive).toBe(false);
    expect(result.watchedRepo.webhookLastError).toBe('GitHub webhook content type must be JSON');
    await extension.stop();
  });

  test('RPC checkWebhook marks URL and event mismatches inactive', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            id: 123,
            active: true,
            events: ['push'],
            config: { url: 'https://wrong.example.com/webhook/github/space' },
          }),
          { status: 200 }
        )) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
      webhookEnabled: true,
      pollingEnabled: false,
      webhookRemoteId: 123,
      webhookUrl: 'https://example.com/webhook/github/space',
      webhookAutoRegistered: true,
      webhookActive: true,
    });

    const result = await clientHub.request<{
      watchedRepo: { webhookActive: boolean; webhookLastError: string };
    }>('space.github.checkWebhook', {
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
    });

    expect(result.watchedRepo.webhookActive).toBe(false);
    expect(result.watchedRepo.webhookLastError).toBe(
      'GitHub webhook URL does not match this NeoKai endpoint'
    );
    await extension.stop();
  });

  test('RPC checkWebhook preserves active status when GitHub read fails', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: 'rate limited' }), {
          status: 403,
          statusText: 'Forbidden',
        })) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
      webhookEnabled: true,
      pollingEnabled: false,
      webhookRemoteId: 123,
      webhookAutoRegistered: true,
      webhookActive: true,
    });

    await expect(
      clientHub.request('space.github.checkWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      })
    ).rejects.toThrow('GitHub token lacks permission to manage repository webhooks: rate limited');

    const stored = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
    expect(stored.webhookActive).toBe(true);
    expect(stored.webhookLastError).toBe(
      'GitHub token lacks permission to manage repository webhooks: rate limited'
    );
    await extension.stop();
  });

  test('RPC checkWebhook marks missing remote hooks inactive', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          statusText: 'Not Found',
        })) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
      webhookEnabled: true,
      pollingEnabled: false,
      webhookRemoteId: 123,
      webhookAutoRegistered: true,
      webhookActive: true,
    });

    await expect(
      clientHub.request('space.github.checkWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      })
    ).rejects.toThrow(
      'GitHub repository or webhook was not found, or token lacks access: Not Found'
    );

    const stored = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
    expect(stored.webhookActive).toBe(false);
    expect(stored.webhookLastError).toBe(
      'GitHub repository or webhook was not found, or token lacks access: Not Found'
    );
    await extension.stop();
  });

  test('RPC watchRepo clears auto-hook metadata when replacing secret manually', async () => {
    const db = setupDb();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: typeof url === 'string' || url instanceof URL ? String(url) : url.url,
          init,
        });
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'generated-secret',
      webhookEnabled: true,
      pollingEnabled: false,
      webhookRemoteId: 123,
      webhookUrl: 'https://example.com/webhook/github/space',
      webhookAutoRegistered: true,
      webhookActive: true,
    });

    await clientHub.request('space.github.watchRepo', {
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'manual-secret',
      webhookEnabled: true,
      pollingEnabled: false,
    });

    const stored = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
    expect(stored.webhookSecret).toBe('manual-secret');
    expect(stored.webhookRemoteId).toBeNull();
    expect(stored.webhookAutoRegistered).toBe(false);
    expect(stored.webhookActive).toBeNull();
    expect(calls.map((call) => `${call.init?.method ?? 'GET'} ${call.url}`)).toEqual([
      'DELETE https://api.github.com/repos/acme/widgets/hooks/123',
    ]);
    await extension.stop();
  });

  test('RPC watchRepo treats missing auto-hook as already cleaned up', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          statusText: 'Not Found',
        })) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'generated-secret',
      webhookEnabled: true,
      pollingEnabled: false,
      webhookRemoteId: 123,
      webhookUrl: 'https://example.com/webhook/github/space',
      webhookAutoRegistered: true,
      webhookActive: true,
    });

    await clientHub.request('space.github.watchRepo', {
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'manual-secret',
      webhookEnabled: true,
      pollingEnabled: false,
    });

    const stored = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
    expect(stored.webhookSecret).toBe('manual-secret');
    expect(stored.webhookRemoteId).toBeNull();
    expect(stored.webhookAutoRegistered).toBe(false);
    await extension.stop();
  });

  test('RPC unwatchRepo removes repo when remote auto-hook is already missing', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          statusText: 'Not Found',
        })) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
      webhookEnabled: true,
      pollingEnabled: false,
      webhookRemoteId: 123,
      webhookAutoRegistered: true,
      webhookActive: true,
    });

    const result = await clientHub.request<{ removed: boolean }>('space.github.unwatchRepo', {
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
    });

    expect(result.removed).toBe(true);
    expect(extension.repo.listWatchedRepos('space-1')).toHaveLength(0);
    await extension.stop();
  });

  test('RPC unwatchRepo preserves shared remote hook for remaining spaces', async () => {
    const db = setupDb();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: typeof url === 'string' || url instanceof URL ? String(url) : url.url,
          init,
        });
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    for (const spaceId of ['space-1', 'space-2']) {
      extension.repo.upsertWatchedRepo({
        spaceId,
        owner: 'acme',
        repo: 'widgets',
        webhookSecret: 'shared-secret',
        webhookEnabled: true,
        pollingEnabled: false,
        webhookRemoteId: 123,
        webhookUrl: 'https://example.com/webhook/github/space',
        webhookAutoRegistered: true,
        webhookActive: true,
      });
    }

    await clientHub.request('space.github.unwatchRepo', {
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
    });

    expect(calls).toHaveLength(0);
    expect(extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')).toBeNull();
    expect(extension.repo.getWatchedRepo('space-2', 'acme', 'widgets')?.webhookRemoteId).toBe(123);
    await extension.stop();
  });

  test('RPC watchRepo preserves shared remote hook on manual secret replacement', async () => {
    const db = setupDb();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: typeof url === 'string' || url instanceof URL ? String(url) : url.url,
          init,
        });
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    for (const spaceId of ['space-1', 'space-2']) {
      extension.repo.upsertWatchedRepo({
        spaceId,
        owner: 'acme',
        repo: 'widgets',
        webhookSecret: 'shared-secret',
        webhookEnabled: true,
        pollingEnabled: false,
        webhookRemoteId: 123,
        webhookUrl: 'https://example.com/webhook/github/space',
        webhookAutoRegistered: true,
        webhookActive: true,
      });
    }

    await clientHub.request('space.github.watchRepo', {
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'manual-secret',
      webhookEnabled: true,
      pollingEnabled: false,
    });

    expect(calls).toHaveLength(0);
    expect(extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')?.webhookAutoRegistered).toBe(
      false
    );
    expect(extension.repo.getWatchedRepo('space-2', 'acme', 'widgets')?.webhookRemoteId).toBe(123);
    await extension.stop();
  });

  test('RPC unwatchRepo keeps repo when auto-hook deletion fails', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: 'Resource not accessible by token' }), {
          status: 403,
          statusText: 'Forbidden',
        })) as typeof fetch,
    });
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
      webhookEnabled: true,
      pollingEnabled: false,
      webhookRemoteId: 123,
      webhookAutoRegistered: true,
      webhookActive: true,
    });

    await expect(
      clientHub.request('space.github.unwatchRepo', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      })
    ).rejects.toThrow(
      'GitHub token lacks permission to manage repository webhooks: Resource not accessible by token'
    );
    expect(extension.repo.listWatchedRepos('space-1')).toHaveLength(1);
    await extension.stop();
  });

  test('RPC unwatchRepo keeps repo when cleanup token is missing', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined);
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.registerRpcHandlers(hub, context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
      webhookEnabled: true,
      pollingEnabled: false,
      webhookRemoteId: 123,
      webhookAutoRegistered: true,
      webhookActive: true,
    });

    await expect(
      clientHub.request('space.github.unwatchRepo', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      })
    ).rejects.toThrow('GITHUB_TOKEN is required to delete GitHub webhooks');
    expect(extension.repo.listWatchedRepos('space-1')).toHaveLength(1);
    await extension.stop();
  });

  test('RPC autoConfigureWebhook reports missing token and GitHub permission errors clearly', async () => {
    const db = setupDb();
    const missingTokenExtension = new GitHubEventExtension(db, undefined);
    const clientHub = new MessageHub();
    const hub = new MessageHub();
    const [clientTransport, serverTransport] = InProcessTransport.createPair();
    clientHub.registerTransport(clientTransport);
    hub.registerTransport(serverTransport);
    await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    missingTokenExtension.registerRpcHandlers(hub, context);

    await expect(
      clientHub.request('space.github.autoConfigureWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      })
    ).rejects.toThrow('GITHUB_TOKEN is required to configure GitHub webhooks');

    const previousPublicUrl = process.env.NEOKAI_PUBLIC_URL;
    process.env.NEOKAI_PUBLIC_URL = 'https://example.com';
    const failingExtension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: 'Resource not accessible by token' }), {
          status: 403,
          statusText: 'Forbidden',
        })) as typeof fetch,
    });
    const failingHub = new MessageHub();
    const failingClientHub = new MessageHub();
    const [failingClientTransport, failingServerTransport] = InProcessTransport.createPair();
    failingClientHub.registerTransport(failingClientTransport);
    failingHub.registerTransport(failingServerTransport);
    await Promise.all([failingClientTransport.initialize(), failingServerTransport.initialize()]);
    failingExtension.registerRpcHandlers(failingHub, context);

    try {
      await expect(
        failingClientHub.request('space.github.autoConfigureWebhook', {
          spaceId: 'space-1',
          owner: 'acme',
          repo: 'widgets',
        })
      ).rejects.toThrow(
        'GitHub token lacks permission to manage repository webhooks: Resource not accessible by token'
      );
    } finally {
      if (previousPublicUrl === undefined) delete process.env.NEOKAI_PUBLIC_URL;
      else process.env.NEOKAI_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('polling publishes positive PR reactions with canonical reaction topic', async () => {
    const db = setupDb();
    const { service, received } = setupExternalEventService(db);
    const extension = new GitHubEventExtension(db, 'token');
    await extension.start({
      publisher: service,
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) return pollingResponse([createPullRequestRow(7)]);
      if (path.endsWith('/issues/7/reactions')) {
        return pollingResponse([createReactionRow({ id: 9001, content: '+1' })]);
      }
      return pollingResponse([]);
    }) as typeof fetch;

    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);

      expect(calls.some((url) => url.includes('/issues/7/reactions?per_page=100'))).toBe(true);
      const reaction = received.find((event) => event.payload.eventType === 'reaction')!;
      expect(reaction.topic).toBe('github/acme/widgets/pull_request/7.reaction_added');
      expect(reaction.dedupeKey).toBe('acme/widgets:reaction:9001');
      expect(reaction.payload).toMatchObject({
        type: 'reaction',
        content: '+1',
        user: 'codex[bot]',
        userType: 'Bot',
        createdAt: '2026-01-02T00:00:00Z',
        prNumber: 7,
        repo: 'acme/widgets',
      });
    } finally {
      await extension.stop();
    }
  });

  test('polling dedupes repeated reaction IDs', async () => {
    const db = setupDb();
    const { service, received } = setupExternalEventService(db);
    const extension = new GitHubEventExtension(db, 'token');
    await extension.start({
      publisher: service,
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) return pollingResponse([createPullRequestRow(7)]);
      if (path.endsWith('/issues/7/reactions')) {
        return pollingResponse([createReactionRow({ id: 9001, content: '+1' })]);
      }
      return pollingResponse([]);
    }) as typeof fetch;

    try {
      const repo = extension.repo.listPollingRepos()[0];
      await extension.pollWatchedRepo(repo, fetchImpl);
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);

      const storedReactionCount = db
        .prepare(
          `SELECT COUNT(*) AS count FROM space_external_events WHERE topic = 'github/acme/widgets/pull_request/7.reaction_added'`
        )
        .get() as { count: number };
      expect(storedReactionCount.count).toBe(1);
      expect(received.filter((event) => event.payload.eventType === 'reaction')).toHaveLength(1);
    } finally {
      await extension.stop();
    }
  });

  test('polling filters non-positive reactions', async () => {
    const db = setupDb();
    const { service, received } = setupExternalEventService(db);
    const extension = new GitHubEventExtension(db, 'token');
    await extension.start({
      publisher: service,
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) return pollingResponse([createPullRequestRow(7)]);
      if (path.endsWith('/issues/7/reactions')) {
        return pollingResponse([
          createReactionRow({ id: 1, content: '-1' }),
          createReactionRow({ id: 2, content: 'hooray' }),
          createReactionRow({ id: 3, content: 'thumbs_up' }),
        ]);
      }
      return pollingResponse([]);
    }) as typeof fetch;

    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);

      const reactions = received.filter((event) => event.payload.eventType === 'reaction');
      expect(reactions).toHaveLength(1);
      expect(reactions[0].payload.content).toBe('thumbs_up');
      expect(reactions[0].dedupeKey).toBe('acme/widgets:reaction:3');
    } finally {
      await extension.stop();
    }
  });

  test('polling skips reaction calls when GitHub rate limit remaining is low', async () => {
    const db = setupDb();
    const { service, received } = setupExternalEventService(db);
    const extension = new GitHubEventExtension(db, 'token');
    await extension.start({
      publisher: service,
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([], 99);
      if (path.endsWith('/pulls/comments')) return pollingResponse([], 99);
      if (path.endsWith('/pulls')) return pollingResponse([createPullRequestRow(7)], 99);
      if (path.endsWith('/issues/7/reactions')) {
        return pollingResponse([createReactionRow({ id: 9001, content: '+1' })], 99);
      }
      return pollingResponse([], 99);
    }) as typeof fetch;

    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);

      expect(calls.some((url) => url.includes('/issues/7/reactions'))).toBe(false);
      expect(received.some((event) => event.payload.eventType === 'reaction')).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('reaction polling targets the newest PRs when more than the limit are returned', async () => {
    const db = setupDb();
    const { service, received } = setupExternalEventService(db);
    const extension = new GitHubEventExtension(db, 'token');
    await extension.start({
      publisher: service,
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    const calledReactions: number[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        // Newest first (sort=updated&direction=desc). Return more than the
        // REACTION_POLL_PR_LIMIT (10) so the selection order is observable.
        const numbers = Array.from({ length: 15 }, (_, i) => 100 - i);
        return pollingResponse(numbers.map((n) => createPullRequestRow(n)));
      }
      const match = path.match(/\/issues\/(\d+)\/reactions$/);
      if (match) {
        calledReactions.push(Number(match[1]));
        return pollingResponse([createReactionRow({ id: Number(match[1]) * 100, content: '+1' })]);
      }
      return pollingResponse([]);
    }) as typeof fetch;

    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);

      // Only the newest 10 PRs (100..91) should be polled for reactions.
      expect(calledReactions).toEqual([100, 99, 98, 97, 96, 95, 94, 93, 92, 91]);
      expect(received.filter((event) => event.payload.eventType === 'reaction')).toHaveLength(10);
    } finally {
      await extension.stop();
    }
  });

  test('reaction polling suppresses stale reactions older than the poll watermark', async () => {
    const db = setupDb();
    const { service, received } = setupExternalEventService(db);
    const extension = new GitHubEventExtension(db, 'token');
    await extension.start({
      publisher: service,
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    // Seed a cursor with a committed watermark of 2026-06-01 so reactions
    // older than that are treated as historical backfill.
    const seeded = extension.repo.listPollingRepos()[0];
    extension.repo.updatePollCursor(seeded.id, {
      lastSeenAt: Date.parse('2026-06-01T00:00:00Z'),
      etags: {},
      processedPages: {},
    });
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) return pollingResponse([createPullRequestRow(7)]);
      if (path.endsWith('/issues/7/reactions')) {
        return pollingResponse([
          createReactionRow({ id: 1, content: '+1', created_at: '2026-05-01T00:00:00Z' }),
          createReactionRow({ id: 2, content: '+1', created_at: '2026-06-15T00:00:00Z' }),
        ]);
      }
      return pollingResponse([]);
    }) as typeof fetch;

    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);

      const published = received.filter((event) => event.payload.eventType === 'reaction');
      expect(published).toHaveLength(1);
      expect(published[0].dedupeKey).toBe('acme/widgets:reaction:2');
    } finally {
      await extension.stop();
    }
  });

  test('closed PRs do not occupy reaction-poll target slots', async () => {
    const db = setupDb();
    const { service } = setupExternalEventService(db);
    const extension = new GitHubEventExtension(db, 'token');
    await extension.start({
      publisher: service,
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    const calledReactions: number[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        // Newest-first; first 5 are closed, next 5 are open.
        const closed = Array.from({ length: 5 }, (_, i) => ({
          ...createPullRequestRow(100 - i),
          state: 'closed',
        }));
        const open = Array.from({ length: 5 }, (_, i) => createPullRequestRow(90 - i));
        return pollingResponse([...closed, ...open]);
      }
      const match = path.match(/\/issues\/(\d+)\/reactions$/);
      if (match) {
        calledReactions.push(Number(match[1]));
        return pollingResponse([]);
      }
      return pollingResponse([]);
    }) as typeof fetch;

    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      // Closed PRs (100..96) must be filtered out; only open PRs (90..86) polled.
      expect(calledReactions).toEqual([90, 89, 88, 87, 86]);
    } finally {
      await extension.stop();
    }
  });

  test('reaction polling caches ETags per PR and skips on 304', async () => {
    const db = setupDb();
    const { service, received } = setupExternalEventService(db);
    const extension = new GitHubEventExtension(db, 'token');
    await extension.start({
      publisher: service,
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    const reactionRequests: Array<{ url: string; ifNoneMatch?: string | null }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const path = u.pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) return pollingResponse([createPullRequestRow(7)]);
      const match = path.match(/\/issues\/(\d+)\/reactions$/);
      if (match) {
        const headers = init?.headers as Record<string, string> | undefined;
        reactionRequests.push({ url: String(url), ifNoneMatch: headers?.['If-None-Match'] });
        // Second poll for PR 7 sends the ETag from cycle 0 → return 304.
        if (headers?.['If-None-Match'] === 'W/"abc-reaction-7"') {
          return new Response(null, { status: 304 });
        }
        return new Response(JSON.stringify([createReactionRow({ id: 9001, content: '+1' })]), {
          status: 200,
          headers: { ETag: 'W/"abc-reaction-7"', 'X-RateLimit-Remaining': '5000' },
        });
      }
      return pollingResponse([]);
    }) as typeof fetch;

    try {
      const repo = extension.repo.listPollingRepos()[0];
      // Cycle 0: no ETag yet → full fetch, captures ETag, publishes the +1.
      await extension.pollWatchedRepo(repo, fetchImpl);
      expect(reactionRequests[0].ifNoneMatch).toBeUndefined();

      // Cycle 1: cursor carries the ETag → If-None-Match sent → 304 short-circuits,
      // no new reaction event published.
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(reactionRequests[1].ifNoneMatch).toBe('W/"abc-reaction-7"');
      expect(received.filter((event) => event.payload.eventType === 'reaction')).toHaveLength(1);
    } finally {
      await extension.stop();
    }
  });

  test('reaction targets merge deltas without dropping tracked active PRs', async () => {
    const db = setupDb();
    const { service } = setupExternalEventService(db);
    const extension = new GitHubEventExtension(db, 'token');
    await extension.start({
      publisher: service,
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    const pullsPages = [
      // Cycle 0 (first poll, full newest-first list): 15 PRs.
      Array.from({ length: 15 }, (_, i) => 100 - i),
    ];
    const calledReactions: number[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        const page = pullsPages.shift() ?? [];
        return pollingResponse(page.map((n) => createPullRequestRow(n)));
      }
      const match = path.match(/\/issues\/(\d+)\/reactions$/);
      if (match) {
        calledReactions.push(Number(match[1]));
        return pollingResponse([]);
      }
      return pollingResponse([]);
    }) as typeof fetch;

    try {
      const repo = extension.repo.listPollingRepos()[0];
      // Cycle 0: seed with newest 15 → targets capped to newest 10 ([100..91]).
      await extension.pollWatchedRepo(repo, fetchImpl);
      expect(calledReactions.slice()).toEqual([100, 99, 98, 97, 96, 95, 94, 93, 92, 91]);
      calledReactions.length = 0;

      // Cycle 1: delta poll — only PR 50 updated. Merge must surface 50 to the
      // front while retaining previously tracked active PRs (no replace-wipe).
      pullsPages.push([50]);
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(calledReactions.slice()).toEqual([50, 100, 99, 98, 97, 96, 95, 94, 93, 92]);
    } finally {
      await extension.stop();
    }
  });

  test('stop waits for an active polling cycle before returning', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, { pollIntervalMs: 1 });
    let releaseFetch!: () => void;
    let fetchStarted!: Promise<void>;
    let resolveFetchStarted!: () => void;
    fetchStarted = new Promise((resolve) => {
      resolveFetchStarted = resolve;
    });
    await extension.start({
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });

    let blocked = false;
    const pollPromise = extension.pollWatchedRepo(
      extension.repo.listPollingRepos()[0],
      (async () => {
        if (!blocked) {
          blocked = true;
          resolveFetchStarted();
          await new Promise<void>((resolve) => {
            releaseFetch = resolve;
          });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }) as typeof fetch
    );
    (extension as unknown as { activePollCycle: Promise<void> }).activePollCycle = pollPromise.then(
      () => {}
    );
    await fetchStarted;

    let stopped = false;
    const stopPromise = extension.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseFetch();
    await stopPromise;
    expect(stopped).toBe(true);
  });
});

class InMemoryCredentialStore {
  private map = new Map<string, string>();
  async get(service: string, account: string): Promise<string | null> {
    return this.map.get(`${service}:${account}`) ?? null;
  }
  async set(service: string, account: string, data: string): Promise<void> {
    this.map.set(`${service}:${account}`, data);
  }
  async delete(service: string, account: string): Promise<void> {
    this.map.delete(`${service}:${account}`);
  }
  async listServices(prefix: string): Promise<string[]> {
    const services = new Set<string>();
    for (const key of this.map.keys()) {
      const service = key.slice(0, key.lastIndexOf(':'));
      if (service.startsWith(prefix)) services.add(service);
    }
    return Array.from(services).sort();
  }
}

function setupHubPair() {
  const clientHub = new MessageHub();
  const hub = new MessageHub();
  const [clientTransport, serverTransport] = InProcessTransport.createPair();
  clientHub.registerTransport(clientTransport);
  hub.registerTransport(serverTransport);
  return {
    clientHub,
    hub,
    ready: Promise.all([clientTransport.initialize(), serverTransport.initialize()]),
  };
}

class RecordingConfigStore extends StaticExternalEventExtensionConfigStore {
  private globals = new Map<
    string,
    Awaited<ReturnType<StaticExternalEventExtensionConfigStore['getGlobalConfig']>>
  >();

  constructor(options: { globallyEnabled?: boolean; webhooks?: boolean; polling?: boolean }) {
    super(options);
  }

  override async getGlobalConfig(source: string) {
    const cached = this.globals.get(source);
    if (cached) return cached;
    const fresh = await super.getGlobalConfig(source);
    this.globals.set(source, fresh);
    return fresh;
  }

  override async setGlobalConfig(
    source: string,
    config: Awaited<ReturnType<StaticExternalEventExtensionConfigStore['getGlobalConfig']>>
  ): Promise<void> {
    this.globals.set(source, config);
  }
}

describe('GitHubEventExtension — credential store + token RPC', () => {
  test('space.github.setToken persists token via credential store', async () => {
    const db = setupDb();
    const store = new InMemoryCredentialStore();
    const extension = new GitHubEventExtension(db, undefined, { credentialStore: store });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      const result = await clientHub.request<{ success: boolean }>('space.github.setToken', {
        token: 'ghp_persisted_token_value',
      });
      expect(result.success).toBe(true);
      expect(await store.get('neokai.external-events.github', 'default')).toBe(
        'ghp_persisted_token_value'
      );
    } finally {
      await extension.stop();
    }
  });

  test('space.github.setToken rejects empty token without writing', async () => {
    const db = setupDb();
    const store = new InMemoryCredentialStore();
    const extension = new GitHubEventExtension(db, undefined, { credentialStore: store });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      await expect(clientHub.request('space.github.setToken', { token: '   ' })).rejects.toThrow(
        'token is required'
      );
      expect(await store.get('neokai.external-events.github', 'default')).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('space.github.setToken throws when credential store is not wired', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined);
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      await expect(
        clientHub.request('space.github.setToken', { token: 'ghp_secret' })
      ).rejects.toThrow('Credential store is not available for GitHub tokens');
    } finally {
      await extension.stop();
    }
  });

  test('space.github.setToken overwrites an existing keychain token', async () => {
    const db = setupDb();
    const store = new InMemoryCredentialStore();
    await store.set('neokai.external-events.github', 'default', 'ghp_old_token_value');
    const extension = new GitHubEventExtension(db, undefined, { credentialStore: store });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      await clientHub.request('space.github.setToken', { token: 'ghp_new_token_value' });
      expect(await store.get('neokai.external-events.github', 'default')).toBe(
        'ghp_new_token_value'
      );
    } finally {
      await extension.stop();
    }
  });

  test('space.github.setToken rejects tokens without a known GitHub prefix', async () => {
    const db = setupDb();
    const store = new InMemoryCredentialStore();
    const extension = new GitHubEventExtension(db, undefined, { credentialStore: store });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      await expect(
        clientHub.request('space.github.setToken', { token: 'not-a-github-token' })
      ).rejects.toThrow(/GitHub token must start with one of/);
      expect(await store.get('neokai.external-events.github', 'default')).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('space.github.setToken rejects tokens below the length floor', async () => {
    const db = setupDb();
    const store = new InMemoryCredentialStore();
    const extension = new GitHubEventExtension(db, undefined, { credentialStore: store });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      await expect(
        clientHub.request('space.github.setToken', { token: 'ghp_short' })
      ).rejects.toThrow(/GitHub token is too short/);
      expect(await store.get('neokai.external-events.github', 'default')).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('space.github.setToken accepts fine-grained PAT prefix', async () => {
    const db = setupDb();
    const store = new InMemoryCredentialStore();
    const extension = new GitHubEventExtension(db, undefined, { credentialStore: store });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      await clientHub.request('space.github.setToken', {
        token: 'github_pat_long_finegrained_token_value',
      });
      expect(await store.get('neokai.external-events.github', 'default')).toBe(
        'github_pat_long_finegrained_token_value'
      );
    } finally {
      await extension.stop();
    }
  });

  test('space.github.clearToken throws when credential store is not wired', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined);
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      await expect(clientHub.request('space.github.clearToken', {})).rejects.toThrow(
        'Credential store is not available for GitHub tokens'
      );
    } finally {
      await extension.stop();
    }
  });

  test('space.github.clearToken removes stored token', async () => {
    const db = setupDb();
    const store = new InMemoryCredentialStore();
    await store.set('neokai.external-events.github', 'default', 'ghp_secret');
    const extension = new GitHubEventExtension(db, undefined, { credentialStore: store });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      await clientHub.request('space.github.clearToken', {});
      expect(await store.get('neokai.external-events.github', 'default')).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('space.github.getTokenStatus reports login when keychain token validates', async () => {
    const db = setupDb();
    const store = new InMemoryCredentialStore();
    await store.set('neokai.external-events.github', 'default', 'ghp_keychain');
    const seenAuth = new Set<string>();
    const extension = new GitHubEventExtension(db, 'env-fallback-token', {
      credentialStore: store,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        if (auth) seenAuth.add(auth);
        if (String(url).endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      }) as typeof fetch,
    });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      const status = await clientHub.request<{
        configured: boolean;
        source: string;
        login?: string;
        autoRegisteredHookCount?: number;
      }>('space.github.getTokenStatus', {});
      expect(status.configured).toBe(true);
      expect(status.source).toBe('keychain');
      expect(status.login).toBe('octocat');
      expect(status.autoRegisteredHookCount).toBe(0);
      expect([...seenAuth]).toEqual(['Bearer ghp_keychain']);
    } finally {
      await extension.stop();
    }
  });

  test('space.github.getTokenStatus falls back to env var and tags source', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_env', {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ login: 'env-user' }), { status: 200 })) as typeof fetch,
    });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      const status = await clientHub.request<{
        configured: boolean;
        source: string;
        login?: string;
        autoRegisteredHookCount?: number;
      }>('space.github.getTokenStatus', {});
      expect(status).toEqual({
        configured: true,
        source: 'env',
        login: 'env-user',
        autoRegisteredHookCount: 0,
      });
    } finally {
      await extension.stop();
    }
  });

  test('space.github.getTokenStatus reports unconfigured when no token available', async () => {
    const db = setupDb();
    let fetchCalled = false;
    const extension = new GitHubEventExtension(db, undefined, {
      fetchImpl: (async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      const status = await clientHub.request<{
        configured: boolean;
        source: string;
        autoRegisteredHookCount?: number;
      }>('space.github.getTokenStatus', {});
      expect(status).toEqual({ configured: false, source: 'none', autoRegisteredHookCount: 0 });
      expect(fetchCalled).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('space.github.getTokenStatus surfaces validation errors on configured token', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'ghp_env', {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: 'Bad credentials' }), {
          status: 401,
        })) as typeof fetch,
    });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      const status = await clientHub.request<{
        configured: boolean;
        source: string;
        error?: string;
        autoRegisteredHookCount?: number;
      }>('space.github.getTokenStatus', {});
      expect(status.configured).toBe(true);
      expect(status.source).toBe('env');
      expect(status.error).toBe('HTTP 401');
      expect(status.autoRegisteredHookCount).toBe(0);
    } finally {
      await extension.stop();
    }
  });

  test('space.github.getTokenStatus falls back to env when credential store read throws', async () => {
    const db = setupDb();
    const store = new InMemoryCredentialStore();
    store.get = async () => {
      throw new Error('keychain locked');
    };
    const extension = new GitHubEventExtension(db, 'ghp_env', {
      credentialStore: store,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ login: 'env-user' }), { status: 200 })) as typeof fetch,
    });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      const status = await clientHub.request<{
        configured: boolean;
        source: string;
        login?: string;
        error?: string;
        autoRegisteredHookCount?: number;
      }>('space.github.getTokenStatus', {});
      expect(status).toMatchObject({
        configured: true,
        source: 'env',
        login: 'env-user',
        autoRegisteredHookCount: 0,
      });
      expect(status.error).toBeUndefined();
    } finally {
      await extension.stop();
    }
  });

  test('space.github.getTokenStatus reports keychain error when store read throws and no env token exists', async () => {
    const db = setupDb();
    const store = new InMemoryCredentialStore();
    store.get = async () => {
      throw new Error('keychain locked');
    };
    const extension = new GitHubEventExtension(db, undefined, { credentialStore: store });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      const status = await clientHub.request<{
        configured: boolean;
        source: string;
        error?: string;
        autoRegisteredHookCount?: number;
      }>('space.github.getTokenStatus', {});
      expect(status).toMatchObject({
        configured: false,
        source: 'none',
        autoRegisteredHookCount: 0,
      });
      expect(status.error).toContain('keychain locked');
    } finally {
      await extension.stop();
    }
  });

  test('space.github.clearToken returns daemon-wide auto-registered hook count', async () => {
    const db = setupDb();
    const store = new InMemoryCredentialStore();
    await store.set('neokai.external-events.github', 'default', 'ghp_secret');
    const extension = new GitHubEventExtension(db, undefined, { credentialStore: store });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        webhookAutoRegistered: true,
        webhookRemoteId: 123,
      });
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-2',
        owner: 'acme',
        repo: 'other',
        webhookAutoRegistered: true,
        webhookRemoteId: 456,
      });

      const result = await clientHub.request<{
        success: boolean;
        autoRegisteredHookCount?: number;
      }>('space.github.clearToken', {});
      expect(result.success).toBe(true);
      expect(result.autoRegisteredHookCount).toBe(2);
    } finally {
      await extension.stop();
    }
  });

  test('token RPCs respect globally disabled extension', async () => {
    const db = setupDb();
    const store = new InMemoryCredentialStore();
    const extension = new GitHubEventExtension(db, undefined, { credentialStore: store });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: false }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      await expect(
        clientHub.request('space.github.setToken', { token: 'ghp_secret' })
      ).rejects.toThrow('GitHub RPC configuration capability is disabled');
      expect(await store.get('neokai.external-events.github', 'default')).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('resolveToken prefers credential store over env var when fetching', async () => {
    const db = setupDb();
    const store = new InMemoryCredentialStore();
    await store.set('neokai.external-events.github', 'default', 'ghp_keychain');
    const seenAuth: string[] = [];
    const extension = new GitHubEventExtension(db, 'ghp_env_fallback', {
      credentialStore: store,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        if (auth) seenAuth.push(auth);
        if (String(url).endsWith('/hooks')) {
          return new Response(
            JSON.stringify({
              id: 1,
              active: true,
              config: { url: 'https://example.com/webhook/github/space', content_type: 'json' },
            }),
            { status: 201 }
          );
        }
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const previousPublicUrl = process.env.NEOKAI_PUBLIC_URL;
    process.env.NEOKAI_PUBLIC_URL = 'https://example.com';
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);

      await clientHub.request('space.github.autoConfigureWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });

      expect(seenAuth).toContain('Bearer ghp_keychain');
      expect(seenAuth).not.toContain('Bearer ghp_env_fallback');
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.NEOKAI_PUBLIC_URL;
      else process.env.NEOKAI_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('watchRepo auto-starts polling when first polling-enabled repo is added', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, { pollIntervalMs: 60_000 });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new RecordingConfigStore({ globallyEnabled: true, polling: false }),
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      const internals = extension as unknown as { pollTimer: { ref?: () => void } | null };
      expect(internals.pollTimer).toBeNull();

      extension.registerRpcHandlers(hub, context);
      await clientHub.request('space.github.watchRepo', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        pollingEnabled: true,
      });

      expect(internals.pollTimer).not.toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('watchRepo persists polling intent when a row is enabled for polling', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, { pollIntervalMs: 60_000 });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const configStore = new RecordingConfigStore({ globallyEnabled: true, polling: true });
    const context = {
      publisher: { publish: async () => {} },
      config: configStore,
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);
      // Daemon-wide polling is already on from another space; enabling polling
      // on a repo in this space must still record the per-space intent so the
      // connection card checkbox and no-secret addRepo default work correctly.
      await clientHub.request('space.github.watchRepo', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        pollingEnabled: true,
      });

      expect(extension.repo.getPollingIntent('space-1')).toBe(true);
      const persisted = await configStore.getSpaceConfig('space-1', 'github');
      expect((persisted?.settings as { pollingIntent?: boolean }).pollingIntent).toBe(true);
    } finally {
      await extension.stop();
    }
  });

  test('runPollCycle stops the timer when no polling repos remain', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, { pollIntervalMs: 60_000 });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);
      const internals = extension as unknown as {
        pollTimer: { ref?: () => void } | null;
        runPollCycle: () => Promise<void>;
      };

      await clientHub.request('space.github.watchRepo', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        pollingEnabled: true,
      });
      expect(internals.pollTimer).not.toBeNull();

      await clientHub.request('space.github.unwatchRepo', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });
      await internals.runPollCycle();

      expect(internals.pollTimer).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('space.github.setPollingEnabled flips global capability and starts timer', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, { pollIntervalMs: 60_000 });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const configStore = new RecordingConfigStore({
      globallyEnabled: true,
      polling: false,
    });
    const context = {
      publisher: { publish: async () => {} },
      config: configStore,
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);
      const internals = extension as unknown as { pollTimer: unknown };
      expect(internals.pollTimer).toBeNull();

      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        pollingEnabled: false,
      });

      const result = await clientHub.request<{
        pollingEnabled: boolean;
      }>('space.github.setPollingEnabled', { spaceId: 'space-1', enabled: true });

      expect(result.pollingEnabled).toBe(true);
      const global = await configStore.getGlobalConfig('github');
      expect(global.capabilities.polling).toBe(true);
      expect(extension.repo.listWatchedRepos('space-1')[0].pollingEnabled).toBe(true);
      expect(internals.pollTimer).not.toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('space.github.setPollingEnabled false clears the timer when no polling repos remain', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, { pollIntervalMs: 60_000 });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);

      await clientHub.request('space.github.watchRepo', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        pollingEnabled: true,
      });
      const internals = extension as unknown as { pollTimer: unknown };
      expect(internals.pollTimer).not.toBeNull();

      await clientHub.request('space.github.setPollingEnabled', {
        spaceId: 'space-1',
        enabled: false,
      });

      expect(extension.repo.listWatchedRepos('space-1')[0].pollingEnabled).toBe(false);
      expect(internals.pollTimer).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('space.github.setPollingEnabled(false) flips the global capability off when no polling repos remain', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, { pollIntervalMs: 60_000 });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const configStore = new RecordingConfigStore({ globallyEnabled: true, polling: true });
    const context = {
      publisher: { publish: async () => {} },
      config: configStore,
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        pollingEnabled: true,
      });

      await clientHub.request('space.github.setPollingEnabled', {
        spaceId: 'space-1',
        enabled: false,
      });

      const global = await configStore.getGlobalConfig('github');
      expect(global.capabilities.polling).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('space.github.setPollingEnabled persists per-space intent independent of polling rows', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, { pollIntervalMs: 60_000 });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const configStore = new RecordingConfigStore({ globallyEnabled: true, polling: false });
    const context = {
      publisher: { publish: async () => {} },
      config: configStore,
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);
      // No watched repos at all — first-time setup. Enabling polling must
      // still persist intent so the UI checkbox stays checked and the next
      // no-secret addRepo defaults to polling.
      expect(extension.repo.getPollingIntent('space-1')).toBe(false);

      await clientHub.request('space.github.setPollingEnabled', {
        spaceId: 'space-1',
        enabled: true,
      });

      expect(extension.repo.getPollingIntent('space-1')).toBe(true);
      const persisted = await configStore.getSpaceConfig('space-1', 'github');
      expect((persisted?.settings as { pollingIntent?: boolean }).pollingIntent).toBe(true);

      await clientHub.request('space.github.setPollingEnabled', {
        spaceId: 'space-1',
        enabled: false,
      });
      expect(extension.repo.getPollingIntent('space-1')).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('space.github.setPollingEnabled(true) skips repos with webhook delivery configured (manual or auto)', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, { pollIntervalMs: 60_000 });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const configStore = new RecordingConfigStore({ globallyEnabled: true, polling: false });
    const context = {
      publisher: { publish: async () => {} },
      config: configStore,
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'webhook-active-auto',
        webhookEnabled: true,
        webhookSecret: 'configured-secret',
        webhookActive: true,
        pollingEnabled: false,
      });
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'webhook-manual-inactive',
        webhookEnabled: true,
        webhookSecret: 'manual-secret',
        webhookActive: null,
        pollingEnabled: false,
      });
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'polling-repo',
        webhookEnabled: false,
        pollingEnabled: false,
      });

      await clientHub.request('space.github.setPollingEnabled', {
        spaceId: 'space-1',
        enabled: true,
      });

      const repos = extension.repo.listWatchedRepos('space-1');
      const activeRepo = repos.find((r) => r.repo === 'webhook-active-auto')!;
      const manualRepo = repos.find((r) => r.repo === 'webhook-manual-inactive')!;
      const pollingRepo = repos.find((r) => r.repo === 'polling-repo')!;
      expect(activeRepo.pollingEnabled).toBe(false);
      expect(manualRepo.pollingEnabled).toBe(false);
      expect(pollingRepo.pollingEnabled).toBe(true);
    } finally {
      await extension.stop();
    }
  });

  test('space.github.enable restarts polling capability for previously-disabled spaces', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, { pollIntervalMs: 60_000 });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const configStore = new RecordingConfigStore({ globallyEnabled: true, polling: true });
    const context = {
      publisher: { publish: async () => {} },
      config: configStore,
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);
      // Add a polling-enabled repo, then disable the space. Disabling drops
      // it from listPollingRepos (which filters enabled=1), so a naive
      // capability check would flip polling off — but the polling-configured
      // row still exists.
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        pollingEnabled: true,
      });
      await clientHub.request('space.github.disable', { spaceId: 'space-1' });
      // Force capability off manually to simulate the daemon-wide clearing
      // path that disablePollingCapabilityIfUnused would have triggered if
      // listPollingRepos was the source of truth.
      const globalBefore = await configStore.getGlobalConfig('github');
      await configStore.setGlobalConfig('github', {
        ...globalBefore,
        capabilities: { ...globalBefore.capabilities, polling: false },
      });

      await clientHub.request('space.github.enable', { spaceId: 'space-1' });

      const globalAfter = await configStore.getGlobalConfig('github');
      expect(globalAfter.capabilities.polling).toBe(true);
      const internals = extension as unknown as { pollTimer: unknown };
      expect(internals.pollTimer).not.toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('disablePollingCapabilityIfUnused honors persisted polling intent when the last polling row disappears', async () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO spaces (id, slug, name, workspace_path, status, created_at, updated_at) VALUES ('space-1', 'space-1', 'Space', '/tmp', 'active', 1, 1)`
    ).run();
    const extension = new GitHubEventExtension(db, undefined, { pollIntervalMs: 60_000 });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const configStore = new RecordingConfigStore({ globallyEnabled: true, polling: true });
    const context = {
      publisher: { publish: async () => {} },
      config: configStore,
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);
      // Enable polling intent for the space (no rows yet).
      await clientHub.request('space.github.setPollingEnabled', {
        spaceId: 'space-1',
        enabled: true,
      });
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        pollingEnabled: true,
      });
      // Remove the only polling row. Intent stays on, so capability must
      // stay on even though listAllPollingConfiguredRepos is now empty.
      await clientHub.request('space.github.unwatchRepo', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });

      const global = await configStore.getGlobalConfig('github');
      expect(global.capabilities.polling).toBe(true);

      // User explicitly disables polling intent — capability now drops.
      await clientHub.request('space.github.setPollingEnabled', {
        spaceId: 'space-1',
        enabled: false,
      });
      const after = await configStore.getGlobalConfig('github');
      expect(after.capabilities.polling).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('constructor backfills polling intent from existing polling-enabled repos', async () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO spaces (id, slug, name, workspace_path, status, created_at, updated_at) VALUES ('space-1', 'space-1', 'Space', '/tmp', 'active', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO space_github_watched_repos
       (id, space_id, owner, repo, enabled, webhook_enabled, polling_enabled, webhook_secret,
        webhook_remote_id, webhook_url, webhook_auto_registered, webhook_active,
        webhook_last_checked_at, webhook_last_error, webhook_configured_at, created_at, updated_at)
       VALUES (?, 'space-1', 'acme', 'widgets', 1, 1, 1, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 1, 1)`
    ).run('repo-1');

    const extension = new GitHubEventExtension(db);
    expect(extension.repo.getPollingIntent('space-1')).toBe(true);
    await extension.stop();
  });

  test('countSpacesWithPollingIntent ignores intent from deleted spaces', async () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO spaces (id, slug, name, workspace_path, status, created_at, updated_at) VALUES ('space-1', 'space-1', 'Space', '/tmp', 'active', 1, 1)`
    ).run();
    const extension = new GitHubEventExtension(db);
    extension.repo.setPollingIntent('space-1', true);
    expect(extension.repo.countSpacesWithPollingIntent()).toBe(1);

    db.prepare('DELETE FROM spaces WHERE id = ?').run('space-1');
    expect(extension.repo.countSpacesWithPollingIntent()).toBe(0);
    await extension.stop();
  });

  test('listAllPollingConfiguredRepos ignores rows from deleted spaces', async () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO spaces (id, slug, name, workspace_path, status, created_at, updated_at) VALUES ('space-1', 'space-1', 'Space', '/tmp', 'active', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO space_github_watched_repos
       (id, space_id, owner, repo, enabled, webhook_enabled, polling_enabled, webhook_secret,
        webhook_remote_id, webhook_url, webhook_auto_registered, webhook_active,
        webhook_last_checked_at, webhook_last_error, webhook_configured_at, created_at, updated_at)
       VALUES (?, 'space-1', 'acme', 'widgets', 1, 1, 1, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 1, 1)`
    ).run('repo-1');

    const extension = new GitHubEventExtension(db);
    expect(extension.repo.listAllPollingConfiguredRepos()).toHaveLength(1);

    db.prepare('DELETE FROM spaces WHERE id = ?').run('space-1');
    expect(extension.repo.listAllPollingConfiguredRepos()).toHaveLength(0);
    await extension.stop();
  });

  test('space.github.watchRepo clears the global polling capability when the last polling row is turned off', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, { pollIntervalMs: 60_000 });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const configStore = new RecordingConfigStore({ globallyEnabled: true, polling: true });
    const context = {
      publisher: { publish: async () => {} },
      config: configStore,
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);
      await clientHub.request('space.github.watchRepo', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        pollingEnabled: true,
      });
      expect((await configStore.getGlobalConfig('github')).capabilities.polling).toBe(true);

      await clientHub.request('space.github.watchRepo', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        pollingEnabled: false,
        webhookEnabled: true,
        webhookSecret: 'manual-secret',
      });

      expect((await configStore.getGlobalConfig('github')).capabilities.polling).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('unwatchRepo clears the global polling capability when the last polling repo goes away', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, { pollIntervalMs: 60_000 });
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const configStore = new RecordingConfigStore({ globallyEnabled: true, polling: true });
    const context = {
      publisher: { publish: async () => {} },
      config: configStore,
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        pollingEnabled: true,
      });

      await clientHub.request('space.github.unwatchRepo', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });

      const global = await configStore.getGlobalConfig('github');
      expect(global.capabilities.polling).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('space.github.setPollingEnabled requires spaceId and enabled flag', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined);
    const { clientHub, hub, ready } = setupHubPair();
    await ready;
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      extension.registerRpcHandlers(hub, context);

      await expect(
        clientHub.request('space.github.setPollingEnabled', { spaceId: 'space-1' })
      ).rejects.toThrow('spaceId and enabled are required');
    } finally {
      await extension.stop();
    }
  });
});
