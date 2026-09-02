import { describe, expect, test } from 'bun:test';
import { DEFAULT_DAEMON_CONFIG, type DaemonBehaviorConfig } from '@hyperneo/shared';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { runMigration222 } from '../../../../src/storage/schema/m222-daemon-config.ts';
import {
  DAEMON_CONFIG_UPDATED,
  DaemonConfigService,
  DaemonConfigValidationError,
  casDaemonConfigRow,
} from '../../../../src/lib/daemon-config-service.ts';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus.ts';

interface ConfigRow {
  config_json: string;
  updated_at: number;
}

function createDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  runMigration222(db);
  return db;
}

function readConfigRow(db: BunDatabase): ConfigRow | null | undefined {
  return db.prepare(`SELECT config_json, updated_at FROM daemon_config WHERE id = 1`).get() as
    | ConfigRow
    | null
    | undefined;
}

function writeConfigRow(db: BunDatabase, config: unknown): void {
  db.prepare(
    `INSERT OR REPLACE INTO daemon_config (id, config_json, updated_at) VALUES (1, ?, ?)`
  ).run(JSON.stringify(config), Date.now());
}

function badPatch(input: object): Partial<DaemonBehaviorConfig> {
  return input as Partial<DaemonBehaviorConfig>;
}

function flushEvents(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('migration 222 — daemon_config table', () => {
  test('creates a single-row table enforced by CHECK', () => {
    const db = createDb();
    db.exec(`INSERT INTO daemon_config (id, config_json, updated_at) VALUES (1, '{}', 1)`);
    expect(() => {
      db.exec(`INSERT INTO daemon_config (id, config_json, updated_at) VALUES (2, '{}', 1)`);
    }).toThrow();
    db.close();
  });

  test('is idempotent', () => {
    const db = new BunDatabase(':memory:');
    runMigration222(db);
    runMigration222(db);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'daemon_config'`
      )
      .get() as { n: number };
    expect(row.n).toBe(1);
    db.close();
  });

  test('table exists in the canonical schema', () => {
    const db = new BunDatabase(':memory:');
    createTables(db);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'daemon_config'`
      )
      .get() as { n: number };
    expect(row.n).toBe(1);
    db.close();
  });
});

