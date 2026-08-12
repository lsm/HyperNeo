import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { MessageHub, type RequestHandler, generateUUID } from '@hyperneo/shared';
import { beforeEach, describe, expect, test } from 'bun:test';
import { ExternalEventService } from '../../../../src/lib/external-events/external-event-service';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import { ExternalEventExtensionManager } from '../../../../src/lib/external-events/extension-manager';
import type {
  ExternalEventExtension,
  HttpExternalEventExtension,
  RpcExternalEventExtension,
} from '../../../../src/lib/external-events/types';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github';
import {
  createInternalEventBus,
  type InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import { createTables, runMigrations } from '../../../../src/storage/schema';

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
  db.prepare(
    `UPDATE external_event_extension_configs
		 SET globally_enabled = 1, capabilities_json = ?
		 WHERE source = 'github'`
  ).run(JSON.stringify({ webhooks: true, polling: true, rpcConfig: true }));
  db.prepare(
    `INSERT INTO spaces (id, slug, name, workspace_path, status, created_at, updated_at)
		 VALUES ('space-1', 'space-1', 'Space', '/tmp', 'active', 1, 1)`
  ).run();
  return db;
}

function getRequestHandler(hub: MessageHub, method: string): RequestHandler | undefined {
  return (hub as unknown as { requestHandlers: Map<string, RequestHandler> }).requestHandlers.get(
    method
  );
}

function isHttpExternalEventExtension(
  extension: ExternalEventExtension
): extension is HttpExternalEventExtension {
  return 'routes' in extension;
}

function isRpcExternalEventExtension(
  extension: ExternalEventExtension
): extension is RpcExternalEventExtension {
  return 'registerRpcHandlers' in extension;
}

function seedTask(db: BunDatabase): void {
  db.prepare(
    `INSERT INTO space_workflows (id, space_id, name, description, channels, created_at, updated_at)
		 VALUES ('wf-1', 'space-1', 'wf', '', '[]', 1, 1)`
  ).run();
  db.prepare(
    `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, description, status, created_at, updated_at)
		 VALUES ('run-1', 'space-1', 'wf-1', 'run', '', 'in_progress', 1, 1)`
  ).run();
  db.prepare(
    `INSERT INTO space_tasks (id, space_id, task_number, title, description, status, priority, labels, workflow_run_id, depends_on, created_at, updated_at)
		 VALUES ('task-1', 'space-1', 1, 'task', 'https://github.com/acme/widgets/pull/7', 'in_progress', 'normal', '[]', 'run-1', '[]', 1, 1)`
  ).run();
}

