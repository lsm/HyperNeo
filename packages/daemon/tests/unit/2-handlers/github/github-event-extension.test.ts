import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { InProcessTransport, MessageHub } from '@hyperneo/shared';
import { describe, expect, test } from 'bun:test';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import {
  ExternalEventService,
  ExternalEventStore,
  type ExternalEvent,
} from '../../../../src/lib/external-events';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github';
import { syncGitHubPollingCapability } from '../../../../src/app';
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
  if (event === 'pull_request_review_thread') {
    return {
      action: 'resolved',
      repository: baseRepo,
      sender: { login: 'reviewer', type: 'User' },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/acme/widgets/pull/7',
        user: { login: 'dev', type: 'User' },
        updated_at: '2026-01-01T00:00:00Z',
      },
      thread: {
        node_id: 'PRRT_kwAAA_thread',
        comments: [
          {
            id: 4242,
            node_id: 'PRRC_kwAAA_root',
            body: 'nit: rename this',
            path: 'src/file.ts',
            line: 12,
            html_url: 'https://github.com/acme/widgets/pull/7#discussion_r4242',
            user: { login: 'reviewer', type: 'User' },
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
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

function checkRunPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'completed',
    repository: baseRepo,
    sender: { login: 'github-actions[bot]', type: 'Bot' },
    check_run: {
      id: 987,
      name: 'daemon unit tests',
      conclusion: 'failure',
      html_url: 'https://github.com/acme/widgets/runs/987',
      completed_at: '2026-01-01T00:00:00Z',
      pull_requests: [{ number: 7, url: 'https://api.github.com/repos/acme/widgets/pulls/7' }],
    },
    ...overrides,
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

function pollingResponse(body: unknown[] | Record<string, unknown>, remaining = 5_000): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'X-RateLimit-Remaining': String(remaining) },
  });
}

function pollingResponseWithHeaders(
  body: unknown[] | Record<string, unknown>,
  headers: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'X-RateLimit-Remaining': '5000', ...headers },
  });
}

