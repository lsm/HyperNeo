import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import { MessageHub } from '@hyperneo/shared/message-hub/message-hub.ts';
import { ExternalEventExtensionManager } from '../../../../src/lib/external-events/extension-manager';
import type {
  ExternalEventExtension,
  ExternalEventExtensionContext,
  RpcExternalEventExtension,
} from '../../../../src/lib/external-events/types';

let db: Database;
let config: ExternalEventExtensionConfigStore;
let context: ExternalEventExtensionContext;
let manager: ExternalEventExtensionManager;

beforeEach(() => {
  db = new Database(':memory:');
  config = new ExternalEventExtensionConfigStore(db);
  context = {
    publisher: { publish: async () => ({ outcome: 'published', eventId: 'evt-1' }) },
    config,
    onSourceConfigChanged() {},
  };
  manager = new ExternalEventExtensionManager();
});

describe('ExternalEventExtensionManager', () => {
  test('registers and unregisters extensions', () => {
    const extension = createExtension('github');

    manager.register(extension);
    expect(manager.getExtension('github')).toBe(extension);

    manager.unregister('github');
    expect(manager.getExtension('github')).toBeUndefined();
  });

  test('rejects duplicate registrations', () => {
    manager.register(createExtension('github'));
    expect(() => manager.register(createExtension('github'))).toThrow('already registered');
  });

  test('rejects source IDs with edge whitespace', () => {
    expect(() => manager.register(createExtension(' github '))).toThrow('edge whitespace');
  });

  test('does not start globally disabled extensions', async () => {
    const extension = createExtension('github');
    manager.register(extension);

    await manager.startExtension('github', context);

    expect(extension.starts).toBe(0);
    expect(extension.stops).toBe(0);
  });

  test('starts and stops globally enabled extensions once', async () => {
    const extension = createExtension('github');
    manager.register(extension);
    await config.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { webhooks: true },
    });

    await manager.startExtension('github', context);
    await manager.startExtension('github', context);
    expect(extension.starts).toBe(1);

    await manager.stopExtension('github');
    await manager.stopExtension('github');
    expect(extension.stops).toBe(1);
  });

  test('serializes concurrent starts for the same extension', async () => {
    const { extension, releaseStart } = createBlockedStartExtension('github');
    manager.register(extension);
    await config.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { webhooks: true },
    });

    const firstStart = manager.startExtension('github', context);
    const secondStart = manager.startExtension('github', context);
    await releaseStart.waitUntilBlocked();

    releaseStart.resolve();
    await Promise.all([firstStart, secondStart]);

    expect(extension.starts).toBe(1);
  });

  test('retries start after awaiting an in-flight start that did not start', async () => {
    const extension = createExtension('github');
    let configReads = 0;
    manager.register(extension);
    await config.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: false,
      capabilities: { webhooks: true },
    });
    const originalGetGlobalConfig = config.getGlobalConfig.bind(config);
    config.getGlobalConfig = async (source) => {
      configReads += 1;
      await Promise.resolve();
      return originalGetGlobalConfig(source);
    };

    const firstStart = manager.startExtension('github', context);
    const secondStart = (async () => {
      await waitFor(() => configReads > 0);
      await config.setGlobalConfig('github', {
        source: 'github',
        globallyEnabled: true,
        capabilities: { webhooks: true },
      });
      await manager.startExtension('github', context);
    })();

    await Promise.all([firstStart, secondStart]);

    expect(extension.starts).toBe(1);
    expect(configReads).toBe(2);
  });

  test('rejects unregister while start is in flight', async () => {
    const { extension, releaseStart } = createBlockedStartExtension('github');
    manager.register(extension);
    await config.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { webhooks: true },
    });

    const start = manager.startExtension('github', context);
    await releaseStart.waitUntilBlocked();

    expect(() => manager.unregister('github')).toThrow('started external event extension');

    releaseStart.resolve();
    await start;
    await manager.stopExtension('github');
    expect(extension.starts).toBe(1);
    expect(extension.stops).toBe(1);
  });

  test('waits for in-flight start before stopping extension', async () => {
    const { extension, releaseStart } = createBlockedStartExtension('github');
    manager.register(extension);
    await config.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { webhooks: true },
    });

    const start = manager.startExtension('github', context);
    await releaseStart.waitUntilBlocked();
    const stop = manager.stopExtension('github');

    releaseStart.resolve();
    await Promise.all([start, stop]);

    expect(extension.starts).toBe(1);
    expect(extension.stops).toBe(1);
  });

  test('swallows in-flight start failures while stopping extension', async () => {
    const extension: TestExtension = {
      sourceId: 'github',
      starts: 0,
      stops: 0,
      async start() {
        this.starts += 1;
        await Promise.resolve();
        throw new Error('start failed');
      },
      async stop() {
        this.stops += 1;
      },
    };
    manager.register(extension);
    await config.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { webhooks: true },
    });

    const start = manager.startExtension('github', context);
    const stop = manager.stopExtension('github');

    await expect(start).rejects.toThrow('start failed');
    await expect(stop).resolves.toBeUndefined();
    expect(extension.starts).toBe(1);
    expect(extension.stops).toBe(0);
  });

  test('allows restart after stop when still globally enabled', async () => {
    const extension = createExtension('github');
    manager.register(extension);
    await config.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: {},
    });

    await manager.startExtension('github', context);
    await manager.stopExtension('github');
    await manager.startExtension('github', context);

    expect(extension.starts).toBe(2);
    expect(extension.stops).toBe(1);
  });

  test('waits for an in-flight stop before starting again', async () => {
    const { extension, releaseStop } = createBlockedStopExtension('github');
    manager.register(extension);
    await config.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { webhooks: true },
    });

    await manager.startExtension('github', context);
    const stop = manager.stopExtension('github');
    await releaseStop.waitUntilBlocked();
    const start = manager.startExtension('github', context);

    releaseStop.resolve();
    await Promise.all([stop, start]);

    expect(extension.starts).toBe(2);
    expect(extension.stops).toBe(1);
  });

  test('removes registered routes for source-owned route arrays on unregister', () => {
    const routes = [
      {
        method: 'POST' as const,
        path: '/webhooks/github',
        handle: async () => new Response('ok'),
      },
    ];
    manager.register({
      sourceId: 'github',
      routes,
      async start() {},
      async stop() {},
    });

    manager.registerRoutes(routes, context);
    expect(manager.getRegisteredRoutes()).toHaveLength(1);
    expect(manager.getRegisteredRoutes()[0]!.sourceId).toBe('github');

    manager.unregister('github');
    expect(manager.getRegisteredRoutes()).toHaveLength(0);
  });

  test('assigns source ownership for cloned route arrays by method and path', () => {
    const routes = [
      {
        method: 'POST' as const,
        path: '/webhooks/github',
        handle: async () => new Response('ok'),
      },
    ];
    manager.register({
      sourceId: 'github',
      routes,
      async start() {},
      async stop() {},
    });

    manager.registerRoutes(
      routes.map((route) => ({ ...route })),
      context
    );
    expect(manager.getRegisteredRoutes()).toHaveLength(1);
    expect(manager.getRegisteredRoutes()[0]!.sourceId).toBe('github');
  });

  test('assigns source ownership for cloned route arrays regardless of order', () => {
    const routes = [
      {
        method: 'POST' as const,
        path: '/webhooks/github/issues',
        handle: async () => new Response('issues'),
      },
      {
        method: 'POST' as const,
        path: '/webhooks/github/pulls',
        handle: async () => new Response('pulls'),
      },
    ];
    manager.register({
      sourceId: 'github',
      routes,
      async start() {},
      async stop() {},
    });

    manager.registerRoutes(
      routes.toReversed().map((route) => ({ ...route })),
      context
    );

    expect(manager.getRegisteredRoutes()).toHaveLength(2);
    expect(manager.getRegisteredRoutes().map((route) => route.sourceId)).toEqual([
      'github',
      'github',
    ]);
  });

  test('rejects route arrays that do not belong to a registered extension', () => {
    manager.register({
      sourceId: 'github',
      routes: [
        {
          method: 'POST' as const,
          path: '/webhooks/github',
          handle: async () => new Response('ok'),
        },
      ],
      async start() {},
      async stop() {},
    });

    expect(() =>
      manager.registerRoutes(
        [
          {
            method: 'POST' as const,
            path: '/webhooks/slack',
            handle: async () => new Response('ok'),
          },
        ],
        context
      )
    ).toThrow('do not match a registered source');
    expect(manager.getRegisteredRoutes()).toHaveLength(0);
  });

  test('deduplicates route handlers when routes are registered repeatedly', () => {
    const routes = [
      {
        method: 'POST' as const,
        path: '/webhooks/github',
        handle: async () => new Response('ok'),
      },
    ];
    manager.register({
      sourceId: 'github',
      routes,
      async start() {},
      async stop() {},
    });

    manager.registerRoutes(routes, context);
    manager.registerRoutes(routes, context);
    expect(manager.getRegisteredRoutes()).toHaveLength(1);
  });

  test('throws when route array identity matches multiple extensions', () => {
    const routes = [
      {
        method: 'POST' as const,
        path: '/webhooks/events',
        handle: async () => new Response('ok'),
      },
    ];
    manager.register({
      sourceId: 'github',
      routes,
      async start() {},
      async stop() {},
    });
    manager.register({
      sourceId: 'slack',
      routes,
      async start() {},
      async stop() {},
    });

    expect(() => manager.registerRoutes(routes, context)).toThrow('shared by multiple sources');
    expect(manager.getRegisteredRoutes()).toHaveLength(0);
  });

  test('throws when cloned route signatures match multiple extensions', () => {
    const githubRoutes = [
      {
        method: 'POST' as const,
        path: '/webhooks/events',
        handle: async () => new Response('github'),
      },
    ];
    const slackRoutes = [
      {
        method: 'POST' as const,
        path: '/webhooks/events',
        handle: async () => new Response('slack'),
      },
    ];
    manager.register({
      sourceId: 'github',
      routes: githubRoutes,
      async start() {},
      async stop() {},
    });
    manager.register({
      sourceId: 'slack',
      routes: slackRoutes,
      async start() {},
      async stop() {},
    });

    expect(() =>
      manager.registerRoutes(
        [
          {
            method: 'POST' as const,
            path: '/webhooks/events',
            handle: async () => new Response('clone'),
          },
        ],
        context
      )
    ).toThrow('multiple sources');

    manager.registerRoutes(slackRoutes, context);
    expect(manager.getRegisteredRoutes()).toHaveLength(1);
    expect(manager.getRegisteredRoutes()[0]!.sourceId).toBe('slack');
  });

  test('removes source route handlers on stop', async () => {
    const routes = [
      {
        method: 'POST' as const,
        path: '/webhooks/github',
        handle: async () => new Response('ok'),
      },
    ];
    manager.register({
      sourceId: 'github',
      routes,
      async start() {},
      async stop() {},
    });
    await config.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { webhooks: true },
    });

    await manager.startExtension('github', context);
    manager.registerRoutes(routes, context);
    await manager.stopExtension('github');

    expect(manager.getRegisteredRoutes()).toHaveLength(0);
  });

  test('registers and unregisters RPC handlers through tracked unsubscribe callbacks', () => {
    const calls: string[] = [];
    const hub = new MessageHub();
    const originalOnRequest = hub.onRequest.bind(hub);
    hub.onRequest = ((method, handler) => {
      calls.push(`register:${method}`);
      const unsubscribe = originalOnRequest(method, handler);
      return () => {
        calls.push(`unregister:${method}`);
        unsubscribe();
      };
    }) as MessageHub['onRequest'];
    const extension: RpcExternalEventExtension = {
      sourceId: 'github',
      async start() {},
      async stop() {},
      registerRpcHandlers(hubLike) {
        hubLike.onRequest('space.github.watchRepo', () => ({ ok: true }));
        hubLike.onRequest('space.github.pollOnce', () => ({ ok: true }));
      },
    };
    manager.register(extension);

    manager.registerRpcHandlers('github', hub, context);
    expect(calls).toEqual(['register:space.github.watchRepo', 'register:space.github.pollOnce']);

    manager.registerRpcHandlers('github', hub, context);
    expect(calls).toEqual([
      'register:space.github.watchRepo',
      'register:space.github.pollOnce',
      'unregister:space.github.watchRepo',
      'unregister:space.github.pollOnce',
      'register:space.github.watchRepo',
      'register:space.github.pollOnce',
    ]);

    manager.unregister('github');
    expect(calls.slice(-2)).toEqual([
      'unregister:space.github.watchRepo',
      'unregister:space.github.pollOnce',
    ]);
  });

  test('cleans up partially registered RPC handlers when extension registration throws', () => {
    const calls: string[] = [];
    const hub = new MessageHub();
    const originalOnRequest = hub.onRequest.bind(hub);
    hub.onRequest = ((method, handler) => {
      calls.push(`register:${method}`);
      const unsubscribe = originalOnRequest(method, handler);
      return () => {
        calls.push(`unregister:${method}`);
        unsubscribe();
      };
    }) as MessageHub['onRequest'];
    const extension: RpcExternalEventExtension = {
      sourceId: 'github',
      async start() {},
      async stop() {},
      registerRpcHandlers(hubLike) {
        hubLike.onRequest('space.github.watchRepo', () => ({ ok: true }));
        throw new Error('registration failed');
      },
    };
    manager.register(extension);

    expect(() => manager.registerRpcHandlers('github', hub, context)).toThrow(
      'registration failed'
    );
    expect(calls).toEqual(['register:space.github.watchRepo', 'unregister:space.github.watchRepo']);
  });

  test('rejects RPC handler methods already owned by another extension', () => {
    const calls: string[] = [];
    const hub = new MessageHub();
    const originalOnRequest = hub.onRequest.bind(hub);
    hub.onRequest = ((method, handler) => {
      calls.push(`register:${method}`);
      const unsubscribe = originalOnRequest(method, handler);
      return () => {
        calls.push(`unregister:${method}`);
        unsubscribe();
      };
    }) as MessageHub['onRequest'];
    manager.register(createRpcExtension('github', 'space.external.sync'));
    manager.register(createRpcExtension('slack', 'space.external.sync'));

    manager.registerRpcHandlers('github', hub, context);
    expect(() => manager.registerRpcHandlers('slack', hub, context)).toThrow(
      'already registered by "github"'
    );
    expect(calls).toEqual(['register:space.external.sync']);

    manager.unregister('github');
    manager.registerRpcHandlers('slack', hub, context);
    expect(calls).toEqual([
      'register:space.external.sync',
      'unregister:space.external.sync',
      'register:space.external.sync',
    ]);
  });
});