describe('DaemonConfigService', () => {
  test('getConfig returns catalog defaults when the row is absent', () => {
    const db = createDb();
    const service = new DaemonConfigService(db);
    expect(service.getConfig()).toEqual(DEFAULT_DAEMON_CONFIG);
    db.close();
  });

  test('getConfig resolves a stored overlay and serves repeats from cache', () => {
    const db = createDb();
    writeConfigRow(db, { deliveryPolicy: { messageDeliveryMaxRetries: 3 } });
    const service = new DaemonConfigService(db);
    expect(service.getConfig().deliveryPolicy?.messageDeliveryMaxRetries).toBe(3);
    writeConfigRow(db, { deliveryPolicy: { messageDeliveryMaxRetries: 6 } });
    expect(service.getConfig().deliveryPolicy?.messageDeliveryMaxRetries).toBe(3);
    db.close();
  });

  test('getConfig falls back to defaults on corrupt stored JSON', () => {
    const db = createDb();
    db.exec(`INSERT INTO daemon_config (id, config_json, updated_at) VALUES (1, 'not-json', 1)`);
    const service = new DaemonConfigService(db);
    expect(service.getConfig()).toEqual(DEFAULT_DAEMON_CONFIG);
    db.close();
  });

  test('updateConfig persists the patch, refreshes the cache, and reports changed keys', () => {
    const db = createDb();
    const service = new DaemonConfigService(db);
    const result = service.updateConfig({
      deliveryPolicy: { messageDeliveryMaxRetries: 4 },
      flags: { workflowConnectors: false },
    });
    expect(result.changedKeys).toEqual(['messageDeliveryMaxRetries', 'workflowConnectors']);
    expect(result.config.deliveryPolicy?.messageDeliveryMaxRetries).toBe(4);
    expect(result.config.flags?.workflowConnectors).toBe(false);
    expect(service.getConfig().deliveryPolicy?.messageDeliveryMaxRetries).toBe(4);
    const row = readConfigRow(db);
    expect(row?.config_json).toBe(
      '{"deliveryPolicy":{"messageDeliveryMaxRetries":4},"flags":{"workflowConnectors":false}}'
    );
    expect(row?.updated_at).toBeGreaterThan(0);
    db.close();
  });

  test('updateConfig merges into the existing overlay', () => {
    const db = createDb();
    const service = new DaemonConfigService(db);
    service.updateConfig({ flags: { workflowConnectors: false } });
    service.updateConfig({ deliveryPolicy: { messageDeliveryMaxRetries: 2 } });
    expect(readConfigRow(db)?.config_json).toBe(
      '{"flags":{"workflowConnectors":false},"deliveryPolicy":{"messageDeliveryMaxRetries":2}}'
    );
    expect(service.getConfig().flags?.workflowConnectors).toBe(false);
    db.close();
  });

  test('updateConfig publishes daemonConfig.updated with the changed keys', async () => {
    const db = createDb();
    const bus = createDaemonInternalEventBus();
    const service = new DaemonConfigService(db, bus);
    const seen: Array<{ changedKeys: string[] }> = [];
    bus.subscribe(
      DAEMON_CONFIG_UPDATED,
      (event) => {
        seen.push({ changedKeys: event.changedKeys });
      },
      { subscriberName: 'daemon-config-service-test' }
    );
    service.updateConfig({ deliveryPolicy: { messageDeliveryMaxRetries: 4 } });
    await flushEvents();
    expect(seen).toEqual([{ changedKeys: ['messageDeliveryMaxRetries'] }]);
    db.close();
  });

  test('updateConfig skips persisting and publishing when nothing changes', async () => {
    const db = createDb();
    const bus = createDaemonInternalEventBus();
    const service = new DaemonConfigService(db, bus);
    const seen: Array<{ changedKeys: string[] }> = [];
    bus.subscribe(
      DAEMON_CONFIG_UPDATED,
      (event) => {
        seen.push({ changedKeys: event.changedKeys });
      },
      { subscriberName: 'daemon-config-service-test' }
    );
    const defaults = DEFAULT_DAEMON_CONFIG.deliveryPolicy;
    const result = service.updateConfig({
      deliveryPolicy: { messageDeliveryMaxRetries: defaults?.messageDeliveryMaxRetries },
    });
    expect(result.changedKeys).toEqual([]);
    expect(readConfigRow(db)).toBeNull();
    await flushEvents();
    expect(seen).toEqual([]);
    db.close();
  });

  test('a no-op updateConfig still refreshes the cache from the stored row', () => {
    const db = createDb();
    writeConfigRow(db, { deliveryPolicy: { messageDeliveryMaxRetries: 3 } });
    const service = new DaemonConfigService(db);
    expect(service.getConfig().deliveryPolicy?.messageDeliveryMaxRetries).toBe(3);
    writeConfigRow(db, { deliveryPolicy: { messageDeliveryMaxRetries: 6 } });
    const result = service.updateConfig({
      deliveryPolicy: { messageDeliveryMaxRetries: 6 },
    });
    expect(result.changedKeys).toEqual([]);
    expect(service.getConfig().deliveryPolicy?.messageDeliveryMaxRetries).toBe(6);
    db.close();
  });

  test('mutating a getConfig result cannot corrupt the cache', () => {
    const db = createDb();
    const service = new DaemonConfigService(db);
    const mutated = service.getConfig();
    (mutated.deliveryPolicy ??= {}).messageDeliveryMaxRetries = 99;
    expect(service.getConfig().deliveryPolicy?.messageDeliveryMaxRetries).toBe(8);
    db.close();
  });

  test('mutating an updateConfig result cannot corrupt the cache', () => {
    const db = createDb();
    const service = new DaemonConfigService(db);
    const result = service.updateConfig({ deliveryPolicy: { messageDeliveryMaxRetries: 4 } });
    (result.config.deliveryPolicy ??= {}).messageDeliveryMaxRetries = 99;
    expect(service.getConfig().deliveryPolicy?.messageDeliveryMaxRetries).toBe(4);
    db.close();
  });

  test('mutating the returned changedKeys cannot alter the published event payload', async () => {
    const db = createDb();
    const bus = createDaemonInternalEventBus();
    const service = new DaemonConfigService(db, bus);
    const seen: Array<{ changedKeys: string[] }> = [];
    bus.subscribe(
      DAEMON_CONFIG_UPDATED,
      (event) => {
        seen.push({ changedKeys: event.changedKeys });
      },
      { subscriberName: 'daemon-config-service-test' }
    );
    const result = service.updateConfig({ deliveryPolicy: { messageDeliveryMaxRetries: 4 } });
    result.changedKeys.length = 0;
    await flushEvents();
    expect(seen).toEqual([{ changedKeys: ['messageDeliveryMaxRetries'] }]);
    db.close();
  });

  test('updateConfig rejects non-object families instead of treating them as no-ops', () => {
    const db = createDb();
    const service = new DaemonConfigService(db);
    expect(() => service.updateConfig(badPatch({ deliveryPolicy: null }))).toThrow(
      'daemon config family deliveryPolicy must be an object'
    );
    expect(() => service.updateConfig(badPatch({ flags: 'yes' }))).toThrow(
      'daemon config family flags must be an object'
    );
    expect(() => service.updateConfig(badPatch({ startup: [] }))).toThrow(
      'daemon config family startup must be an object'
    );
    expect(readConfigRow(db)).toBeNull();
    db.close();
  });

  test('an update that loses the CAS reports superseded without publishing or caching', async () => {
    const db = createDb();
    const bus = createDaemonInternalEventBus();
    const service = new DaemonConfigService(db, bus);
    const seen: Array<{ changedKeys: string[] }> = [];
    bus.subscribe(
      DAEMON_CONFIG_UPDATED,
      (event) => {
        seen.push({ changedKeys: event.changedKeys });
      },
      { subscriberName: 'daemon-config-service-test' }
    );
    writeConfigRow(db, { deliveryPolicy: { messageDeliveryMaxRetries: 9 } });
    (service as unknown as Record<string, unknown>).readConfigRow = () => null;
    const result = service.updateConfig({ deliveryPolicy: { messageDeliveryMaxRetries: 4 } });
    expect(result.status).toBe('superseded');
    expect(readConfigRow(db)?.config_json).toBe(
      '{"deliveryPolicy":{"messageDeliveryMaxRetries":9}}'
    );
    await flushEvents();
    expect(seen).toEqual([]);
    expect(service.getConfig().deliveryPolicy?.messageDeliveryMaxRetries).toBe(9);
    db.close();
  });

  test('updateConfig rejects unknown families and keys without writing', () => {
    const db = createDb();
    const service = new DaemonConfigService(db);
    expect(() => service.updateConfig(badPatch({ nope: { anything: 1 } }))).toThrow(
      DaemonConfigValidationError
    );
    expect(() => service.updateConfig(badPatch({ nope: { anything: 1 } }))).toThrow(
      'unknown daemon config family: nope'
    );
    expect(() => service.updateConfig(badPatch({ deliveryPolicy: { notAKey: 1 } }))).toThrow(
      'unknown daemon config key: deliveryPolicy.notAKey'
    );
    expect(() => service.updateConfig(badPatch({ flags: { logMaxBytes: 100 } }))).toThrow(
      'unknown daemon config key: flags.logMaxBytes'
    );
    expect(readConfigRow(db)).toBeNull();
    expect(service.getConfig()).toEqual(DEFAULT_DAEMON_CONFIG);
    db.close();
  });

  test('updateConfig rejects out-of-range values instead of clamping', () => {
    const db = createDb();
    const service = new DaemonConfigService(db);
    expect(() =>
      service.updateConfig({ deliveryPolicy: { messageDeliveryMaxRetries: 0 } })
    ).toThrow('messageDeliveryMaxRetries must be >= 1');
    expect(() => service.updateConfig({ startup: { logRetainedFiles: 1001 } })).toThrow(
      'logRetainedFiles must be <= 1000'
    );
    expect(() => service.updateConfig({ providersMisc: { providerMaxRetries: -1 } })).toThrow(
      'providerMaxRetries must be >= 0'
    );
    expect(readConfigRow(db)).toBeNull();
    db.close();
  });

  test('updateConfig rejects values of the wrong type', () => {
    const db = createDb();
    const service = new DaemonConfigService(db);
    expect(() =>
      service.updateConfig(badPatch({ deliveryPolicy: { messageDeliveryMaxRetries: '4' } }))
    ).toThrow('messageDeliveryMaxRetries must be an integer');
    expect(() =>
      service.updateConfig(badPatch({ deliveryPolicy: { messageDeliveryMaxRetries: 1.5 } }))
    ).toThrow('messageDeliveryMaxRetries must be an integer');
    expect(() => service.updateConfig(badPatch({ flags: { workflowConnectors: 1 } }))).toThrow(
      'workflowConnectors must be a boolean'
    );
    db.close();
  });

  test('seedFromLegacyEnv adopts set env vars using the legacy coercion rules', () => {
    const db = createDb();
    const service = new DaemonConfigService(db);
    const seeded = service.seedFromLegacyEnv({
      HYPERNEO_MESSAGE_DELIVERY_MAX_RETRIES: '3',
      HYPERNEO_WORKFLOW_CONNECTORS: '0',
      HYPERNEO_DISABLE_WORKTREES: '1',
      HYPERNEO_PROVIDER_MAX_RETRIES: '0',
      HYPERNEO_LOG_RETAINED_FILES: '2000',
      HYPERNEO_MESSAGE_DELIVERY_MAX_CONCURRENT: '',
    });
    expect(seeded).toBe(true);
    expect(readConfigRow(db)?.config_json).toBe(
      '{"deliveryPolicy":{"messageDeliveryMaxRetries":3,"messageDeliveryMaxConcurrent":64},"providersMisc":{"providerMaxRetries":0},"startup":{"disableWorktrees":true,"logRetainedFiles":1000},"flags":{"workflowConnectors":false}}'
    );
    const config = service.getConfig();
    expect(config.deliveryPolicy?.messageDeliveryMaxConcurrent).toBe(64);
    db.close();
  });

  test('an empty legacy boolean env value passes through the resolver as disabled', () => {
    const db = createDb();
    const service = new DaemonConfigService(db);
    const seeded = service.seedFromLegacyEnv({ HYPERNEO_SPACE_ACTIONS_DISPATCHER: '' });
    expect(seeded).toBe(true);
    expect(readConfigRow(db)?.config_json).toBe('{"flags":{"spaceActionsDispatcher":false}}');
    expect(service.getConfig().flags?.spaceActionsDispatcher).toBe(false);
    db.close();
  });

  test('seedFromLegacyEnv coerces below-minimum legacy ints to defaults', () => {
    const db = createDb();
    const service = new DaemonConfigService(db);
    const seeded = service.seedFromLegacyEnv({
      HYPERNEO_MESSAGE_DELIVERY_MAX_RETRIES: '0',
      HYPERNEO_INTERRUPT_CONTROL_TIMEOUT_MS: 'bogus',
    });
    expect(seeded).toBe(true);
    expect(readConfigRow(db)?.config_json).toBe(
      '{"deliveryTiming":{"interruptControlTimeoutMs":2000},"deliveryPolicy":{"messageDeliveryMaxRetries":8}}'
    );
    db.close();
  });

  test('seedFromLegacyEnv records adoption exactly once', () => {
    const db = createDb();
    const service = new DaemonConfigService(db);
    expect(service.seedFromLegacyEnv({})).toBe(false);
    expect(readConfigRow(db)?.config_json).toBe('{}');
    expect(service.seedFromLegacyEnv({ HYPERNEO_WORKFLOW_CONNECTORS: '0' })).toBe(false);
    expect(service.getConfig().flags?.workflowConnectors).toBe(true);
    db.close();
  });

  test('a seed that loses the atomic claim reports false and leaves the winner intact', () => {
    const db = createDb();
    const service = new DaemonConfigService(db);
    (service as unknown as Record<string, unknown>).readConfigRow = () => {
      writeConfigRow(db, { flags: { workflowConnectors: false } });
      return null;
    };
    expect(service.seedFromLegacyEnv({ HYPERNEO_WORKFLOW_CONNECTORS: '0' })).toBe(false);
    expect(readConfigRow(db)?.config_json).toBe('{"flags":{"workflowConnectors":false}}');
    db.close();
  });
});

