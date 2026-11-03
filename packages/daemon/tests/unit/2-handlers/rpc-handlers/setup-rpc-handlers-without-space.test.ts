import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
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

describe('setupRPCHandlers without a Space factory', () => {
  let db: Database;
  let dbPath: string;
  let setup: RPCHandlerSetupResult<never>;
  let provider: (() => OperationRegistry) | undefined;

  beforeEach(async () => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'rpc-no-space-')), 'test.db');
    db = new Database(dbPath);
    const reactiveDb = createReactiveDatabase(db);
    await db.initialize(reactiveDb);
    const messageHub = noopProxy();
    setup = await setupRPCHandlers({
      extensions: new DaemonExtensions(db.getDatabase(), messageHub as never),
      messageHub,
      sessionManager: noopProxy({
        getCachedSession: () => null,
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
      externalEventStore: noopProxy(),
      externalEventService: noopProxy(),
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
  });

  it('gives sessions a core operation registry without Space families', () => {
    const registry = provider?.();
    expect(registry?.get('settings.model.get')).toBeDefined();
    expect(registry?.get('space.list')).toBeUndefined();
  });
});