interface TestExtension extends ExternalEventExtension {
  starts: number;
  stops: number;
}

function createRpcExtension(sourceId: string, method: string): RpcExternalEventExtension {
  return {
    sourceId,
    async start() {},
    async stop() {},
    registerRpcHandlers(hubLike) {
      hubLike.onRequest(method, () => ({ ok: true }));
    },
  };
}

function createExtension(sourceId: string): TestExtension {
  return {
    sourceId,
    starts: 0,
    stops: 0,
    async start() {
      this.starts += 1;
    },
    async stop() {
      this.stops += 1;
    },
  };
}

function createBlockedStartExtension(sourceId: string): {
  extension: TestExtension;
  releaseStart: BlockedLifecycleHandle;
} {
  let resolveStart: (() => void) | undefined;
  const releaseStart = createBlockedLifecycleHandle(() => resolveStart);
  return {
    extension: {
      sourceId,
      starts: 0,
      stops: 0,
      async start() {
        this.starts += 1;
        await new Promise<void>((resolve) => {
          resolveStart = resolve;
        });
      },
      async stop() {
        this.stops += 1;
      },
    },
    releaseStart,
  };
}

function createBlockedStopExtension(sourceId: string): {
  extension: TestExtension;
  releaseStop: BlockedLifecycleHandle;
} {
  let resolveStop: (() => void) | undefined;
  const releaseStop = createBlockedLifecycleHandle(() => resolveStop);
  return {
    extension: {
      sourceId,
      starts: 0,
      stops: 0,
      async start() {
        this.starts += 1;
      },
      async stop() {
        this.stops += 1;
        await new Promise<void>((resolve) => {
          resolveStop = resolve;
        });
      },
    },
    releaseStop,
  };
}

function createBlockedLifecycleHandle(
  getResolver: () => (() => void) | undefined
): BlockedLifecycleHandle {
  return {
    resolve() {
      const resolver = getResolver();
      if (!resolver) throw new Error('Lifecycle operation is not blocked yet');
      resolver();
    },
    async waitUntilBlocked() {
      await waitFor(() => getResolver() !== undefined);
    },
  };
}

interface BlockedLifecycleHandle {
  resolve(): void;
  waitUntilBlocked(): Promise<void>;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 10; attempts += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for condition');
}