describe('casDaemonConfigRow', () => {
  test('claims the absent row through an atomic insert', () => {
    const db = createDb();
    expect(casDaemonConfigRow(db, null, { flags: { workflowConnectors: false } })).toBe(true);
    expect(readConfigRow(db)?.config_json).toBe('{"flags":{"workflowConnectors":false}}');
    db.close();
  });

  test('loses the claim when the row appeared concurrently', () => {
    const db = createDb();
    writeConfigRow(db, { flags: { workflowConnectors: false } });
    expect(casDaemonConfigRow(db, null, { flags: { taskAgentPostApprovalRouting: false } })).toBe(
      false
    );
    expect(readConfigRow(db)?.config_json).toBe('{"flags":{"workflowConnectors":false}}');
    db.close();
  });

  test('replaces the row when the expected json still matches', () => {
    const db = createDb();
    writeConfigRow(db, { flags: { workflowConnectors: false } });
    const expected = JSON.stringify({ flags: { workflowConnectors: false } });
    expect(
      casDaemonConfigRow(db, expected, { flags: { taskAgentPostApprovalRouting: false } })
    ).toBe(true);
    expect(readConfigRow(db)?.config_json).toBe('{"flags":{"taskAgentPostApprovalRouting":false}}');
    db.close();
  });

  test('returns false and leaves the row untouched when superseded', () => {
    const db = createDb();
    writeConfigRow(db, { flags: { workflowConnectors: false } });
    const stale = JSON.stringify({ flags: { workflowConnectors: true } });
    expect(casDaemonConfigRow(db, stale, { flags: { taskAgentPostApprovalRouting: false } })).toBe(
      false
    );
    expect(readConfigRow(db)?.config_json).toBe('{"flags":{"workflowConnectors":false}}');
    db.close();
  });
});
