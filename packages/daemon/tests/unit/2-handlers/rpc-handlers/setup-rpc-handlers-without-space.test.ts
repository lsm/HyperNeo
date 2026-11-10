import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  RPCHandlerDependencies,
  RPCHandlerSetupResult,
} from '../../../../src/lib/rpc-handlers';
import { setupRPCHandlers } from '../../../../src/lib/rpc-handlers';
import { DaemonExtensions } from '../../../../src/lib/extensions/contract.ts';
import type { OperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { Database } from '../../../../src/storage/index';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';

function noopProxy(overrides: Record<string, unknown> = {}): unknown {
  const make = (): unknown =>
    new Proxy((() => {}) as unknown as () => unknown, {
      get: (_target, prop) => {
        if (typeof prop === 'string' && prop in overrides) return overrides[prop];
        if (prop === 'then') return undefined;
        if (prop === Symbol.toPrimitive) return () => '';
        return make();
      },
      apply: () => make(),
    });
  return make();
}

function session(id: string, parentSessionId: string | null): Session {
  const now = new Date().toISOString();
  return {
    id,
    title: id,
    workspacePath: tmpdir(),
    createdAt: now,
    lastActiveAt: now,
    status: 'active',
    config: { model: 'test', maxTokens: 1, temperature: 0 },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
    parentSessionId,
  } as Session;
}

describe('setupRPCHandlers without a Space factory', () => {
  let db: Database;
  let dbPath: string;
  let setup: RPCHandlerSetupResult<never>;
  let provider: (() => OperationRegistry) | undefined;
  let handlers: Map<string, (data: unknown, context: unknown) => Promise<unknown>>;
  let deleted: string[];

  beforeEach(async () => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'rpc-no-space-')), 'test.db');
    db = new Database(dbPath);
    const reactiveDb = createReactiveDatabase(db);
    await db.initialize(reactiveDb);
    handlers = new Map();
    deleted = [];
    const messageHub = noopProxy({
      onRequest: (method: string, handler: (data: unknown, context: unknown) => Promise<unknown>) =>
        handlers.set(method, handler),
    });
    setup = await setupRPCHandlers({
      extensions: new DaemonExtensions(db.getDatabase(), messageHub as never),
      messageHub,
      sessionManager: noopProxy({
        getCachedSession: () => null,
        deleteSessionResources: async (id: string) => {
          deleted.push(id);
        },
        setDefaultOperationRegistryProvider: (next: () => OperationRegistry) => {
          provider = next;
        },
      }),
      authManager: noopProxy(),
      settingsManager: noopProxy(),
      daemonConfigService: noopProxy(),
      config: {
        host: 'localhost',
        port: 8484,
        nodeEnv: 'test',
        dbPath,
        workspaceRoot: tmpdir(),
        defaultModel: 'claude-sonnet-4-5-20250929',
        maxTokens: 4096,
        temperature: 0.7,
      },
      internalEventBus: noopProxy(),
      commandBus: noopProxy(),
      externalEventExtensionManager: noopProxy(),
      externalEventExtensionConfigStore: noopProxy(),
      externalEventExtensionContext: noopProxy(),
      db,
      jobQueue: db.getJobQueueRepo(),
      jobProcessor: noopProxy(),
      messageDeliveryProcessor: noopProxy(),
      reactiveDb,
      liveQueries: noopProxy(),
      skillsManager: noopProxy(),
      mcpImportService: noopProxy(),
    } as unknown as RPCHandlerDependencies);
  });

  afterEach(async () => {
    try {
      await setup?.cleanup();
    } finally {
      try {
        db?.close();
      } finally {
        rmSync(dirname(dbPath), { recursive: true, force: true });
      }
    }
  });

  it('returns no Space services', () => {
    expect(setup.space).toBeUndefined();
    expect(db.spaceSessions).toBeUndefined();
  });

  it('gives sessions a core operation registry without Space families', () => {
    const registry = provider?.();
    expect(registry?.get('settings.model.get')).toBeDefined();
    expect(registry?.get('space.list')).toBeUndefined();
  });

  it('keeps clone admission and cascade on session.delete', async () => {
    await db.createSession(session('parent', null));
    await db.createSession(session('clone', 'parent'));
    const remove = handlers.get('session.delete');

    expect(await remove?.({ sessionId: 'parent' }, {})).toMatchObject({
      success: false,
      reason: 'has_clones',
      clones: [{ id: 'clone' }],
    });
    expect(deleted).toEqual([]);

    await remove?.({ sessionId: 'parent', children: 'cascade' }, {});
    expect(deleted).toEqual(['clone', 'parent']);
  });
});