function createPullRequestRow(
  number: number,
  overrides: Partial<{
    state: string;
    head: { sha: string; repo?: { owner?: { login?: string }; name?: string } };
    updated_at: string;
  }> = {}
): Record<string, unknown> {
  return {
    id: number * 10,
    number,
    state: 'open',
    title: `PR ${number}`,
    body: `Body ${number}`,
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    head: { sha: 'abc123' },
    user: { login: 'dev', type: 'User' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
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

function createCheckRunRow(
  overrides: Partial<{
    id: number;
    name: string;
    status: string;
    conclusion: string;
    head_sha: string;
    html_url: string;
    completed_at: string;
    updated_at: string;
    pull_requests: Array<{ number: number }>;
  }> = {}
): Record<string, unknown> {
  return {
    id: 7001,
    name: 'unit tests',
    status: 'completed',
    conclusion: 'failure',
    head_sha: 'abc123',
    html_url: 'https://github.com/acme/widgets/actions/runs/1/job/7001',
    completed_at: '2099-01-03T00:00:00Z',
    pull_requests: [{ number: 7 }],
    app: { login: 'github-actions', type: 'Bot' },
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

  test('normalizes failed check_run webhooks to check_failed topics', () => {
    const normalized = normalizeGitHubWebhook('check_run', 'delivery-1', checkRunPayload())!;
    expect(normalized.eventType).toBe('check_run');
    expect(normalized.action).toBe('completed');
    expect(normalized.prNumber).toBe(7);
    expect(mapEventType(normalized.eventType, normalized.action, normalized.entityId)).toEqual({
      resource: 'pull_request',
      entityId: '7',
      action: 'check_failed',
    });

    const event = toExternalEvent('space-1', normalized);
    expect(event.topic).toBe('github/acme/widgets/pull_request/7.check_failed');
    expect(event.payload.checkName).toBe('daemon unit tests');
    expect(event.payload.conclusion).toBe('failure');
    expect(event.payload.runUrl).toBe('https://github.com/acme/widgets/runs/987');
  });

  test('drops successful check_run webhooks', () => {
    for (const conclusion of ['success', 'skipped', 'neutral']) {
      const payload = checkRunPayload({
        check_run: { ...checkRunPayload().check_run, conclusion },
      });
      expect(normalizeGitHubWebhook('check_run', 'delivery-1', payload)).toBeNull();
    }
  });

  test('normalizes non-success check_run conclusions as failures', () => {
    for (const conclusion of ['stale', 'startup_failure']) {
      const payload = checkRunPayload({
        check_run: { ...checkRunPayload().check_run, conclusion },
      });
      const normalized = normalizeGitHubWebhook('check_run', 'delivery-1', payload)!;
      expect(normalized.payload?.conclusion).toBe(conclusion);
      expect(
        mapEventType(normalized.eventType, normalized.action, normalized.entityId).action
      ).toBe('check_failed');
    }
  });

  test('drops non-completed check_run webhooks', () => {
    expect(
      normalizeGitHubWebhook('check_run', 'delivery-1', checkRunPayload({ action: 'created' }))
    ).toBeNull();
    expect(
      normalizeGitHubWebhook('check_run', 'delivery-1', checkRunPayload({ action: 'rerequested' }))
    ).toBeNull();
  });

  test('drops check_run webhooks without pull requests', () => {
    const payload = checkRunPayload({
      check_run: { ...checkRunPayload().check_run, pull_requests: [] },
    });
    expect(normalizeGitHubWebhook('check_run', 'delivery-1', payload)).toBeNull();
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

  test('webhook delivers pull_request_review_thread as a .thread_resolved event', async () => {
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

    const payload = payloadFor('pull_request_review_thread');
    const raw = JSON.stringify(payload);
    const ok = await extension.routes[0].handle(
      webhookRequest(payload, 'pull_request_review_thread', await createSignature(raw, 'secret'))
    );
    expect(ok.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].topic).toBe('github/acme/widgets/pull_request/7.thread_resolved');
    // The thread node id captured from the payload powers resolve actions downstream.
    expect(received[0].payload.resolveHandle).toEqual({
      kind: 'pull_request_review_thread',
      threadId: 'PRRT_kwAAA_thread',
    });

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
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
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
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('RPC autoConfigureWebhook creates GitHub hook and stores masked metadata', async () => {
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
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
        'pull_request_review_thread',
        'check_run',
        'status',
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
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('concurrent re-registration of a shared hook serializes per remote hook', async () => {
    // Two Spaces sharing one auto-managed hook (same owner/repo) re-register
    // concurrently. Without per-hook serialization each call generates its own
    // secret and PATCHes the same hook, and the remote mutation + DB write can
    // complete out of order, leaving the DB secret out of sync with GitHub's.
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    let inFlight = 0;
    let maxInFlight = 0;
    let lastPatchedSecret: string | undefined;
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        // Track overlap on the mutating webhook-config requests (POST /hooks,
        // PATCH /hooks/{id}). A small delay forces overlap when not serialized.
        if (/\/hooks(\/\d+)?$/.test(u) && init?.method && init.method !== 'GET') {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 20));
          inFlight--;
          if (init.body) {
            try {
              const body = JSON.parse(String(init.body)) as { config?: { secret?: string } };
              if (body.config?.secret) lastPatchedSecret = body.config.secret;
            } catch {
              /* ignore non-JSON bodies */
            }
          }
        }
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
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);
      // Establish the shared hook under space-1 (POST /hooks → id 123).
      await clientHub.request('space.github.autoConfigureWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });
      // Re-register the SAME hook from two Spaces concurrently (both PATCH /hooks/123).
      maxInFlight = 0;
      await Promise.all([
        clientHub.request('space.github.autoConfigureWebhook', {
          spaceId: 'space-1',
          owner: 'acme',
          repo: 'widgets',
        }),
        clientHub.request('space.github.autoConfigureWebhook', {
          spaceId: 'space-2',
          owner: 'acme',
          repo: 'widgets',
        }),
      ]);
      // The two PATCHes of the same remote hook must not overlap.
      expect(maxInFlight).toBe(1);
      // Both sharing Spaces end with the same secret, matching GitHub's last PATCH.
      const s1 = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      const s2 = extension.repo.getWatchedRepo('space-2', 'acme', 'widgets');
      expect(s2).toBeTruthy();
      expect(s1.webhookSecret).toBe(lastPatchedSecret);
      expect(s2!.webhookSecret).toBe(lastPatchedSecret);
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('concurrent re-registration serializes across owner/repo casing differences', async () => {
    // The shared hook identity is case-insensitive (queries use lower(owner)/
    // lower(repo)), so `acme/widgets` and `ACME/Widgets` share one remote hook.
    // The serialization key must be normalized to lowercase too, or the two
    // re-registrations get separate queues and still race the same hook.
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    let inFlight = 0;
    let maxInFlight = 0;
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        if (/\/hooks(\/\d+)?$/.test(u) && init?.method && init.method !== 'GET') {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 20));
          inFlight--;
        }
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
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);
      // Establish the shared hook under space-1 (lowercase).
      await clientHub.request('space.github.autoConfigureWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });
      // Re-register concurrently with DIFFERENT casing — same remote hook.
      maxInFlight = 0;
      await Promise.all([
        clientHub.request('space.github.autoConfigureWebhook', {
          spaceId: 'space-1',
          owner: 'acme',
          repo: 'widgets',
        }),
        clientHub.request('space.github.autoConfigureWebhook', {
          spaceId: 'space-2',
          owner: 'ACME',
          repo: 'Widgets',
        }),
      ]);
      expect(maxInFlight).toBe(1);
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('webhook deletion serializes with concurrent re-registration of the same hook', async () => {
    // unwatchRepo's DELETE and autoConfigureWebhook's PATCH/POST of the same
    // remote hook must serialize. Without the lock they can interleave — a
    // DELETE racing a PATCH can leave a DB row pointing at a deleted hook, or the
    // count check can read 1 before a concurrent upsert adds a second ref.
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    let inFlight = 0;
    let maxInFlight = 0;
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        if (/\/hooks(\/\d+)?$/.test(u) && init?.method && init.method !== 'GET') {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 20));
          inFlight--;
          if (init.method === 'DELETE') return new Response(null, { status: 204 });
        }
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
    // Space-1 owns the only reference to auto-hook 123 (count = 1 → unwatch deletes).
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
      webhookAutoRegistered: true,
      webhookActive: true,
      webhookRemoteId: 123,
      webhookSecret: 'secret-0',
      webhookUrl: 'https://example.com/webhook/github/space',
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
      // Concurrent: unwatch (DELETE 123) and re-register (PATCH 123) the same hook.
      await Promise.allSettled([
        clientHub.request('space.github.unwatchRepo', {
          spaceId: 'space-1',
          owner: 'acme',
          repo: 'widgets',
        }),
        clientHub.request('space.github.autoConfigureWebhook', {
          spaceId: 'space-1',
          owner: 'acme',
          repo: 'widgets',
        }),
      ]);
      expect(maxInFlight).toBe(1);
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('unwatchRepo deletes the current hook after a queued re-registration replaces it', async () => {
    // unwatchRepo must RE-READ the watched row inside the lock callback. It
    // captures nothing before the lock waits, so when a prior queued
    // re-registration has replaced hook H1 (remoteId 1) with H2 (remoteId 2),
    // the DELETE targets the CURRENT H2 — not the stale H1, which would orphan
    // H2. This holds the re-registration's PATCH behind a gate, queues unwatchRepo
    // behind it, then asserts unwatch deletes H2.
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    let deletedRemoteId: number | null = null;
    let resolvePatch: () => void = () => {};
    const patchGate = new Promise<void>((resolve) => {
      resolvePatch = resolve;
    });
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        if (/\/hooks\/1$/.test(u) && init?.method === 'PATCH') {
          await patchGate; // hold the re-registration so unwatch queues behind it
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        }
        if (/\/hooks\/(\d+)$/.test(u) && init?.method === 'DELETE') {
          deletedRemoteId = Number(u.match(/\/hooks\/(\d+)$/)?.[1]);
          return new Response(null, { status: 204 });
        }
        // POST (re-registration after the 404) creates a new hook H2 (id 2).
        return new Response(
          JSON.stringify({
            id: 2,
            active: true,
            config: { url: 'https://example.com/webhook/github/space', content_type: 'json' },
          }),
          { status: 200 }
        );
      }) as typeof fetch,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
      webhookAutoRegistered: true,
      webhookActive: true,
      webhookRemoteId: 1,
      webhookSecret: 'secret-0',
      webhookUrl: 'https://example.com/webhook/github/space',
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
      // Re-registration acquires the lock and blocks on the gated PATCH of H1.
      const reconfigP = clientHub.request('space.github.autoConfigureWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });
      await new Promise((r) => setTimeout(r, 10));
      // Queue unwatchRepo behind the held lock.
      const unwatchP = clientHub.request('space.github.unwatchRepo', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });
      await new Promise((r) => setTimeout(r, 10));
      // Release: PATCH 404 → POST H2 (id 2) → row now references H2 → lock frees.
      resolvePatch();
      await Promise.allSettled([reconfigP, unwatchP]);
      // unwatch deleted the CURRENT hook (H2, id 2), not the stale H1 (id 1).
      expect(deletedRemoteId).toBe(2);
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('checkWebhook preserves a concurrent "update uncertain" error recorded during its GET', async () => {
    // checkWebhook must re-read the row's CURRENT error after the GET. A slow GET
    // can overlap a re-registration whose PATCH timed out and recorded "update
    // uncertain"; using the error captured before the GET would clear it, even
    // though a GET cannot verify which secret GitHub retained.
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    let resolveGet: () => void = () => {};
    const getGate = new Promise<void>((resolve) => {
      resolveGet = resolve;
    });
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        // Gate the checkWebhook GET so the concurrent error lands mid-flight.
        if (/\/hooks\/1$/.test(u) && (!init?.method || init.method === 'GET')) {
          await getGate;
        }
        return new Response(
          JSON.stringify({
            id: 1,
            active: true,
            config: { url: 'https://example.com/webhook/github/space', content_type: 'json' },
            events: ['*'],
          }),
          { status: 200 }
        );
      }) as typeof fetch,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
      webhookAutoRegistered: true,
      webhookActive: true,
      webhookRemoteId: 1,
      webhookSecret: 'secret-0',
      webhookUrl: 'https://example.com/webhook/github/space',
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
      const checkP = clientHub.request('space.github.checkWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });
      await new Promise((r) => setTimeout(r, 10));
      // Simulate a concurrent re-registration PATCH timeout recording the uncertainty.
      const repo = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      extension.repo.updateWebhookStatus(repo.id, {
        lastError: 'webhook update uncertain: timeout',
      });
      resolveGet();
      await checkP;
      const after = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      expect(after.webhookLastError).toContain('update uncertain');
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  // The full event set the daemon expects, and the stale subset a hook registered
  // before pull_request_review_thread (and status) existed would still carry.
  const FULL_WEBHOOK_EVENTS = [
    'push',
    'pull_request',
    'issue_comment',
    'pull_request_review',
    'pull_request_review_comment',
    'pull_request_review_thread',
    'check_run',
    'status',
  ];
  const STALE_WEBHOOK_EVENTS = FULL_WEBHOOK_EVENTS.filter(
    (event) => event !== 'pull_request_review_thread' && event !== 'status'
  );

  function hookResponse(
    id: number,
    events: string[],
    url = 'https://example.com/webhook/github/space'
  ): Response {
    return new Response(
      JSON.stringify({
        id,
        active: true,
        config: { url, content_type: 'json' },
        events,
      }),
      { status: 200 }
    );
  }

  test('checkWebhook self-heals an auto-registered hook that is missing required events', async () => {
    // When WEBHOOK_EVENTS grows (e.g. pull_request_review_thread added), an
    // already-registered hook lags behind. checkWebhook must PATCH it back into
    // sync and re-validate instead of surfacing a stale "missing events" error.
    let patchCount = 0;
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        if (/\/hooks\/1$/.test(u) && (!init?.method || init.method === 'GET')) {
          return hookResponse(1, STALE_WEBHOOK_EVENTS);
        }
        if (/\/hooks\/1$/.test(u) && init?.method === 'PATCH') {
          patchCount++;
          return hookResponse(1, FULL_WEBHOOK_EVENTS);
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${u}`);
      }) as typeof fetch,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
      webhookAutoRegistered: true,
      webhookActive: true,
      webhookRemoteId: 1,
      webhookSecret: 'secret-0',
      webhookUrl: 'https://example.com/webhook/github/space',
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
      // autoReconcileWebhooks defaults off → start() must NOT sweep here.
      await extension.start(context);
      extension.registerRpcHandlers(hub, context);
      await clientHub.request('space.github.checkWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });
      expect(patchCount).toBe(1);
      const after = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      expect(after.webhookActive).toBe(true);
      expect(after.webhookLastError).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('checkWebhook does NOT self-heal a user-configured (non-auto-registered) hook', async () => {
    // A user-managed hook is reported as unhealthy but never mutated.
    let patchCount = 0;
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        if (/\/hooks\/1$/.test(u) && init?.method === 'PATCH') patchCount++;
        return hookResponse(1, STALE_WEBHOOK_EVENTS);
      }) as typeof fetch,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
      webhookAutoRegistered: false,
      webhookActive: true,
      webhookRemoteId: 1,
      webhookSecret: 'secret-0',
      webhookUrl: 'https://example.com/webhook/github/space',
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
      await clientHub.request('space.github.checkWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });
      expect(patchCount).toBe(0);
      const after = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      expect(after.webhookActive).toBe(false);
      expect(after.webhookLastError).toContain('missing events');
    } finally {
      await extension.stop();
    }
  });

  test('reconcileManagedWebhooks PATCHes stale hooks, skips in-sync ones, and ignores user hooks', async () => {
    let patches = 0;
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        // acme/widgets: stale → GET returns stale, PATCH returns full.
        if (/\/repos\/acme\/widgets\/hooks\/1$/.test(u) && init?.method === 'PATCH') {
          patches++;
          return hookResponse(1, FULL_WEBHOOK_EVENTS);
        }
        if (/\/repos\/acme\/widgets\/hooks\/1$/.test(u))
          return hookResponse(1, STALE_WEBHOOK_EVENTS);
        // acme/gadgets: in sync → GET only, never PATCHed.
        if (/\/repos\/acme\/gadgets\/hooks\/2$/.test(u))
          return hookResponse(2, FULL_WEBHOOK_EVENTS);
        // acme/legacy: user-configured → never reached (filtered out before fetch).
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${u}`);
      }) as typeof fetch,
    });
    const seed = (repo: string, remoteId: number, autoRegistered: boolean) =>
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo,
        webhookEnabled: true,
        webhookAutoRegistered: autoRegistered,
        webhookActive: true,
        webhookRemoteId: remoteId,
        webhookSecret: `secret-${remoteId}`,
        webhookUrl: 'https://example.com/webhook/github/space',
      });
    seed('widgets', 1, true);
    seed('gadgets', 2, true);
    seed('legacy', 3, false);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      await extension.reconcileManagedWebhooks();
      // Only the stale auto-registered hook (widgets) was PATCHed; the in-sync
      // hook (gadgets) and the user hook (legacy) were left alone.
      expect(patches).toBe(1);
    } finally {
      await extension.stop();
    }
  });

  test('start() without autoReconcileWebhooks does not fire the reconciliation sweep', async () => {
    // The sweep is opt-in (app.ts) so unit tests with a token + watched repos do
    // not make background API calls. A stale hook present at start() must NOT be
    // touched unless the option is set.
    let patches = 0;
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        if (/\/hooks\/1$/.test(u) && init?.method === 'PATCH') patches++;
        return hookResponse(1, STALE_WEBHOOK_EVENTS);
      }) as typeof fetch,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
      webhookAutoRegistered: true,
      webhookActive: true,
      webhookRemoteId: 1,
      webhookSecret: 'secret-0',
      webhookUrl: 'https://example.com/webhook/github/space',
    });
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      // Give the (absent) background sweep a chance to fire — it must not.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(patches).toBe(0);
    } finally {
      await extension.stop();
    }
  });

  test('reconcileManagedWebhooks updates shared hook health after a successful reconcile', async () => {
    // A hook previously marked inactive with a missing-events error must flip
    // back to active once the sweep repairs it — markWebhookReceived will not,
    // since it preserves the error while webhook_active = 0.
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        if (/\/hooks\/1$/.test(u) && init?.method === 'PATCH')
          return hookResponse(1, FULL_WEBHOOK_EVENTS);
        if (/\/hooks\/1$/.test(u)) return hookResponse(1, STALE_WEBHOOK_EVENTS);
        throw new Error(`unexpected fetch ${u}`);
      }) as typeof fetch,
    });
    const seeded = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
      webhookAutoRegistered: true,
      webhookActive: true,
      webhookRemoteId: 1,
      webhookSecret: 'secret-0',
      webhookUrl: 'https://example.com/webhook/github/space',
    });
    extension.repo.updateWebhookStatus(seeded.id, {
      active: false,
      lastError: 'GitHub webhook is missing events: pull_request_review_thread, status',
    });
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      await extension.reconcileManagedWebhooks();
      const after = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      expect(after.webhookActive).toBe(true);
      expect(after.webhookLastError).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('reconcileManagedWebhooks reconciles each shared hook once across spaces', async () => {
    // Two Spaces watching the same repo share one remote hook; the sweep must GET
    // it once (deduped by owner/repo + remoteId), not once per Space.
    let gets = 0;
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        if (/\/hooks\/1$/.test(u) && (!init?.method || init.method === 'GET')) {
          gets++;
          return hookResponse(1, FULL_WEBHOOK_EVENTS);
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${u}`);
      }) as typeof fetch,
    });
    for (const spaceId of ['space-1', 'space-2']) {
      extension.repo.upsertWatchedRepo({
        spaceId,
        owner: 'acme',
        repo: 'widgets',
        webhookEnabled: true,
        webhookAutoRegistered: true,
        webhookActive: true,
        webhookRemoteId: 1,
        webhookSecret: 'shared-secret',
        webhookUrl: 'https://example.com/webhook/github/space',
      });
    }
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      await extension.reconcileManagedWebhooks();
      expect(gets).toBe(1);
    } finally {
      await extension.stop();
    }
  });

  test('reconcileManagedWebhooks stops (and sets the cooldown) when a hook GET is rate-limited', async () => {
    // githubFetch throws GitHubApiError on 429 without setting rateLimitedUntil;
    // the sweep must detect it, set the shared cooldown, and stop — not keep
    // firing requests at an active limit (which would extend it).
    const fetched: string[] = [];
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        fetched.push(u);
        if (/\/repos\/acme\/widgets\/hooks\/1([/?]|$)/.test(u)) {
          return new Response(JSON.stringify({ message: 'rate limited' }), { status: 429 });
        }
        return hookResponse(2, FULL_WEBHOOK_EVENTS);
      }) as typeof fetch,
    });
    const seed = (repo: string, remoteId: number) =>
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo,
        webhookEnabled: true,
        webhookAutoRegistered: true,
        webhookActive: true,
        webhookRemoteId: remoteId,
        webhookSecret: `secret-${remoteId}`,
        webhookUrl: 'https://example.com/webhook/github/space',
      });
    seed('widgets', 1);
    seed('gadgets', 2);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      await extension.reconcileManagedWebhooks();
      // The second hook was never reached: the sweep stopped on the widgets 429.
      expect(fetched.some((u) => /gadgets/.test(u))).toBe(false);
      // The cooldown was set: a second sweep returns immediately (no new fetch).
      const widgetsFetchesAfterFirst = fetched.filter((u) => /widgets/.test(u)).length;
      await extension.reconcileManagedWebhooks();
      expect(fetched.filter((u) => /widgets/.test(u)).length).toBe(widgetsFetchesAfterFirst);
    } finally {
      await extension.stop();
    }
  });

  test('checkWebhook self-heal PATCHes with the current secret, not the snapshot', async () => {
    // A concurrent autoConfigureWebhook that rotates the secret DURING the
    // check's GET must be reflected in the self-heal PATCH. The PATCH re-reads
    // the row under the per-hook lock and uses the new secret; without the
    // re-read it would PATCH the stale snapshot secret, desync the remote secret,
    // and break HMAC verification on every later delivery.
    let patchedSecret = '';
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        if (/\/hooks\/1$/.test(u) && (!init?.method || init.method === 'GET')) {
          // Simulate a concurrent autoConfigure completing during the GET: it
          // rotated the shared hook's secret from secret-0 to secret-rotated.
          extension.repo.updateSharedAutoHook({
            owner: 'acme',
            repo: 'widgets',
            previousWebhookRemoteId: 1,
            webhookRemoteId: 1,
            webhookSecret: 'secret-rotated',
            webhookUrl: 'https://example.com/webhook/github/space',
            webhookActive: true,
            webhookLastCheckedAt: Date.now(),
            webhookConfiguredAt: Date.now(),
          });
          return hookResponse(1, STALE_WEBHOOK_EVENTS);
        }
        if (/\/hooks\/1$/.test(u) && init?.method === 'PATCH') {
          patchedSecret = (JSON.parse(init.body as string) as { config: { secret: string } }).config
            .secret;
          return hookResponse(1, FULL_WEBHOOK_EVENTS);
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${u}`);
      }) as typeof fetch,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
      webhookAutoRegistered: true,
      webhookActive: true,
      webhookRemoteId: 1,
      webhookSecret: 'secret-0',
      webhookUrl: 'https://example.com/webhook/github/space',
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
      await clientHub.request('space.github.checkWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });
      // The self-heal re-read the rotated secret; the PATCH used it, not secret-0.
      expect(patchedSecret).toBe('secret-rotated');
      const after = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      expect(after.webhookSecret).toBe('secret-rotated');
      expect(after.webhookActive).toBe(true);
      expect(after.webhookLastError).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('reconcileManagedWebhooks treats a bare 403 as a permission failure, not a rate limit', async () => {
    // A 403 is usually a permission failure (token can't manage webhooks for the
    // repo), not a rate limit — parseRateLimitHeaders treats a bare 403 the same
    // way. The sweep must log it and reconcile the NEXT hook instead of aborting
    // the whole one-shot sweep.
    const fetched: string[] = [];
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        fetched.push(u);
        if (/\/repos\/acme\/widgets\/hooks\/1([/?]|$)/.test(u)) {
          return new Response(
            JSON.stringify({ message: 'Resource not accessible by integration' }),
            {
              status: 403,
            }
          );
        }
        if (/\/hooks\/2$/.test(u) && init?.method === 'PATCH')
          return hookResponse(2, FULL_WEBHOOK_EVENTS);
        if (/\/hooks\/2$/.test(u)) return hookResponse(2, STALE_WEBHOOK_EVENTS);
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${u}`);
      }) as typeof fetch,
    });
    const seed = (repo: string, remoteId: number) =>
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo,
        webhookEnabled: true,
        webhookAutoRegistered: true,
        webhookActive: true,
        webhookRemoteId: remoteId,
        webhookSecret: `secret-${remoteId}`,
        webhookUrl: 'https://example.com/webhook/github/space',
      });
    seed('widgets', 1);
    seed('gadgets', 2);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      await extension.reconcileManagedWebhooks();
      // The widgets 403 did NOT abort the sweep — gadgets was still reconciled.
      expect(fetched.some((u) => /gadgets/.test(u))).toBe(true);
      const gadgets = extension.repo.getWatchedRepo('space-1', 'acme', 'gadgets')!;
      expect(gadgets.webhookActive).toBe(true);
      expect(gadgets.webhookLastError).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('reconcileManagedWebhooks preserves "update uncertain" on a GET-only reconcile but clears it after a PATCH', async () => {
    // A GET cannot verify which secret GitHub retained, so a pre-existing "update
    // uncertain" error (from an autoConfigure PATCH that timed out) must survive
    // a GET-only reconcile. A PATCH reaffirms the stored secret, resolving it.
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        // gadgets is in sync → GET-only. widgets is stale → PATCH.
        if (/\/hooks\/2$/.test(u)) return hookResponse(2, FULL_WEBHOOK_EVENTS);
        if (/\/hooks\/1$/.test(u) && init?.method === 'PATCH')
          return hookResponse(1, FULL_WEBHOOK_EVENTS);
        if (/\/hooks\/1$/.test(u)) return hookResponse(1, STALE_WEBHOOK_EVENTS);
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${u}`);
      }) as typeof fetch,
    });
    const seed = (repo: string, remoteId: number) => {
      const row = extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo,
        webhookEnabled: true,
        webhookAutoRegistered: true,
        webhookActive: true,
        webhookRemoteId: remoteId,
        webhookSecret: `secret-${remoteId}`,
        webhookUrl: 'https://example.com/webhook/github/space',
      });
      extension.repo.updateWebhookStatus(row.id, {
        active: false,
        lastError: 'webhook update uncertain: timeout',
      });
    };
    seed('widgets', 1);
    seed('gadgets', 2);
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      await extension.reconcileManagedWebhooks();
      // widgets was PATCHed → secret reaffirmed → uncertainty resolved.
      const widgets = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      expect(widgets.webhookLastError).toBeNull();
      // gadgets was GET-only → uncertainty PRESERVED (a GET can't clear it).
      const gadgets = extension.repo.getWatchedRepo('space-1', 'acme', 'gadgets')!;
      expect(gadgets.webhookLastError).toContain('update uncertain');
    } finally {
      await extension.stop();
    }
  });

  test('checkWebhook self-heal validates against the re-read row, not a stale URL', async () => {
    // A concurrent autoConfigure that changes the hook's endpoint URL (same hook
    // id) during the check's GET must not leave the correctly-reconfigured hook
    // flagged inactive. The self-heal re-reads the row and validates + writes
    // status against it (the new URL), not the snapshot.
    const changedUrl = 'https://changed.example.com/webhook/github/space';
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        if (/\/hooks\/1$/.test(u) && (!init?.method || init.method === 'GET')) {
          // Simulate autoConfigure changing the hook's URL during the GET.
          extension.repo.updateSharedAutoHook({
            owner: 'acme',
            repo: 'widgets',
            previousWebhookRemoteId: 1,
            webhookRemoteId: 1,
            webhookSecret: 'secret-0',
            webhookUrl: changedUrl,
            webhookActive: true,
            webhookLastCheckedAt: Date.now(),
            webhookConfiguredAt: Date.now(),
          });
          return hookResponse(1, STALE_WEBHOOK_EVENTS, changedUrl);
        }
        if (/\/hooks\/1$/.test(u) && init?.method === 'PATCH')
          return hookResponse(1, FULL_WEBHOOK_EVENTS, changedUrl);
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${u}`);
      }) as typeof fetch,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
      webhookAutoRegistered: true,
      webhookActive: true,
      webhookRemoteId: 1,
      webhookSecret: 'secret-0',
      webhookUrl: 'https://example.com/webhook/github/space',
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
      await clientHub.request('space.github.checkWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });
      // Validated against the re-read (changed) URL → no mismatch → healthy.
      const after = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      expect(after.webhookActive).toBe(true);
      expect(after.webhookLastError).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('stop() awaits an in-flight reconciliation sweep before returning', async () => {
    // stop() must track and await the sweep promise: its `stopped` guard only
    // fires between hooks, so an in-flight GET/PATCH can still be underway when
    // the source is disabled. Returning early would let the sweep mutate hooks /
    // write health after stop (and after the DB closes during shutdown).
    let resolveGet: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resolveGet = resolve;
    });
    let patched = false;
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      autoReconcileWebhooks: true,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        if (/\/hooks\/1$/.test(u) && (!init?.method || init.method === 'GET')) {
          await gate;
          return hookResponse(1, STALE_WEBHOOK_EVENTS);
        }
        if (/\/hooks\/1$/.test(u) && init?.method === 'PATCH') {
          patched = true;
          return hookResponse(1, FULL_WEBHOOK_EVENTS);
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${u}`);
      }) as typeof fetch,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
      webhookAutoRegistered: true,
      webhookActive: true,
      webhookRemoteId: 1,
      webhookSecret: 'secret-0',
      webhookUrl: 'https://example.com/webhook/github/space',
    });
    const context = {
      publisher: { publish: async () => {} },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context); // fires the gated sweep
    await new Promise((r) => setTimeout(r, 10)); // let it reach the gated GET
    const stopP = extension.stop();
    await new Promise((r) => setTimeout(r, 10)); // stop is waiting on the in-flight sweep
    expect(patched).toBe(false); // still gated — sweep has not PATCHed yet
    resolveGet(); // ungate the GET → sweep proceeds to PATCH
    await stopP; // stop resolves only after the sweep finishes
    expect(patched).toBe(true);
  });

  test('autoConfigureWebhook preserves a concurrent pollingEnabled change made during its PATCH', async () => {
    // The upsert after the slow PATCH must not pass the pollingEnabled captured
    // before the request — a concurrent setPollingEnabled(false) would be silently
    // reverted. Omitting pollingEnabled makes upsertWatchedRepo preserve the
    // row's current value.
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    let resolvePatch: () => void = () => {};
    const patchGate = new Promise<void>((resolve) => {
      resolvePatch = resolve;
    });
    const hookResponse = () =>
      new Response(
        JSON.stringify({
          id: 1,
          active: true,
          config: { url: 'https://example.com/webhook/github/space', content_type: 'json' },
        }),
        { status: 200 }
      );
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        if (init?.method === 'PATCH' && /\/hooks\/1$/.test(u)) {
          await patchGate;
        }
        return hookResponse();
      }) as typeof fetch,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookEnabled: true,
      webhookAutoRegistered: true,
      webhookActive: true,
      webhookRemoteId: 1,
      webhookSecret: 'secret-0',
      webhookUrl: 'https://example.com/webhook/github/space',
      pollingEnabled: true,
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
      const reconfigP = clientHub.request('space.github.autoConfigureWebhook', {
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
      });
      await new Promise((r) => setTimeout(r, 10));
      // Operator turns polling off while re-registration's PATCH is in flight.
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        pollingEnabled: false,
      });
      resolvePatch();
      await reconfigP;
      const after = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      expect(after.pollingEnabled).toBe(false);
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('RPC autoConfigureWebhook updates existing auto-registered hook without deleting first', async () => {
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
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
              'pull_request_review_thread',
              'check_run',
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
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('RPC autoConfigureWebhook rejects when webhook capability is disabled', async () => {
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
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
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('a failed hook recovery (PATCH 404 then POST fails) marks the hook inactive', async () => {
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    // The remote hook was deleted: PATCH returns 404, and the replacement POST
    // also fails (e.g. 422 validation). Recovery cannot establish a hook.
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
        }
        if (path.includes('/hooks') && init?.method === 'PATCH') {
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        }
        if (path.includes('/hooks') && init?.method === 'POST') {
          return new Response(JSON.stringify({ message: 'Validation Failed' }), { status: 422 });
        }
        return new Response('[]', { status: 200 });
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
      extension.registerRpcHandlers(hub, context);
      // Existing auto-registered repo whose cached state claims an active hook.
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        webhookEnabled: true,
        webhookAutoRegistered: true,
        webhookRemoteId: 12345,
        webhookActive: true,
      });

      await expect(
        clientHub.request('space.github.autoConfigureWebhook', {
          spaceId: 'space-1',
          owner: 'acme',
          repo: 'widgets',
        })
      ).rejects.toThrow();
      const watched = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets');
      // The failed recovery is persisted: the hook is inactive with an error,
      // not left cached as active.
      expect(watched?.webhookActive).toBe(false);
      expect(watched?.webhookLastError).toBeTruthy();
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('a failed reusable shared hook recovery marks the source row inactive', async () => {
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
        }
        // The reused shared hook is gone: PATCH 404, replacement POST fails.
        if (path.includes('/hooks') && init?.method === 'PATCH') {
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        }
        if (path.includes('/hooks') && init?.method === 'POST') {
          return new Response(JSON.stringify({ message: 'Validation Failed' }), { status: 422 });
        }
        return new Response('[]', { status: 200 });
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
      extension.registerRpcHandlers(hub, context);
      // Space-1 owns the auto-managed hook; Space-2 has no row yet, so its
      // autoConfigureWebhook reuses Space-1's hook as `source` (existing is null).
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        webhookEnabled: true,
        webhookAutoRegistered: true,
        webhookRemoteId: 123,
        webhookSecret: 'shared-secret',
        webhookUrl: 'https://example.com/webhook/github/space',
        webhookActive: true,
      });

      await expect(
        clientHub.request('space.github.autoConfigureWebhook', {
          spaceId: 'space-2',
          owner: 'acme',
          repo: 'widgets',
        })
      ).rejects.toThrow();
      // The reused shared hook (the source row in Space-1) is marked inactive —
      // not just the local (null) existing row.
      const source = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets');
      expect(source?.webhookActive).toBe(false);
      expect(source?.webhookLastError).toBeTruthy();
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('a timed-out webhook update records an uncertain status without flipping active', async () => {
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
        }
        // The PATCH (secret rotation) times out after the mutation was sent —
        // GitHub may have applied the new secret even though no response returned.
        if (path.includes('/hooks') && init?.method === 'PATCH') {
          throw new Error('The operation was aborted due to timeout');
        }
        return new Response('[]', { status: 200 });
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
      extension.registerRpcHandlers(hub, context);
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        webhookEnabled: true,
        webhookAutoRegistered: true,
        webhookRemoteId: 456,
        webhookSecret: 'old-secret',
        webhookUrl: 'https://example.com/webhook/github/space',
        webhookActive: true,
      });

      await expect(
        clientHub.request('space.github.autoConfigureWebhook', {
          spaceId: 'space-1',
          owner: 'acme',
          repo: 'widgets',
        })
      ).rejects.toThrow();
      const watched = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets');
      // Active is unchanged (the request's outcome is unknown, not confirmed
      // inactive), but an uncertain error is recorded so the panel degrades.
      expect(watched?.webhookActive).toBe(true);
      expect(watched?.webhookLastError).toContain('uncertain');
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('a timed-out replacement POST after a PATCH 404 is uncertain, not confirmed-gone', async () => {
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
        }
        // The hook is gone (PATCH 404); the replacement POST times out after
        // being sent — it may have committed a new hook.
        if (path.includes('/hooks') && init?.method === 'PATCH') {
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        }
        if (path.includes('/hooks') && init?.method === 'POST') {
          throw new Error('The operation was aborted due to timeout');
        }
        return new Response('[]', { status: 200 });
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
      extension.registerRpcHandlers(hub, context);
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        webhookEnabled: true,
        webhookAutoRegistered: true,
        webhookRemoteId: 789,
        webhookSecret: 'old-secret',
        webhookUrl: 'https://example.com/webhook/github/space',
        webhookActive: true,
      });

      await expect(
        clientHub.request('space.github.autoConfigureWebhook', {
          spaceId: 'space-1',
          owner: 'acme',
          repo: 'widgets',
        })
      ).rejects.toThrow();
      const watched = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets');
      // The POST may have created a replacement hook, so the hook is NOT marked
      // inactive — instead an uncertain error is recorded (Degraded).
      expect(watched?.webhookActive).toBe(true);
      expect(watched?.webhookLastError).toContain('uncertain');
    } finally {
      await extension.stop();
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('RPC autoConfigureWebhook recreates stale auto-registered hooks', async () => {
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
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
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('RPC autoConfigureWebhook reuses existing repository hook across spaces', async () => {
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
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
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('RPC autoConfigureWebhook keeps shared auto-hook secrets in sync', async () => {
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
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
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('RPC autoConfigureWebhook updates shared rows after recreating stale hooks', async () => {
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
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
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('RPC autoConfigureWebhook keeps existing hook when replacement update fails', async () => {
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
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
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
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
              'pull_request_review_thread',
              'check_run',
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
              'pull_request_review_thread',
              'check_run',
              'status',
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
              'pull_request_review_thread',
              'check_run',
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
      'GitHub webhook URL does not match this HyperNeo endpoint'
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

    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
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
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
    }
  });

  test('first comment endpoint poll starts at a recent lookback instead of historical backfill', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token');
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
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return pollingResponse([]);
    }) as typeof fetch;

    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);

      const issueCommentsSince = new URL(calls[0]).searchParams.get('since');
      const reviewCommentsSince = new URL(calls[1]).searchParams.get('since');
      const pullsSince = new URL(calls[2]).searchParams.get('since');
      expect(issueCommentsSince).toBeTruthy();
      expect(reviewCommentsSince).toBeTruthy();
      expect(Date.now() - Date.parse(issueCommentsSince!)).toBeLessThanOrEqual(
        24 * 60 * 60 * 1000 + 5_000
      );
      expect(Date.now() - Date.parse(reviewCommentsSince!)).toBeLessThanOrEqual(
        24 * 60 * 60 * 1000 + 5_000
      );
      expect(pullsSince).toBeNull();
    } finally {
      await extension.stop();
    }
  });

  test('paginated first comment poll keeps the same seeded lookback on the next page', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token');
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
    const calls: string[] = [];
    const pageOneRows = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      html_url: `https://github.com/acme/widgets/pull/7#issuecomment-${index + 1}`,
      body: 'looks good',
      user: { login: 'bot', type: 'Bot' },
      updated_at: '2026-01-01T00:00:00Z',
      issue: { number: 7, pull_request: { url: 'api' } },
    }));
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith('/issues/comments') && parsed.searchParams.get('page') === '1') {
        return pollingResponse(pageOneRows);
      }
      return pollingResponse([]);
    }) as typeof fetch;

    try {
      const repo = extension.repo.listPollingRepos()[0];
      await extension.pollWatchedRepo(repo, fetchImpl);
      const firstSince = new URL(calls[0]).searchParams.get('since');

      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const secondIssueCommentsUrl = calls.find(
        (url) =>
          new URL(url).pathname.endsWith('/issues/comments') &&
          new URL(url).searchParams.get('page') === '2'
      )!;
      const secondSince = new URL(secondIssueCommentsUrl).searchParams.get('since');
      const secondPage = new URL(secondIssueCommentsUrl).searchParams.get('page');

      expect(firstSince).toBeTruthy();
      expect(secondPage).toBe('2');
      expect(secondSince).toBe(firstSince);
    } finally {
      await extension.stop();
    }
  });

  test('empty first comment window persists the seeded lookback before pulls advance', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token');
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
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/pulls')) return pollingResponse([createPullRequestRow(7)]);
      return pollingResponse([]);
    }) as typeof fetch;

    try {
      const repo = extension.repo.listPollingRepos()[0];
      await extension.pollWatchedRepo(repo, fetchImpl);
      const initialIssueCommentsSince = new URL(calls[0]).searchParams.get('since');
      const initialReviewCommentsSince = new URL(calls[1]).searchParams.get('since');

      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const nextIssueCommentsSince = new URL(calls.at(-5)!).searchParams.get('since');
      const nextReviewCommentsSince = new URL(calls.at(-4)!).searchParams.get('since');

      expect(initialIssueCommentsSince).toBeTruthy();
      expect(initialReviewCommentsSince).toBeTruthy();
      expect(nextIssueCommentsSince).toBe(initialIssueCommentsSince);
      expect(nextReviewCommentsSince).toBe(initialReviewCommentsSince);
    } finally {
      await extension.stop();
    }
  });

  test('polling publishes failed check runs with canonical check_failed topic', async () => {
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
      if (path.endsWith('/check-runs'))
        return pollingResponse({ check_runs: [createCheckRunRow()] });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const event = received.find((item) => item.payload.eventType === 'check_run')!;
      expect(event.topic).toBe('github/acme/widgets/pull_request/7.check_failed');
      expect(event.dedupeKey).toBe('acme/widgets:check_run:7001:failure');
      expect(event.payload).toMatchObject({
        action: 'failed',
        checkRunId: 7001,
        name: 'unit tests',
        conclusion: 'failure',
        status: 'completed',
        headSha: 'abc123',
      });
    } finally {
      await extension.stop();
    }
  });

  test('polling drops successful, skipped, and neutral check runs', async () => {
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
      if (path.endsWith('/check-runs'))
        return pollingResponse({
          check_runs: [
            createCheckRunRow({ id: 1, conclusion: 'success' }),
            createCheckRunRow({ id: 2, conclusion: 'skipped' }),
            createCheckRunRow({ id: 3, conclusion: 'neutral' }),
          ],
        });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(received.some((item) => item.payload.eventType === 'check_run')).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('polling drops non-completed check runs', async () => {
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
      if (path.endsWith('/check-runs'))
        return pollingResponse({ check_runs: [createCheckRunRow({ status: 'in_progress' })] });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(received.some((item) => item.payload.eventType === 'check_run')).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('polling drops check runs with no associated PR', async () => {
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
      if (path.endsWith('/pulls')) return pollingResponse([]);
      if (path.endsWith('/check-runs'))
        return pollingResponse({ check_runs: [createCheckRunRow({ pull_requests: [] })] });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(received.some((item) => item.payload.eventType === 'check_run')).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('polling dedupes repeated check run IDs', async () => {
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
      if (path.endsWith('/check-runs'))
        return pollingResponse({ check_runs: [createCheckRunRow({ id: 7001 })] });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      const repo = extension.repo.listPollingRepos()[0];
      await extension.pollWatchedRepo(repo, fetchImpl);
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const storedCount = db
        .prepare(
          `SELECT COUNT(*) AS count FROM space_external_events WHERE topic = 'github/acme/widgets/pull_request/7.check_failed'`
        )
        .get() as { count: number };
      expect(storedCount.count).toBe(1);
    } finally {
      await extension.stop();
    }
  });

  test('polling dedupes check runs already delivered by webhook', async () => {
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
    const webhookEvent = toExternalEvent(
      'space-1',
      normalizeGitHubWebhook(
        'check_run',
        'delivery-1',
        checkRunPayload({
          check_run: {
            ...checkRunPayload().check_run,
            id: 7001,
            completed_at: '2026-01-03T00:00:00Z',
          },
        })
      )!
    );
    await service.publish(webhookEvent);
    received.length = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) return pollingResponse([createPullRequestRow(7)]);
      if (path.endsWith('/check-runs'))
        return pollingResponse({ check_runs: [createCheckRunRow({ name: 'daemon unit tests' })] });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const storedCount = db
        .prepare(
          `SELECT COUNT(*) AS count FROM space_external_events WHERE topic = 'github/acme/widgets/pull_request/7.check_failed'`
        )
        .get() as { count: number };
      expect(storedCount.count).toBe(1);
    } finally {
      await extension.stop();
    }
  });

  test('polling keeps same-second check runs eligible for store-level dedupe', async () => {
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
    let pollCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) return pollingResponse([createPullRequestRow(7)]);
      if (path.endsWith('/check-runs')) {
        pollCount++;
        return pollingResponse({
          check_runs: [
            createCheckRunRow({ id: 7001 }),
            ...(pollCount > 1 ? [createCheckRunRow({ id: 7002 })] : []),
          ],
        });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const storedRows = db
        .prepare(
          `SELECT payload_json AS payload FROM space_external_events WHERE topic = 'github/acme/widgets/pull_request/7.check_failed'`
        )
        .all() as Array<{ payload: string }>;
      const checkRunIds = storedRows
        .map((row) => JSON.parse(row.payload).checkRunId as number)
        .sort();
      expect(checkRunIds).toEqual([7001, 7002]);
    } finally {
      await extension.stop();
    }
  });

  test('polling preserves check-run heads beyond reaction target limit', async () => {
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
    let pollCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        pollCount++;
        return pollCount === 1
          ? pollingResponse(
              Array.from({ length: 11 }, (_, index) =>
                createPullRequestRow(index + 1, { head: { sha: `sha-${index + 1}` } })
              )
            )
          : new Response('', { status: 304 });
      }
      if (path.endsWith('/check-runs')) {
        const headSha = decodeURIComponent(path.split('/commits/')[1].split('/check-runs')[0]);
        return pollingResponse({
          check_runs:
            headSha === 'sha-11'
              ? [
                  createCheckRunRow({
                    id: 7011,
                    head_sha: 'sha-11',
                    pull_requests: [],
                  }),
                ]
              : [],
        });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(received.some((item) => item.payload.checkRunId === 7011)).toBe(true);
    } finally {
      await extension.stop();
    }
  });

  test('polling does not track check-run heads for closed PR deltas', async () => {
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
      if (path.endsWith('/pulls'))
        return pollingResponse([
          createPullRequestRow(7, { state: 'closed', head: { sha: 'abc123' } }),
        ]);
      if (path.endsWith('/check-runs'))
        return pollingResponse({ check_runs: [createCheckRunRow({ pull_requests: [] })] });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(received.some((item) => item.payload.eventType === 'check_run')).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('check-run permission errors do not block reaction polling', async () => {
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
    let checkRunRequestCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls'))
        return pollingResponse([
          createPullRequestRow(7, { head: { sha: 'sha-7' } }),
          createPullRequestRow(8, { head: { sha: 'sha-8' } }),
        ]);
      if (path.endsWith('/check-runs')) {
        checkRunRequestCount++;
        return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
          status: 403,
          headers: { 'X-RateLimit-Remaining': '4999' },
        });
      }
      if (path.endsWith('/issues/7/reactions')) return pollingResponse([createReactionRow()]);
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(checkRunRequestCount).toBe(1);
      expect(received.some((item) => item.topic.endsWith('.reaction_added'))).toBe(true);
    } finally {
      await extension.stop();
    }
  });

  test('polling publishes associated check runs for every PR', async () => {
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
      if (path.endsWith('/pulls'))
        return pollingResponse([
          createPullRequestRow(7, { head: { sha: 'shared-sha' } }),
          createPullRequestRow(8, { head: { sha: 'shared-sha' } }),
        ]);
      if (path.endsWith('/check-runs')) {
        expect(new URL(String(url)).searchParams.get('filter')).toBe('all');
        return pollingResponse({
          check_runs: [
            createCheckRunRow({
              id: 7001,
              head_sha: 'shared-sha',
              pull_requests: [],
            }),
          ],
        });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const topics = received
        .filter((item) => item.payload.eventType === 'check_run')
        .map((item) => item.topic)
        .sort();
      expect(topics).toEqual([
        'github/acme/widgets/pull_request/7.check_failed',
        'github/acme/widgets/pull_request/8.check_failed',
      ]);
    } finally {
      await extension.stop();
    }
  });

  test('polling skips missing check-run refs and continues to later heads', async () => {
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
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls'))
        return pollingResponse([
          createPullRequestRow(7, { head: { sha: 'missing-sha' } }),
          createPullRequestRow(8, { head: { sha: 'active-sha' } }),
        ]);
      if (path.endsWith('/check-runs')) {
        const headSha = decodeURIComponent(path.split('/commits/')[1].split('/check-runs')[0]);
        if (headSha === 'missing-sha') return new Response('{}', { status: 404 });
        return pollingResponse({
          check_runs: [createCheckRunRow({ id: 7008, head_sha: 'active-sha', pull_requests: [] })],
        });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const checkRunTopics = received
        .filter((item) => item.payload.eventType === 'check_run')
        .map((item) => item.topic);
      expect(checkRunTopics).toEqual(['github/acme/widgets/pull_request/8.check_failed']);
    } finally {
      await extension.stop();
    }
  });

  test('polling caches check-run ETags per head page', async () => {
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
    const checkRunIfNoneMatch: Array<string | null> = [];
    let pollCount = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) return pollingResponse([createPullRequestRow(7)]);
      if (path.endsWith('/check-runs')) {
        pollCount++;
        const headers = new Headers(init?.headers);
        checkRunIfNoneMatch.push(headers.get('If-None-Match'));
        if (pollCount === 2) return new Response('', { status: 304 });
        return pollingResponseWithHeaders({ check_runs: [] }, { ETag: 'W/"checks-abc123"' });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(checkRunIfNoneMatch).toEqual([null, 'W/"checks-abc123"']);
    } finally {
      await extension.stop();
    }
  });

  test('polling does not cache full check-run pages before pagination completes', async () => {
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
    const checkRunIfNoneMatch: Array<string | null> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) return pollingResponse([createPullRequestRow(7)]);
      if (path.endsWith('/check-runs')) {
        checkRunIfNoneMatch.push(new Headers(init?.headers).get('If-None-Match'));
        const page = parsed.searchParams.get('page');
        if (page === '1') {
          return pollingResponseWithHeaders(
            {
              check_runs: Array.from({ length: 100 }, (_, index) =>
                createCheckRunRow({ id: 7100 + index })
              ),
            },
            { ETag: 'W/"checks-full-page"' }
          );
        }
        return pollingResponseWithHeaders({ check_runs: [] }, { ETag: 'W/"checks-empty-page"' });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(checkRunIfNoneMatch).toEqual([null, null, null, 'W/"checks-empty-page"']);
    } finally {
      await extension.stop();
    }
  });

  test('polling filters check-run PR numbers to the tracked head', async () => {
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
      if (path.endsWith('/pulls'))
        return pollingResponse([
          createPullRequestRow(7, {
            head: {
              sha: 'fork-sha',
              repo: { owner: { login: 'contrib' }, name: 'widgets-fork' },
            },
          }),
        ]);
      if (path.endsWith('/check-runs'))
        return pollingResponse({
          check_runs: [
            createCheckRunRow({
              id: 7017,
              head_sha: 'fork-sha',
              pull_requests: [{ number: 1 }],
            }),
          ],
        });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const checkRunTopics = received
        .filter((item) => item.payload.eventType === 'check_run')
        .map((item) => item.topic);
      expect(checkRunTopics).toEqual(['github/acme/widgets/pull_request/7.check_failed']);
    } finally {
      await extension.stop();
    }
  });

  test('polling invalidates check-run ETags when tracked PRs for a head change', async () => {
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
    const checkRunIfNoneMatch: Array<string | null> = [];
    let pollCount = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        pollCount++;
        return pollingResponse(
          pollCount === 1
            ? [createPullRequestRow(7, { head: { sha: 'shared-sha' } })]
            : [
                createPullRequestRow(7, { head: { sha: 'shared-sha' } }),
                createPullRequestRow(8, { head: { sha: 'shared-sha' } }),
              ]
        );
      }
      if (path.endsWith('/check-runs')) {
        checkRunIfNoneMatch.push(new Headers(init?.headers).get('If-None-Match'));
        return pollingResponseWithHeaders({ check_runs: [] }, { ETag: 'W/"shared-sha-checks"' });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(checkRunIfNoneMatch).toEqual([null, null]);
    } finally {
      await extension.stop();
    }
  });

  test('polling keeps pulls seed mode until pull pagination completes', async () => {
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
    const seeded = extension.repo.listPollingRepos()[0];
    extension.repo.updatePollCursor(seeded.id, {
      lastSeenAt: Date.parse('2026-06-01T00:00:00Z'),
      etags: { pulls: 'W/"old-pulls"' },
      processedPages: {},
      recentPullRequestNumbers: [1],
      recentPullRequestHeadShas: {},
    });
    const pullsSinceValues: Array<string | null> = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        pullsSinceValues.push(parsed.searchParams.get('since'));
        const page = parsed.searchParams.get('page');
        return pollingResponse(
          page === '1'
            ? Array.from({ length: 100 }, (_, index) =>
                createPullRequestRow(index + 1, { head: { sha: `sha-${index + 1}` } })
              )
            : [createPullRequestRow(101, { head: { sha: 'sha-101' } })]
        );
      }
      if (path.endsWith('/check-runs')) return pollingResponse({ check_runs: [] });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(pullsSinceValues).toEqual([null, null]);
    } finally {
      await extension.stop();
    }
  });

  test('pulls pagination stops at client-side watermark cutoff and clears backlog', async () => {
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
    const repo = extension.repo.listPollingRepos()[0];
    const watermark = Date.parse('2026-06-15T00:00:00Z');
    extension.repo.updatePollCursor(repo.id, {
      lastSeenAt: watermark,
      endpointLastSeenAt: { pulls: watermark },
      processedPages: { pulls: 2 },
      recentPullRequestNumbers: [1],
      recentPullRequestHeadShas: { 1: 'old-sha' },
    });
    const pullsPages: Array<string | null> = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        const page = parsed.searchParams.get('page');
        pullsPages.push(page);
        if (page === '2') {
          // Page 2 is entirely older than the watermark — the cutoff must stop
          // pagination here and clear the backlog.
          return pollingResponse(
            Array.from({ length: 50 }, (_, index) =>
              createPullRequestRow(100 + index, {
                updated_at: '2026-06-14T00:00:00Z',
                head: { sha: `sha-${100 + index}` },
              })
            )
          );
        }
        return pollingResponse([]);
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(pullsPages).toEqual(['2']);
      const cursor = extension.repo.listPollingRepos()[0].pollCursor;
      expect(cursor?.processedPages?.pulls).toBe(1);
      expect(cursor?.endpointPendingLastSeenAt?.pulls).toBeUndefined();
    } finally {
      await extension.stop();
    }
  });

  test('check-run polling resumes after cutoff clears resumed-page backlog', async () => {
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
    const repo = extension.repo.listPollingRepos()[0];
    const watermark = Date.parse('2026-06-15T00:00:00Z');
    extension.repo.updatePollCursor(repo.id, {
      lastSeenAt: watermark,
      endpointLastSeenAt: { pulls: watermark },
      processedPages: { pulls: 2 },
      recentPullRequestNumbers: [7],
      recentPullRequestHeadShas: { 7: 'abc123' },
    });
    let checkRunCallCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        const page = parsed.searchParams.get('page');
        if (page === '2') {
          // Page 2 is entirely older than the watermark — cutoff fires and
          // clears the backlog, but check-run polling is deferred this cycle
          // because page 1 was not re-fetched.
          return pollingResponse(
            Array.from({ length: 50 }, (_, index) =>
              createPullRequestRow(100 + index, {
                updated_at: '2026-06-14T00:00:00Z',
                head: { sha: `old-sha-${index}` },
              })
            )
          );
        }
        // Page 1 on the next cycle: includes the newly opened PR #2200.
        return pollingResponse([
          createPullRequestRow(2200, {
            updated_at: '2026-06-20T00:00:00Z',
            head: { sha: 'new-head' },
          }),
        ]);
      }
      if (path.endsWith('/check-runs')) {
        checkRunCallCount++;
        return pollingResponse({
          check_runs: [
            createCheckRunRow({
              id: 7200,
              head_sha: 'new-head',
              pull_requests: [{ number: 2200 }],
            }),
          ],
        });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      // Cycle 1: cutoff clears the resumed page backlog. Check-run polling
      // must NOT run because page 1 was not fetched.
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(checkRunCallCount).toBe(0);
      const cursor1AfterCutoff = extension.repo.listPollingRepos()[0].pollCursor;
      expect(cursor1AfterCutoff?.processedPages?.pulls).toBe(1);

      // Cycle 2: page 1 is fetched, PR #2200 is discovered, check-run polling
      // runs and emits check_failed.
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(checkRunCallCount).toBeGreaterThan(0);
      expect(
        received.some((item) => item.topic === 'github/acme/widgets/pull_request/2200.check_failed')
      ).toBe(true);
    } finally {
      await extension.stop();
    }
  });

  test('pulls cutoff processes mixed-age pages and discards older tail', async () => {
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
    const repo = extension.repo.listPollingRepos()[0];
    const watermark = Date.parse('2026-06-15T00:00:00Z');
    extension.repo.updatePollCursor(repo.id, {
      lastSeenAt: watermark,
      endpointLastSeenAt: { pulls: watermark },
      processedPages: { pulls: 2 },
      recentPullRequestNumbers: [1],
      recentPullRequestHeadShas: { 1: 'old-sha' },
    });
    const pullsPages: Array<string | null> = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        const page = parsed.searchParams.get('page');
        pullsPages.push(page);
        if (page === '2') {
          // First 3 rows are newer than the watermark; the rest are older.
          return pollingResponse(
            Array.from({ length: 20 }, (_, index) =>
              createPullRequestRow(200 + index, {
                updated_at: index < 3 ? '2026-06-16T00:00:00Z' : '2026-06-14T00:00:00Z',
                head: { sha: `mixed-sha-${index}` },
              })
            )
          );
        }
        return pollingResponse([]);
      }
      if (path.endsWith('/check-runs')) return pollingResponse({ check_runs: [] });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(pullsPages).toEqual(['2']);
      const cursor = extension.repo.listPollingRepos()[0].pollCursor;
      expect(cursor?.processedPages?.pulls).toBe(1);
      // Newer rows are head-tracked and published.
      expect(cursor?.recentPullRequestHeadShas?.[200]).toBe('mixed-sha-0');
      expect(cursor?.recentPullRequestHeadShas?.[201]).toBe('mixed-sha-1');
      expect(cursor?.recentPullRequestHeadShas?.[202]).toBe('mixed-sha-2');
      expect(cursor?.recentPullRequestHeadShas?.[203]).toBeUndefined();
      const pullRequestEvents = received.filter(
        (item) => item.payload.eventType === 'pull_request'
      );
      expect(pullRequestEvents.map((item) => item.payload.prNumber).sort()).toEqual([
        200, 201, 202,
      ]);
    } finally {
      await extension.stop();
    }
  });

  test('pulls cutoff is skipped when no pulls-specific watermark exists', async () => {
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
    const repo = extension.repo.listPollingRepos()[0];
    const sharedWatermark = Date.parse('2026-06-20T00:00:00Z');
    extension.repo.updatePollCursor(repo.id, {
      lastSeenAt: sharedWatermark,
      // Legacy cursor: tracked heads exist but no pulls-specific watermark.
      // The shared watermark may be newer than a PR's updated_at, so the
      // cutoff must not drop the row before head/open-state refresh runs.
      recentPullRequestNumbers: [7],
      recentPullRequestHeadShas: { 7: 'old-sha' },
    });
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        return pollingResponse([
          createPullRequestRow(7, {
            // Older than the shared watermark but newer than an unseeded pulls cursor.
            updated_at: '2026-06-15T00:00:00Z',
            head: { sha: 'new-sha' },
          }),
        ]);
      }
      if (path.endsWith('/check-runs')) {
        const headSha = decodeURIComponent(path.split('/commits/')[1].split('/check-runs')[0]);
        if (headSha === 'new-sha') {
          return pollingResponse({
            check_runs: [createCheckRunRow({ id: 7002, head_sha: 'new-sha', pull_requests: [] })],
          });
        }
        return pollingResponse({ check_runs: [] });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const cursor = extension.repo.listPollingRepos()[0].pollCursor;
      expect(cursor?.recentPullRequestHeadShas?.[7]).toBe('new-sha');
      expect(
        received.some((item) => item.topic === 'github/acme/widgets/pull_request/7.check_failed')
      ).toBe(true);
    } finally {
      await extension.stop();
    }
  });

  test('pulls backlog defers all check-run scans until page 1 is fetched', async () => {
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
    const repo = extension.repo.listPollingRepos()[0];
    const watermark = Date.parse('2026-06-15T00:00:00Z');
    extension.repo.updatePollCursor(repo.id, {
      lastSeenAt: watermark,
      endpointLastSeenAt: { pulls: watermark },
      processedPages: { pulls: 2 },
      recentPullRequestNumbers: [7],
      recentPullRequestHeadShas: { 7: 'stale-sha' },
    });
    let checkRunCallCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        // Page 2 returns 100 unrelated PRs — backlog stays active. PR #7 is on
        // an unfetched page, so its cursor head must not be scanned.
        return pollingResponse(
          Array.from({ length: 100 }, (_, index) =>
            createPullRequestRow(200 + index, {
              updated_at: '2026-06-16T00:00:00Z',
              head: { sha: `bulk-sha-${index}` },
            })
          )
        );
      }
      if (path.endsWith('/check-runs')) {
        checkRunCallCount++;
        return pollingResponse({ check_runs: [] });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      // No check-run requests at all — polling is deferred until page 1.
      expect(checkRunCallCount).toBe(0);
      expect(received.some((item) => item.payload.eventType === 'check_run')).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('pulls watermark bump breaks tied-row starvation and allows check-run polling', async () => {
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
    const repo = extension.repo.listPollingRepos()[0];
    const watermark = Date.parse('2026-06-15T00:00:00Z');
    extension.repo.updatePollCursor(repo.id, {
      lastSeenAt: watermark,
      endpointLastSeenAt: { pulls: watermark },
      processedPages: { pulls: 2 },
      recentPullRequestNumbers: [7],
      recentPullRequestHeadShas: { 7: 'abc123' },
    });
    let checkRunCallCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        const page = parsed.searchParams.get('page');
        if (page === '2') {
          // Full page of 100 tied rows — backlog continues to page 3.
          return pollingResponse(
            Array.from({ length: 100 }, (_, index) =>
              createPullRequestRow(100 + index, {
                updated_at: '2026-06-15T00:00:00Z',
                head: { sha: `tied-sha-${index}` },
              })
            )
          );
        }
        if (page === '3') {
          // Partial page of tied rows — backlog clears. The 1ms bump fires
          // because endpointPending === endpointWatermark.
          return pollingResponse([
            createPullRequestRow(7, {
              updated_at: '2026-06-15T00:00:00Z',
              head: { sha: 'abc123' },
            }),
          ]);
        }
        // Page 1 on subsequent cycles: the 1ms bump makes tied rows strictly
        // older, so the < cutoff fires and clears the backlog.
        return pollingResponse([
          createPullRequestRow(7, {
            updated_at: '2026-06-15T00:00:00Z',
            head: { sha: 'abc123' },
          }),
        ]);
      }
      if (path.endsWith('/check-runs')) {
        checkRunCallCount++;
        return pollingResponse({ check_runs: [] });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      // Cycle 1: page 2 (100 tied rows). Backlog continues, check-runs deferred.
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(checkRunCallCount).toBe(0);

      // Cycle 2: page 3 (1 tied row). Backlog clears. Bump fires because
      // endpointPending === endpointWatermark.
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(checkRunCallCount).toBe(0);
      const cursor = extension.repo.listPollingRepos()[0].pollCursor;
      expect(cursor?.endpointLastSeenAt?.pulls).toBe(watermark + 1);

      // Cycle 3: page 1. The 1ms-bumped watermark makes tied rows strictly
      // older → cutoff fires → backlog clears → check-runs run.
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(checkRunCallCount).toBeGreaterThan(0);
    } finally {
      await extension.stop();
    }
  });

  test('shared cursor stays pending when check-run polling is deferred on resumed page', async () => {
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
    const repo = extension.repo.listPollingRepos()[0];
    const watermark = Date.parse('2026-06-15T00:00:00Z');
    extension.repo.updatePollCursor(repo.id, {
      lastSeenAt: watermark,
      endpointLastSeenAt: { pulls: watermark },
      processedPages: { pulls: 2 },
      recentPullRequestNumbers: [7],
      recentPullRequestHeadShas: { 7: 'abc123' },
    });
    const fetchImpl = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        // Page 2 rows are older than the watermark — cutoff fires and clears
        // the backlog, but page 1 was not fetched so check-run polling is
        // deferred. The shared cursor must NOT advance to avoid shifting the
        // check-run baseline for newly discovered heads.
        return pollingResponse([
          createPullRequestRow(100, {
            updated_at: '2026-06-14T00:00:00Z',
            head: { sha: 'older-sha' },
          }),
        ]);
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const cursor = extension.repo.listPollingRepos()[0].pollCursor;
      // Shared lastSeenAt must not advance past the original watermark.
      expect(cursor?.lastSeenAt).toBe(watermark);
      expect(cursor?.pendingLastSeenAt).toBe(watermark);
    } finally {
      await extension.stop();
    }
  });

  test('polling seeds the check-run cursor before the first scan', async () => {
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
      if (path.endsWith('/check-runs'))
        return pollingResponse({
          check_runs: [createCheckRunRow({ id: 7001, completed_at: '2020-01-03T00:00:00Z' })],
        });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(received.some((item) => item.payload.eventType === 'check_run')).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('polling queries fork head repositories for check runs', async () => {
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
    const checkRunPaths: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls'))
        return pollingResponse([
          createPullRequestRow(7, {
            head: {
              sha: 'fork-sha',
              repo: { owner: { login: 'contrib' }, name: 'widgets-fork' },
            },
          }),
        ]);
      if (path.endsWith('/check-runs')) {
        checkRunPaths.push(path);
        return pollingResponse({
          check_runs: [createCheckRunRow({ id: 7017, head_sha: 'fork-sha', pull_requests: [] })],
        });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      // Fork heads are queried on both the fork repo and the watched base repo.
      expect(checkRunPaths).toEqual([
        '/repos/contrib/widgets-fork/commits/fork-sha/check-runs',
        '/repos/acme/widgets/commits/fork-sha/check-runs',
      ]);
      expect(
        received.some((item) => item.topic === 'github/acme/widgets/pull_request/7.check_failed')
      ).toBe(true);
    } finally {
      await extension.stop();
    }
  });

  test('an inaccessible fork head records a partial poll error', async () => {
    // A watched PR whose head lives in a fork the token cannot read returns 403
    // for the fork's check-runs while the base-repo leg and primary endpoints
    // succeed. The cycle must record a partial poll error so the health badge
    // degrades — otherwise lastPollAt advances, the prior partial error clears,
    // and the panel reports Healthy while fork check-run events are missed.
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
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls'))
        return pollingResponse([
          createPullRequestRow(7, {
            head: {
              sha: 'fork-sha',
              repo: { owner: { login: 'contrib' }, name: 'widgets-fork' },
            },
          }),
        ]);
      if (path.endsWith('/check-runs')) {
        // Fork head is inaccessible (token lacks read on the contributor fork);
        // the watched base repo's check-runs succeed.
        if (path.includes('contrib/widgets-fork')) {
          return new Response(JSON.stringify({ message: 'Resource not accessible' }), {
            status: 403,
          });
        }
        return pollingResponse({
          check_runs: [createCheckRunRow({ id: 7017, head_sha: 'fork-sha', pull_requests: [] })],
        });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const cursor = extension.repo.listPollingRepos()[0].pollCursor!;
      expect(cursor.lastPartialPollError).toBeTruthy();
      expect(cursor.lastPartialPollError).toContain('fork');
    } finally {
      await extension.stop();
    }
  });

  test('polling seeds check-run cursor from stable polling-enabled time', async () => {
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
    const repo = extension.repo.listPollingRepos()[0];
    // Simulate a check run that completed after polling was enabled — it must
    // not be filtered as historical. checkRunPollingEnabledAt is captured at
    // upsert time; a run completing after it should be published.
    const enabledAt = repo.pollCursor?.checkRunPollingEnabledAt ?? Date.now();
    const afterEnabled = new Date(enabledAt + 1000).toISOString();
    const beforeEnabled = new Date(enabledAt - 1000).toISOString();
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) return pollingResponse([createPullRequestRow(7)]);
      if (path.endsWith('/check-runs'))
        return pollingResponse({
          check_runs: [
            // filter=all returns newest-first.
            createCheckRunRow({ id: 7002, completed_at: afterEnabled }),
            createCheckRunRow({ id: 7001, completed_at: beforeEnabled }),
          ],
        });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(repo, fetchImpl);
      const checkRunIds = received
        .filter((item) => item.payload.eventType === 'check_run')
        .map((item) => item.payload.checkRunId);
      expect(checkRunIds).toEqual([7002]);
    } finally {
      await extension.stop();
    }
  });

  test('polling skips check-run scan when pull discovery fails', async () => {
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
    let checkRunRequestCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) return new Response('Internal Server Error', { status: 500 });
      if (path.endsWith('/check-runs')) {
        checkRunRequestCount++;
        return pollingResponse({ check_runs: [createCheckRunRow()] });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(checkRunRequestCount).toBe(0);
      expect(received.some((item) => item.payload.eventType === 'check_run')).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('polling continues check-run scan past inaccessible fork heads', async () => {
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
    const checkRunPaths: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls'))
        return pollingResponse([
          createPullRequestRow(7, {
            head: {
              sha: 'fork-sha',
              repo: { owner: { login: 'contrib' }, name: 'widgets-fork' },
            },
          }),
          createPullRequestRow(8, { head: { sha: 'base-sha' } }),
        ]);
      if (path.endsWith('/check-runs')) {
        checkRunPaths.push(path);
        const headSha = decodeURIComponent(path.split('/commits/')[1].split('/check-runs')[0]);
        if (path.includes('contrib/widgets-fork')) {
          return new Response('Forbidden', { status: 403 });
        }
        // Only the base-sha head has a failure; fork-sha has no runs on the
        // base repo in this scenario.
        if (headSha === 'base-sha')
          return pollingResponse({
            check_runs: [createCheckRunRow({ id: 7001, head_sha: 'base-sha', pull_requests: [] })],
          });
        return pollingResponse({ check_runs: [] });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(checkRunPaths).toContain('/repos/contrib/widgets-fork/commits/fork-sha/check-runs');
      expect(checkRunPaths).toContain('/repos/acme/widgets/commits/base-sha/check-runs');
      const checkRunTopics = received
        .filter((item) => item.payload.eventType === 'check_run')
        .map((item) => item.topic);
      expect(checkRunTopics).toEqual(['github/acme/widgets/pull_request/8.check_failed']);
    } finally {
      await extension.stop();
    }
  });

  test('polling suppresses superseded failures for newly tracked PRs', async () => {
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
    let pollCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        pollCount++;
        return pollingResponse(
          pollCount === 1
            ? [createPullRequestRow(7, { head: { sha: 'shared-sha' } })]
            : [
                createPullRequestRow(7, { head: { sha: 'shared-sha' } }),
                createPullRequestRow(8, { head: { sha: 'shared-sha' } }),
              ]
        );
      }
      if (path.endsWith('/check-runs'))
        // filter=all returns newest-first: a success at 10:05 then a failure at 10:00.
        return pollingResponse({
          check_runs: [
            createCheckRunRow({
              id: 7002,
              head_sha: 'shared-sha',
              conclusion: 'success',
              pull_requests: [],
            }),
            createCheckRunRow({
              id: 7001,
              head_sha: 'shared-sha',
              conclusion: 'failure',
              pull_requests: [],
            }),
          ],
        });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      const repo = extension.repo.listPollingRepos()[0];
      await extension.pollWatchedRepo(repo, fetchImpl);
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      // Neither PR should receive a check_failed since the latest run is green.
      const topics = db
        .prepare(
          `SELECT topic FROM space_external_events WHERE topic LIKE 'github/acme/widgets/pull_request/%.check_failed'`
        )
        .all()
        .map((row) => (row as { topic: string }).topic);
      expect(topics).toEqual([]);
    } finally {
      await extension.stop();
    }
  });

  test('polling queries base repo for fork head check runs', async () => {
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
    const checkRunPaths: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls'))
        return pollingResponse([
          createPullRequestRow(7, {
            head: {
              sha: 'fork-sha',
              repo: { owner: { login: 'contrib' }, name: 'widgets-fork' },
            },
          }),
        ]);
      if (path.endsWith('/check-runs')) {
        checkRunPaths.push(path);
        // Fork repo has no check runs; base repo has the failure.
        if (path.includes('contrib/widgets-fork')) return pollingResponse({ check_runs: [] });
        return pollingResponse({
          check_runs: [createCheckRunRow({ id: 7018, head_sha: 'fork-sha', pull_requests: [] })],
        });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(checkRunPaths).toContain('/repos/contrib/widgets-fork/commits/fork-sha/check-runs');
      expect(checkRunPaths).toContain('/repos/acme/widgets/commits/fork-sha/check-runs');
      expect(
        received.some((item) => item.topic === 'github/acme/widgets/pull_request/7.check_failed')
      ).toBe(true);
    } finally {
      await extension.stop();
    }
  });

  test('polling reseeds check-run cursors when space is re-enabled', async () => {
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
    // Disable the repo (enabled false), then re-enable — the check-run
    // baseline should refresh even though pollingEnabled stayed true.
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      enabled: false,
    });
    const beforeReEnable = Date.now();
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      enabled: true,
    });
    const repo = extension.repo.listPollingRepos()[0];
    expect(repo.pollCursor?.checkRunPollingEnabledAt).toBeGreaterThanOrEqual(beforeReEnable);
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) return pollingResponse([createPullRequestRow(7)]);
      if (path.endsWith('/check-runs'))
        return pollingResponse({
          check_runs: [createCheckRunRow({ id: 7001, completed_at: '2020-01-01T00:00:00Z' })],
        });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(repo, fetchImpl);
      expect(received.some((item) => item.payload.eventType === 'check_run')).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('polling scopes check-run dedupe when legacy key belongs to a different PR', async () => {
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
    let pollCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        pollCount++;
        return pollingResponse(
          pollCount === 1
            ? [createPullRequestRow(7, { head: { sha: 'shared-sha' } })]
            : [createPullRequestRow(8, { head: { sha: 'shared-sha' } })]
        );
      }
      if (path.endsWith('/check-runs'))
        return pollingResponse({
          check_runs: [createCheckRunRow({ id: 7001, head_sha: 'shared-sha', pull_requests: [] })],
        });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const dedupeKeys = db
        .prepare(
          `SELECT dedupe_key FROM space_external_events WHERE topic LIKE 'github/acme/widgets/pull_request/%.check_failed'`
        )
        .all() as { dedupe_key: string }[];
      expect(dedupeKeys.map((row) => row.dedupe_key).sort()).toEqual([
        'acme/widgets:check_run:7001:failure',
        'acme/widgets:check_run:7001:failure:8',
      ]);
    } finally {
      await extension.stop();
    }
  });

  test('polling scopes legacy check-run key when owner was seeded by webhook', async () => {
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
    // Webhook delivers the unscoped legacy key for PR #7 before any polling
    // populates checkRunLegacyPrs.
    const webhookEvent = toExternalEvent(
      'space-1',
      normalizeGitHubWebhook(
        'check_run',
        'delivery-webhook',
        checkRunPayload({
          check_run: {
            ...(checkRunPayload().check_run as Record<string, unknown>),
            id: 7001,
            completed_at: '2099-01-03T00:00:00Z',
          },
        })
      )!
    );
    await service.publish(webhookEvent);
    received.length = 0;
    // Now polling observes the same check run for PR #8 (same head SHA).
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls'))
        return pollingResponse([createPullRequestRow(8, { head: { sha: 'abc123' } })]);
      if (path.endsWith('/check-runs'))
        return pollingResponse({
          check_runs: [createCheckRunRow({ id: 7001, head_sha: 'abc123', pull_requests: [] })],
        });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const dedupeKeys = db
        .prepare(
          `SELECT dedupe_key FROM space_external_events WHERE topic LIKE 'github/acme/widgets/pull_request/%.check_failed'`
        )
        .all() as { dedupe_key: string }[];
      expect(dedupeKeys.map((row) => row.dedupe_key).sort()).toEqual([
        'acme/widgets:check_run:7001:failure',
        'acme/widgets:check_run:7001:failure:8',
      ]);
    } finally {
      await extension.stop();
    }
  });

  test('polling isolates per-head check-run cursors so skipped heads do not lose events', async () => {
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
    let pollCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        pollCount++;
        return pollingResponse([
          createPullRequestRow(7, { head: { sha: 'head-a' } }),
          createPullRequestRow(8, { head: { sha: 'head-b' } }),
        ]);
      }
      if (path.endsWith('/check-runs')) {
        const headSha = decodeURIComponent(path.split('/commits/')[1].split('/check-runs')[0]);
        // Cycle 1: head-a returns a 500 (transient), head-b returns a failure.
        // Cycle 2: head-a returns the failure that completed during cycle 1.
        if (pollCount === 1) {
          if (headSha === 'head-a') return new Response('Server Error', { status: 500 });
          return pollingResponse({
            check_runs: [createCheckRunRow({ id: 7002, head_sha: 'head-b', pull_requests: [] })],
          });
        }
        if (headSha === 'head-a')
          return pollingResponse({
            check_runs: [createCheckRunRow({ id: 7001, head_sha: 'head-a', pull_requests: [] })],
          });
        return pollingResponse({ check_runs: [] });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      const repo = extension.repo.listPollingRepos()[0];
      await extension.pollWatchedRepo(repo, fetchImpl);
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const checkRunIds = received
        .filter((item) => item.payload.eventType === 'check_run')
        .map((item) => item.payload.checkRunId)
        .sort();
      // head-a's event is not lost even though head-b advanced its own cursor.
      expect(checkRunIds).toEqual([7001, 7002]);
    } finally {
      await extension.stop();
    }
  });

  test('polling keeps reactions running after a transient check-run 5xx', async () => {
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
      if (path.endsWith('/check-runs')) return new Response('Server Error', { status: 500 });
      if (path.endsWith('/issues/7/reactions'))
        return pollingResponse([createReactionRow({ id: 9001, content: '+1' })]);
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(received.some((item) => item.payload.eventType === 'reaction')).toBe(true);
    } finally {
      await extension.stop();
    }
  });

  test('polling seeds legacy check-run cursor from committed watermark, not createdAt', async () => {
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
    // Simulate a legacy cursor: no checkRunPollingEnabledAt, an old
    // committed watermark, and an old createdAt.
    const repo = extension.repo.listPollingRepos()[0];
    const committedAt = Date.parse('2026-06-20T00:00:00Z');
    extension.repo.updatePollCursorJson(repo.id, {
      lastSeenAt: committedAt,
      recentPullRequestNumbers: [7],
      recentPullRequestHeadShas: { 7: 'abc123' },
    });
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) return pollingResponse([createPullRequestRow(7)]);
      if (path.endsWith('/check-runs'))
        return pollingResponse({
          // A failure from before the committed watermark — must be dropped.
          check_runs: [createCheckRunRow({ id: 7001, completed_at: '2026-06-18T00:00:00Z' })],
        });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(received.some((item) => item.payload.eventType === 'check_run')).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('polling reprocesses check runs when a head gains a new PR', async () => {
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
    let pollCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        pollCount++;
        return pollingResponse(
          pollCount === 1
            ? [createPullRequestRow(7, { head: { sha: 'shared-sha' } })]
            : [
                createPullRequestRow(7, { head: { sha: 'shared-sha' } }),
                createPullRequestRow(8, { head: { sha: 'shared-sha' } }),
              ]
        );
      }
      if (path.endsWith('/check-runs'))
        return pollingResponse({
          check_runs: [createCheckRunRow({ id: 7001, head_sha: 'shared-sha', pull_requests: [] })],
        });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      const repo = extension.repo.listPollingRepos()[0];
      // Cycle 1: PR #7 gets the failure.
      await extension.pollWatchedRepo(repo, fetchImpl);
      // Cycle 2: PR #8 joins the same head — the failure must be re-evaluated.
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const storedRows = db
        .prepare(
          `SELECT topic, dedupe_key FROM space_external_events WHERE topic LIKE 'github/acme/widgets/pull_request/%.check_failed'`
        )
        .all() as { topic: string; dedupe_key: string }[];
      const topics = storedRows.map((row) => row.topic).sort();
      expect(topics).toEqual([
        'github/acme/widgets/pull_request/7.check_failed',
        'github/acme/widgets/pull_request/8.check_failed',
      ]);
    } finally {
      await extension.stop();
    }
  });

  test('polling seeds reset heads below the global check-run cursor', async () => {
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
    let pollCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        pollCount++;
        return pollingResponse(
          pollCount === 1
            ? [
                createPullRequestRow(7, { head: { sha: 'shared-sha' } }),
                createPullRequestRow(9, { head: { sha: 'other-sha' } }),
              ]
            : [
                createPullRequestRow(7, { head: { sha: 'shared-sha' } }),
                createPullRequestRow(8, { head: { sha: 'shared-sha' } }),
                createPullRequestRow(9, { head: { sha: 'other-sha' } }),
              ]
        );
      }
      if (path.endsWith('/check-runs')) {
        const headSha = decodeURIComponent(path.split('/commits/')[1].split('/check-runs')[0]);
        if (headSha === 'other-sha')
          // A later successful check on another head that advances the global cursor.
          return pollingResponse({
            check_runs: [
              createCheckRunRow({
                id: 7002,
                head_sha: 'other-sha',
                conclusion: 'success',
                pull_requests: [],
              }),
            ],
          });
        // shared-sha has the older failure that must not be dropped.
        return pollingResponse({
          check_runs: [createCheckRunRow({ id: 7001, head_sha: 'shared-sha', pull_requests: [] })],
        });
      }
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      const repo = extension.repo.listPollingRepos()[0];
      await extension.pollWatchedRepo(repo, fetchImpl);
      // Cycle 2: PR #8 joins shared-sha — the per-head watermark was cleared,
      // but the global cursor advanced past the failure on cycle 1. The reset
      // head must seed below the global cursor so the failure is re-evaluated.
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const topics = db
        .prepare(
          `SELECT topic FROM space_external_events WHERE topic LIKE 'github/acme/widgets/pull_request/%.check_failed'`
        )
        .all()
        .map((row) => (row as { topic: string }).topic)
        .sort();
      expect(topics).toEqual([
        'github/acme/widgets/pull_request/7.check_failed',
        'github/acme/widgets/pull_request/8.check_failed',
      ]);
    } finally {
      await extension.stop();
    }
  });

  test('polling reseeds check-run baseline when polling is re-enabled', async () => {
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
    // Disable polling, then re-enable — the check-run baseline should refresh.
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: false,
    });
    const beforeReEnable = Date.now();
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    const repo = extension.repo.listPollingRepos()[0];
    expect(repo.pollCursor?.checkRunPollingEnabledAt).toBeGreaterThanOrEqual(beforeReEnable);
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) return pollingResponse([createPullRequestRow(7)]);
      if (path.endsWith('/check-runs'))
        return pollingResponse({
          check_runs: [
            // Failure from the disabled window — must be filtered.
            createCheckRunRow({ id: 7001, completed_at: '2020-01-01T00:00:00Z' }),
          ],
        });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(repo, fetchImpl);
      expect(received.some((item) => item.payload.eventType === 'check_run')).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('polling honors recorded legacy owner during fan-out regardless of order', async () => {
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
    // Webhook delivers the unscoped legacy key for PR #7.
    const webhookEvent = toExternalEvent(
      'space-1',
      normalizeGitHubWebhook(
        'check_run',
        'delivery-webhook',
        checkRunPayload({
          check_run: {
            ...(checkRunPayload().check_run as Record<string, unknown>),
            id: 7001,
            completed_at: '2099-01-03T00:00:00Z',
          },
        })
      )!
    );
    await service.publish(webhookEvent);
    received.length = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      // /pulls orders PRs [8, 7] — #8 is first but #7 owns the legacy key.
      if (path.endsWith('/pulls'))
        return pollingResponse([
          createPullRequestRow(8, { head: { sha: 'abc123' } }),
          createPullRequestRow(7, { head: { sha: 'abc123' } }),
        ]);
      if (path.endsWith('/check-runs'))
        return pollingResponse({
          check_runs: [createCheckRunRow({ id: 7001, head_sha: 'abc123', pull_requests: [] })],
        });
      return pollingResponse([]);
    }) as typeof fetch;
    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const dedupeKeys = db
        .prepare(
          `SELECT dedupe_key FROM space_external_events WHERE topic LIKE 'github/acme/widgets/pull_request/%.check_failed'`
        )
        .all() as { dedupe_key: string }[];
      // #7 keeps the unscoped key; #8 gets the scoped key even though it was
      // first in the fan-out list.
      expect(dedupeKeys.map((row) => row.dedupe_key).sort()).toEqual([
        'acme/widgets:check_run:7001:failure',
        'acme/widgets:check_run:7001:failure:8',
      ]);
    } finally {
      await extension.stop();
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

  test('previously tracked PRs that close are dropped from reaction targets', async () => {
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
    const pullsPages: Array<Record<string, unknown>[]> = [];
    const calledReactions: number[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) {
        const page = pullsPages.shift() ?? [];
        return pollingResponse(page);
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
      // Cycle 0: PRs 5, 4, 3 all open → all tracked.
      pullsPages.push([createPullRequestRow(5), createPullRequestRow(4), createPullRequestRow(3)]);
      await extension.pollWatchedRepo(repo, fetchImpl);
      expect(calledReactions.slice()).toEqual([5, 4, 3]);
      calledReactions.length = 0;

      // Cycle 1: PR 4 closes. Delta reports it closed → must be dropped,
      // leaving only 5 and 3 as reaction targets.
      pullsPages.push([
        createPullRequestRow(5),
        { ...createPullRequestRow(4), state: 'closed' },
        createPullRequestRow(3),
      ]);
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      expect(calledReactions.slice()).toEqual([5, 3]);
    } finally {
      await extension.stop();
    }
  });

  test('transient reaction fetch failure preserves the watermark so the +1 is not later stale', async () => {
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
    // PR updated Jun 15; the +1 landed Jun 10 (before the PR metadata update).
    // A naive cursor would commit Jun 15 after a failed reaction fetch and
    // then treat the Jun 10 +1 as stale on the next cycle.
    const prRow = { ...createPullRequestRow(7), updated_at: '2026-06-15T00:00:00Z' };
    let reactionCalls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls')) return pollingResponse([prRow]);
      if (path.endsWith('/issues/7/reactions')) {
        reactionCalls++;
        // Cycle 0: transient 500. Cycle 1: return the +1.
        if (reactionCalls === 1)
          return new Response(JSON.stringify({ message: 'server error' }), { status: 500 });
        return pollingResponse([
          createReactionRow({ id: 9001, content: '+1', created_at: '2026-06-10T00:00:00Z' }),
        ]);
      }
      return pollingResponse([]);
    }) as typeof fetch;

    try {
      const repo = extension.repo.listPollingRepos()[0];
      await extension.pollWatchedRepo(repo, fetchImpl);
      expect(received.filter((event) => event.payload.eventType === 'reaction')).toHaveLength(0);

      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const published = received.filter((event) => event.payload.eventType === 'reaction');
      expect(published).toHaveLength(1);
      expect(published[0].dedupeKey).toBe('acme/widgets:reaction:9001');
    } finally {
      await extension.stop();
    }
  });

  test('a budget-skipped reaction PR does not advance the repo reaction freshness', async () => {
    const db = setupDb();
    const { service } = setupExternalEventService(db);
    const extension = new GitHubEventExtension(db, 'token');
    await extension.start({
      publisher: service,
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    });
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    // Prior fresh reaction timestamp; a complete cycle would advance it, but a
    // partial (budget-starved) cycle that skips a later PR must leave it
    // untouched so the repo can age into stale.
    const priorReactionAt = Date.now() - 3_600_000;
    extension.repo.updatePollCursor(repo.id, { lastReactionPollAt: priorReactionAt });

    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls'))
        return pollingResponse([
          createPullRequestRow(1, { head: { sha: 's1' } }),
          createPullRequestRow(2, { head: { sha: 's2' } }),
        ]);
      // PR #1 succeeds but drops remaining below the reaction floor (100) so PR
      // #2 is skipped on the next iteration. Still above the low-remaining
      // threshold (10), so no cooldown is applied.
      if (path.endsWith('/issues/1/reactions')) return pollingResponse([], 50);
      if (path.endsWith('/issues/2/reactions'))
        throw new Error('PR #2 must be skipped, not polled');
      return pollingResponse([]);
    }) as typeof fetch;

    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const watched = extension.repo.getWatchedRepoById(repo.id);
      // Freshness was NOT advanced by PR #1's success while PR #2 was skipped.
      expect(watched?.pollCursor?.lastReactionPollAt).toBe(priorReactionAt);
    } finally {
      await extension.stop();
    }
  });

  test('a headerless secondary-rate-limit reaction PR does not advance freshness', async () => {
    const db = setupDb();
    const { service } = setupExternalEventService(db);
    const extension = new GitHubEventExtension(db, 'token');
    await extension.start({
      publisher: service,
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    });
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    const priorReactionAt = Date.now() - 3_600_000;
    extension.repo.updatePollCursor(repo.id, { lastReactionPollAt: priorReactionAt });

    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/issues/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls/comments')) return pollingResponse([]);
      if (path.endsWith('/pulls'))
        return pollingResponse([
          createPullRequestRow(1, { head: { sha: 's1' } }),
          createPullRequestRow(2, { head: { sha: 's2' } }),
        ]);
      // PR #1 succeeds with a healthy budget (sets reactionPolledAt).
      if (path.endsWith('/issues/1/reactions')) return pollingResponse([]);
      // PR #2: headerless 403 secondary-rate-limit body, NO X-RateLimit headers.
      // This break path must also count as a skipped target.
      if (path.endsWith('/issues/2/reactions'))
        return new Response(
          JSON.stringify({ message: 'You have exceeded a secondary rate limit' }),
          {
            status: 403,
          }
        );
      return pollingResponse([]);
    }) as typeof fetch;

    try {
      await extension.pollWatchedRepo(extension.repo.listPollingRepos()[0], fetchImpl);
      const watched = extension.repo.getWatchedRepoById(repo.id);
      // The headerless secondary limit on PR #2 is a skip: PR #1's success must
      // not advance freshness over the un-observed later PR.
      expect(watched?.pollCursor?.lastReactionPollAt).toBe(priorReactionAt);
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
        validatedFingerprint: expect.any(String),
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
      expect(status).toEqual({
        configured: false,
        source: 'none',
        autoRegisteredHookCount: 0,
        validatedFingerprint: 'none',
      });
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
    const previousPublicUrl = process.env.HYPERNEO_PUBLIC_URL;
    process.env.HYPERNEO_PUBLIC_URL = 'https://example.com';
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
      if (previousPublicUrl === undefined) delete process.env.HYPERNEO_PUBLIC_URL;
      else process.env.HYPERNEO_PUBLIC_URL = previousPublicUrl;
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

  test('syncGitHubPollingCapability clears stale polling capability at startup when interval is 0', async () => {
    const configStore = new RecordingConfigStore({
      globallyEnabled: true,
      polling: true,
    });

    await syncGitHubPollingCapability(configStore, false);

    const global = await configStore.getGlobalConfig('github');
    expect(global.capabilities.polling).toBe(false);
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

  test('refreshPollingInterval preserves active rate-limit deferral', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, { getPollIntervalMs: () => 5_000 });
    const configStore = new RecordingConfigStore({
      globallyEnabled: true,
      polling: true,
    });
    const context = {
      publisher: { publish: async () => {} },
      config: configStore,
      onSourceConfigChanged() {},
    };
    try {
      await extension.start(context);
      const internals = extension as unknown as {
        rateLimitedUntil: number;
        rateLimitedFromRetryAfter: boolean;
        pollTimer: unknown;
      };
      internals.rateLimitedUntil = Date.now() + 60_000;
      internals.rateLimitedFromRetryAfter = true;

      await extension.refreshPollingInterval();

      expect(internals.pollTimer).not.toBeNull();
      expect((internals.pollTimer as { _idleTimeout?: number })._idleTimeout).toBeGreaterThan(
        50_000
      );
    } finally {
      await extension.stop();
    }
  });

  test('refreshPollingInterval does not schedule over an active poll cycle', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, { getPollIntervalMs: () => 5_000 });
    const configStore = new RecordingConfigStore({
      globallyEnabled: true,
      polling: true,
    });
    const context = {
      publisher: { publish: async () => {} },
      config: configStore,
      onSourceConfigChanged() {},
    };
    let releasePoll!: () => void;
    const activePollCycle = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    try {
      await extension.start(context);
      const internals = extension as unknown as {
        activePollCycle: Promise<void> | undefined;
        pollTimer: unknown;
      };
      if (internals.pollTimer) clearTimeout(internals.pollTimer as ReturnType<typeof setTimeout>);
      internals.pollTimer = null;
      internals.activePollCycle = activePollCycle;

      await extension.refreshPollingInterval();

      expect(internals.pollTimer).toBeNull();
    } finally {
      releasePoll();
      await extension.stop();
    }
  });

  test('space.github.enable re-enables webhook delivery without polling re-arm when interval is 0', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, { getPollIntervalMs: () => 0 });
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
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        pollingEnabled: true,
        webhookEnabled: true,
        webhookSecret: 'secret',
        enabled: false,
      });

      await clientHub.request('space.github.enable', { spaceId: 'space-1' });

      const stored = extension.repo.getWatchedRepo('space-1', 'acme', 'widgets')!;
      expect(stored.enabled).toBe(true);
      expect(extension.repo.isSpaceEnabled('space-1')).toBe(true);
      const global = await configStore.getGlobalConfig('github');
      expect(global.capabilities.polling).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('space.github.watchRepo allows preserving existing pollingEnabled while interval is 0', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, { getPollIntervalMs: () => 0 });
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
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        pollingEnabled: true,
      });

      const result = await clientHub.request<{ watchedRepo: { enabled: boolean } }>(
        'space.github.watchRepo',
        {
          spaceId: 'space-1',
          owner: 'acme',
          repo: 'widgets',
          pollingEnabled: true,
          enabled: false,
        }
      );

      expect(result.watchedRepo.enabled).toBe(false);
      const global = await configStore.getGlobalConfig('github');
      expect(global.capabilities.polling).toBe(false);
    } finally {
      await extension.stop();
    }
  });

  test('space.github.setPollingEnabled true rejects when global interval is 0', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, undefined, { getPollIntervalMs: () => 0 });
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
      extension.repo.upsertWatchedRepo({
        spaceId: 'space-1',
        owner: 'acme',
        repo: 'widgets',
        pollingEnabled: false,
      });

      await expect(
        clientHub.request('space.github.setPollingEnabled', { spaceId: 'space-1', enabled: true })
      ).rejects.toThrow('GitHub polling is disabled globally');

      const global = await configStore.getGlobalConfig('github');
      expect(global.capabilities.polling).toBe(false);
      expect(extension.repo.listWatchedRepos('space-1')[0].pollingEnabled).toBe(false);
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

  // -------------------------------------------------------------------------
  // status webhook (commit-status API — external/legacy CI: Jenkins/Travis/custom)
  // -------------------------------------------------------------------------

  function statusWebhookPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 555,
      sha: 'abc123',
      name: 'continuous-integration/jenkins',
      state: 'failure',
      description: 'Build failed in stage "test"',
      target_url: 'https://jenkins.example.com/job/widgets/42',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:01:00Z',
      repository: baseRepo,
      sender: { login: 'jenkins-bot', type: 'Bot' },
      ...overrides,
    };
  }

  function statusFetchImpl(prRows: unknown[], calls?: string[]): typeof fetch {
    return (async (url: string | URL | Request) => {
      const u = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
      calls?.push(u);
      if (u.includes('/commits/') && u.includes('/pulls')) {
        return new Response(JSON.stringify(prRows), {
          status: 200,
          headers: { 'X-RateLimit-Remaining': '5000' },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;
  }

  test('status webhook resolves commit SHA → PR and publishes status_failure', async () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO spaces (id, slug, name, workspace_path, status, created_at, updated_at) VALUES ('space-1', 'space-1', 'Space', '/tmp', 'active', 1, 1)`
    ).run();
    const { service, received } = setupExternalEventService(db);
    const fetchCalls: string[] = [];
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: statusFetchImpl([{ number: 7, head: { sha: 'abc123' } }], fetchCalls),
    });
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

    const payload = statusWebhookPayload();
    const raw = JSON.stringify(payload);
    const response = await extension.routes[0].handle(
      webhookRequest(payload, 'status', await createSignature(raw, 'secret'))
    );

    expect(response.status).toBe(200);
    expect(fetchCalls[0]).toContain('/commits/abc123/pulls');
    expect(received).toHaveLength(1);
    expect(received[0].topic).toBe('github/acme/widgets/pull_request/7.status_failure');
    expect(received[0].payload).toMatchObject({
      state: 'failure',
      context: 'continuous-integration/jenkins',
      sha: 'abc123',
    });
    await extension.stop();
  });

  test('status webhook surfaces pending too (blocked-waiting-on-check)', async () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO spaces (id, slug, name, workspace_path, status, created_at, updated_at) VALUES ('space-1', 'space-1', 'Space', '/tmp', 'active', 1, 1)`
    ).run();
    const { service, received } = setupExternalEventService(db);
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: statusFetchImpl([{ number: 7, head: { sha: 'abc123' } }]),
    });
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

    const payload = statusWebhookPayload({ state: 'pending' });
    const raw = JSON.stringify(payload);
    const response = await extension.routes[0].handle(
      webhookRequest(payload, 'status', await createSignature(raw, 'secret'))
    );

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].topic).toBe('github/acme/widgets/pull_request/7.status_pending');
    await extension.stop();
  });

  test('status webhook drops the event when the commit is no PR head', async () => {
    const db = setupDb();
    const published: ExternalEvent[] = [];
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: statusFetchImpl([]),
    });
    const context = {
      publisher: { publish: async (event: ExternalEvent) => published.push(event) },
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

    const payload = statusWebhookPayload();
    const raw = JSON.stringify(payload);
    const response = await extension.routes[0].handle(
      webhookRequest(payload, 'status', await createSignature(raw, 'secret'))
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ reason: 'no_pull_request' });
    expect(published).toHaveLength(0);
    await extension.stop();
  });

  test('status webhook filters out PRs whose head sha differs (merged-commit false positives)', async () => {
    const db = setupDb();
    const published: ExternalEvent[] = [];
    // /commits/{sha}/pulls also returns PRs that merged the commit; those have a
    // different head sha and must not be attributed to the commit-status.
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: statusFetchImpl([
        { number: 7, head: { sha: 'deadbeef' }, merged_at: '2026-01-01T00:00:00Z' },
      ]),
    });
    const context = {
      publisher: { publish: async (event: ExternalEvent) => published.push(event) },
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

    const payload = statusWebhookPayload();
    const raw = JSON.stringify(payload);
    const response = await extension.routes[0].handle(
      webhookRequest(payload, 'status', await createSignature(raw, 'secret'))
    );

    expect(response.status).toBe(202);
    expect(published).toHaveLength(0);
    await extension.stop();
  });

  test('status webhook returns 404 when the signature-matched repo is not watched', async () => {
    const db = setupDb();
    const published: ExternalEvent[] = [];
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: statusFetchImpl([{ number: 7, head: { sha: 'abc123' } }]),
    });
    const context = {
      publisher: { publish: async (event: ExternalEvent) => published.push(event) },
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

    // Signature matches (shared secret) but the payload repo is acme/other.
    const payload = {
      ...statusWebhookPayload(),
      repository: { id: 2, name: 'other', full_name: 'acme/other', owner: { login: 'acme' } },
    };
    const raw = JSON.stringify(payload);
    const response = await extension.routes[0].handle(
      webhookRequest(payload, 'status', await createSignature(raw, 'secret'))
    );

    expect(response.status).toBe(404);
    expect(published).toHaveLength(0);
    await extension.stop();
  });

  test('status webhook skips SHA→PR resolution when no watched target is enabled', async () => {
    const db = setupDb();
    const published: ExternalEvent[] = [];
    const fetchCalls: string[] = [];
    const extension = new GitHubEventExtension(db, 'token', {
      fetchImpl: statusFetchImpl([{ number: 7, head: { sha: 'abc123' } }], fetchCalls),
    });
    const context = {
      publisher: { publish: async (event: ExternalEvent) => published.push(event) },
      config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    // The signature still validates (webhook_secret present), but the watched
    // row is disabled — so the quota-consuming resolution GET must not fire.
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
      enabled: false,
    });

    const payload = statusWebhookPayload();
    const raw = JSON.stringify(payload);
    const response = await extension.routes[0].handle(
      webhookRequest(payload, 'status', await createSignature(raw, 'secret'))
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ spaces: 0 });
    expect(fetchCalls).toHaveLength(0);
    expect(published).toHaveLength(0);
    await extension.stop();
  });
});