function githubPayload(): unknown {
  return {
    action: 'created',
    repository: {
      id: 1,
      name: 'widgets',
      full_name: 'acme/widgets',
      owner: { login: 'acme' },
    },
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

function pollingRow(): unknown {
  return {
    id: 202,
    body: 'poll comment',
    html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-202',
    issue_url: 'https://api.github.com/repos/acme/widgets/issues/7',
    issue: { number: 7, pull_request: { url: 'api' } },
    user: { login: 'bot', type: 'Bot' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

describe('external event extension startup primitives', () => {
  let db: BunDatabase;
  let bus: InternalEventBus<Record<string, unknown>>;
  let service: ExternalEventService;
  let config: ExternalEventExtensionConfigStore;

  beforeEach(() => {
    db = setupDb();
    bus = createInternalEventBus<Record<string, unknown>>();
    service = new ExternalEventService(new ExternalEventStore(db), bus);
    config = new ExternalEventExtensionConfigStore(db);
  });

  test('registers GitHub routes and RPC handlers when globally enabled', async () => {
    const manager = new ExternalEventExtensionManager();
    const extension = new GitHubEventExtension(db);
    manager.register(extension);
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const changes: Array<{ source: string; spaceId?: string; kind: string }> = [];
    const context = {
      publisher: service,
      config,
      onSourceConfigChanged(change: { source: string; spaceId?: string; kind: string }) {
        changes.push(change);
      },
    };

    for (const registered of manager.getAll()) {
      const globalConfig = await context.config.getGlobalConfig(registered.sourceId);
      if (!globalConfig.globallyEnabled) continue;
      if (isHttpExternalEventExtension(registered)) {
        manager.registerRoutes(registered.routes, context);
      }
      if (isRpcExternalEventExtension(registered)) {
        manager.registerRpcHandlers(registered.sourceId, hub, context);
      }
      await manager.startExtension(registered.sourceId, context);
    }

    seedTask(db);
    const watchRepo = getRequestHandler(hub, 'space.github.watchRepo');
    expect(watchRepo).toBeDefined();
    const watchResult = (await watchRepo!({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      webhookSecret: 'secret',
    })) as { webhookUrl: string };
    expect(watchResult.webhookUrl).toBe('/webhook/github/space');
    expect(changes).toEqual([
      { source: 'github', spaceId: 'space-1', kind: 'watched_repo_changed' },
    ]);

    const payload = githubPayload();
    const raw = JSON.stringify(payload);
    const route = manager
      .getRegisteredRoutes()
      .find((route) => route.path === '/webhook/github/space');
    expect(route).toBeDefined();
    const response = await route!.handle(
      new Request('http://localhost/webhook/github/space', {
        method: 'POST',
        headers: {
          'X-Hub-Signature-256': await createSignature(raw, 'secret'),
          'X-GitHub-Event': 'issue_comment',
          'X-GitHub-Delivery': generateUUID(),
        },
        body: raw,
      })
    );
    expect(response?.status).toBe(200);

    const stored = db.prepare(`SELECT source, topic, state FROM space_external_events`).get() as {
      source: string;
      topic: string;
      state: string;
    };
    expect(stored).toEqual({
      source: 'github',
      topic: 'github/acme/widgets/pull_request/7.comment_created',
      state: 'published',
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM space_github_events`).get()).toEqual({
      count: 0,
    });
    await extension.stop();
  });

  test('pollOnce publishes bus events without legacy task activity records', async () => {
    seedTask(db);
    const extension = new GitHubEventExtension(db);
    const context = {
      publisher: service,
      config,
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    const rowsByUrl = new Map<string, unknown[]>([
      ['/issues/comments', [pollingRow()]],
      ['/pulls/comments', []],
      ['/pulls', []],
    ]);
    const fetchImpl = async (url: string | URL | Request) => {
      const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
      const path = new URL(href).pathname;
      const rows = rowsByUrl.get(path.replace('/repos/acme/widgets', '')) ?? [];
      return new Response(JSON.stringify(rows), { status: 200 });
    };

    expect(await extension.pollOnce(fetchImpl as typeof fetch)).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM space_external_events`).get()).toEqual({
      count: 1,
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM space_github_events`).get()).toEqual({
      count: 0,
    });
    await extension.stop();
  });

  test('pollOnce includes watched repos without per-space config rows', async () => {
    seedTask(db);
    db.prepare(
      `INSERT INTO spaces (id, slug, name, workspace_path, status, created_at, updated_at)
			 VALUES ('space-2', 'space-2', 'Space 2', '/tmp/space-2', 'active', 1, 1)`
    ).run();
    const extension = new GitHubEventExtension(db);
    const context = {
      publisher: service,
      config,
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-2',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    await config.setSpaceConfig('space-1', 'github', {
      spaceId: 'space-1',
      source: 'github',
      enabled: true,
      settings: {},
    });
    const rowsByUrl = new Map<string, unknown[]>([
      ['/issues/comments', [pollingRow()]],
      ['/pulls/comments', []],
      ['/pulls', []],
    ]);
    const fetchImpl = async (url: string | URL | Request) => {
      const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
      const path = new URL(href).pathname;
      const rows = rowsByUrl.get(path.replace('/repos/acme/widgets', '')) ?? [];
      return new Response(JSON.stringify(rows), { status: 200 });
    };

    expect(await extension.pollOnce(fetchImpl as typeof fetch)).toBe(2);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM space_external_events`).get()).toEqual({
      count: 2,
    });
    await extension.stop();
  });

  test('seeds GitHub globally enabled independent of one-time env state', async () => {
    expect(await config.getGlobalConfig('github')).toMatchObject({
      source: 'github',
      globallyEnabled: true,
      capabilities: { webhooks: true, polling: true, rpcConfig: true },
    });
  });

  test('listConfig returns persisted space GitHub configuration after watchRepo RPC', async () => {
    const extension = new GitHubEventExtension(db);
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const context = {
      publisher: service,
      config,
      onSourceConfigChanged() {},
    };
    extension.registerRpcHandlers(hub, context);

    const watchRepo = getRequestHandler(hub, 'space.github.watchRepo');
    expect(watchRepo).toBeDefined();
    await watchRepo!({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
      webhookSecret: 'secret',
    });

    const listConfig = getRequestHandler(hub, 'space.github.listConfig');
    expect(listConfig).toBeDefined();
    expect(await listConfig!({ spaceId: 'space-1' })).toMatchObject({
      spaceId: 'space-1',
      source: 'github',
      enabled: true,
      settings: {
        watchedRepos: [
          {
            owner: 'acme',
            repo: 'widgets',
            pollingEnabled: true,
            webhookSecret: 'configured',
          },
        ],
      },
    });
  });

  test('stop clears the GitHub extension poll timer', async () => {
    const extension = new GitHubEventExtension(db);
    const context = {
      publisher: service,
      config,
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    expect((extension as unknown as { pollTimer: unknown }).pollTimer).not.toBeNull();

    await extension.stop();

    expect((extension as unknown as { pollTimer: unknown }).pollTimer).toBeNull();
  });

  test('scheduled poll cycle skips polling when capability is disabled after start', async () => {
    const extension = new GitHubEventExtension(db);
    const context = {
      publisher: service,
      config,
      onSourceConfigChanged() {},
    };
    await extension.start(context);
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    db.prepare(
      `UPDATE external_event_extension_configs SET capabilities_json = ? WHERE source = 'github'`
    ).run(JSON.stringify({ webhooks: true, polling: false, rpcConfig: true }));

    await (
      extension as unknown as {
        runPollCycle(): Promise<void>;
      }
    ).runPollCycle();

    expect(db.prepare(`SELECT COUNT(*) AS count FROM space_external_events`).get()).toEqual({
      count: 0,
    });
    expect(
      db.prepare(`SELECT last_poll_at FROM space_github_watched_repos WHERE owner = 'acme'`).get()
    ).toEqual({ last_poll_at: null });
    await extension.stop();
  });

  test('pollOnce RPC rejects when polling capability is explicitly disabled', async () => {
    db.prepare(
      `UPDATE external_event_extension_configs SET capabilities_json = ? WHERE source = 'github'`
    ).run(JSON.stringify({ webhooks: true, polling: false, rpcConfig: true }));
    const extension = new GitHubEventExtension(db);
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const context = {
      publisher: service,
      config,
      onSourceConfigChanged() {},
    };
    extension.registerRpcHandlers(hub, context);

    const pollOnce = getRequestHandler(hub, 'space.github.pollOnce');
    expect(pollOnce).toBeDefined();
    await expect(pollOnce!({})).rejects.toThrow('GitHub polling capability is disabled');
  });

  test('pollOnce RPC allows missing polling capability', async () => {
    db.prepare(
      `UPDATE external_event_extension_configs SET capabilities_json = ? WHERE source = 'github'`
    ).run(JSON.stringify({ webhooks: true, rpcConfig: true }));
    const extension = new GitHubEventExtension(db);
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const context = {
      publisher: service,
      config,
      onSourceConfigChanged() {},
    };
    extension.registerRpcHandlers(hub, context);

    const pollOnce = getRequestHandler(hub, 'space.github.pollOnce');
    expect(pollOnce).toBeDefined();
    expect(await pollOnce!({})).toEqual({ count: 0 });
  });

  test('does not register RPC handlers when rpcConfig capability is disabled', async () => {
    db.prepare(
      `UPDATE external_event_extension_configs SET capabilities_json = ? WHERE source = 'github'`
    ).run(JSON.stringify({ webhooks: true, polling: true, rpcConfig: false }));
    const manager = new ExternalEventExtensionManager();
    manager.register(new GitHubEventExtension(db));
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const context = {
      publisher: service,
      config,
      onSourceConfigChanged() {},
    };

    for (const registered of manager.getAll()) {
      const globalConfig = await context.config.getGlobalConfig(registered.sourceId);
      if (!globalConfig.globallyEnabled) continue;
      if (isRpcExternalEventExtension(registered) && globalConfig.capabilities.rpcConfig) {
        manager.registerRpcHandlers(registered.sourceId, hub, context);
      }
    }

    expect(getRequestHandler(hub, 'space.github.watchRepo')).toBeUndefined();
    expect(getRequestHandler(hub, 'space.github.pollOnce')).toBeUndefined();
  });

  test('registered RPC handlers reject when rpcConfig capability is disabled later', async () => {
    const extension = new GitHubEventExtension(db);
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const context = {
      publisher: service,
      config,
      onSourceConfigChanged() {},
    };
    extension.registerRpcHandlers(hub, context);
    db.prepare(
      `UPDATE external_event_extension_configs SET capabilities_json = ? WHERE source = 'github'`
    ).run(JSON.stringify({ webhooks: true, polling: true, rpcConfig: false }));

    const listConfig = getRequestHandler(hub, 'space.github.listConfig');
    expect(listConfig).toBeDefined();
    await expect(listConfig!({ spaceId: 'space-1' })).rejects.toThrow(
      'GitHub RPC configuration capability is disabled'
    );
  });

  test('does not register disabled extension routes or RPC handlers', async () => {
    db.prepare(
      `UPDATE external_event_extension_configs SET globally_enabled = 0 WHERE source = 'github'`
    ).run();
    const manager = new ExternalEventExtensionManager();
    manager.register(new GitHubEventExtension(db));
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const context = {
      publisher: service,
      config,
      onSourceConfigChanged() {},
    };

    for (const registered of manager.getAll()) {
      const globalConfig = await context.config.getGlobalConfig(registered.sourceId);
      if (!globalConfig.globallyEnabled) continue;
      if (isHttpExternalEventExtension(registered)) {
        manager.registerRoutes(registered.routes, context);
      }
      if (isRpcExternalEventExtension(registered)) {
        manager.registerRpcHandlers(registered.sourceId, hub, context);
      }
      await manager.startExtension(registered.sourceId, context);
    }

    expect(manager.getRegisteredRoutes()).toEqual([]);
    expect(getRequestHandler(hub, 'space.github.pollOnce')).toBeUndefined();
  });
});
