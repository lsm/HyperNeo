import { describe, expect, test } from 'bun:test';
import {
  DAEMON_CONFIG_KEY_CATALOG,
  DEFAULT_DAEMON_CONFIG,
  resolveDaemonConfig,
} from '@hyperneo/shared';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigration222 } from '../../../../src/storage/schema/m222-daemon-config.ts';
import { DaemonConfigService } from '../../../../src/lib/daemon-config-service.ts';
import { setupDaemonConfigHandlers } from '../../../../src/lib/rpc-handlers/daemon-config-handlers.ts';

function createMessageHubStub() {
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
  return {
    messageHub: {
      onRequest(name: string, handler: (payload: unknown) => Promise<unknown>) {
        handlers.set(name, handler);
      },
    },
    handlers,
  };
}

function createDaemonConfigService(): DaemonConfigService {
  const db = new BunDatabase(':memory:');
  runMigration222(db);
  return new DaemonConfigService(db);
}

describe('daemonConfig RPC handlers', () => {
  test('get returns the resolved config with the key catalog', async () => {
    const { messageHub, handlers } = createMessageHubStub();
    setupDaemonConfigHandlers(messageHub as never, {
      service: createDaemonConfigService(),
    });

    const response = (await handlers.get('daemonConfig.get')?.({})) as {
      config: unknown;
      catalog: unknown;
    };

    expect(response.config).toEqual(DEFAULT_DAEMON_CONFIG);
    expect(response.catalog).toEqual(DAEMON_CONFIG_KEY_CATALOG);
  });

  test('get reflects previously applied updates', async () => {
    const { messageHub, handlers } = createMessageHubStub();
    const service = createDaemonConfigService();
    setupDaemonConfigHandlers(messageHub as never, { service });

    await handlers.get('daemonConfig.update')?.({
      patch: { deliveryPolicy: { messageDeliveryMaxRetries: 2 } },
    });
    const response = (await handlers.get('daemonConfig.get')?.({})) as {
      config: ReturnType<typeof resolveDaemonConfig>;
    };

    expect(response.config.deliveryPolicy?.messageDeliveryMaxRetries).toBe(2);
  });

  test('update applies a patch and reports changedKeys in catalog order', async () => {
    const { messageHub, handlers } = createMessageHubStub();
    setupDaemonConfigHandlers(messageHub as never, {
      service: createDaemonConfigService(),
    });

    const patch = {
      flags: { workflowConnectors: false },
      deliveryTiming: { interruptControlTimeoutMs: 1234 },
    };
    const response = (await handlers.get('daemonConfig.update')?.({ patch })) as {
      status: string;
      config: ReturnType<typeof resolveDaemonConfig>;
      changedKeys: string[];
    };

    expect(response.status).toBe('applied');
    expect(response.config).toEqual(resolveDaemonConfig(patch));
    expect(response.changedKeys).toEqual(['interruptControlTimeoutMs', 'workflowConnectors']);
  });

  test('update with value-identical patch reports no changedKeys', async () => {
    const { messageHub, handlers } = createMessageHubStub();
    setupDaemonConfigHandlers(messageHub as never, {
      service: createDaemonConfigService(),
    });

    const response = (await handlers.get('daemonConfig.update')?.({
      patch: { flags: { workflowConnectors: true } },
    })) as { changedKeys: string[] };

    expect(response.changedKeys).toEqual([]);
  });

  test('update surfaces value validation failures as RPC errors', async () => {
    const { messageHub, handlers } = createMessageHubStub();
    setupDaemonConfigHandlers(messageHub as never, {
      service: createDaemonConfigService(),
    });

    await expect(
      handlers.get('daemonConfig.update')?.({ patch: { flags: { workflowConnectors: 'yes' } } })
    ).rejects.toThrow('workflowConnectors must be a boolean');
    await expect(
      handlers.get('daemonConfig.update')?.({
        patch: { deliveryPolicy: { messageDeliveryMaxRetries: 0 } },
      })
    ).rejects.toThrow('messageDeliveryMaxRetries must be >= 1');
  });

  test('update surfaces unknown families and keys as RPC errors', async () => {
    const { messageHub, handlers } = createMessageHubStub();
    setupDaemonConfigHandlers(messageHub as never, {
      service: createDaemonConfigService(),
    });

    await expect(
      handlers.get('daemonConfig.update')?.({ patch: { nope: { x: 1 } } })
    ).rejects.toThrow('unknown daemon config family: nope');
    await expect(
      handlers.get('daemonConfig.update')?.({ patch: { flags: { nope: true } } })
    ).rejects.toThrow('unknown daemon config key: flags.nope');
  });

  test('update surfaces malformed patches as RPC errors', async () => {
    const { messageHub, handlers } = createMessageHubStub();
    setupDaemonConfigHandlers(messageHub as never, {
      service: createDaemonConfigService(),
    });

    await expect(handlers.get('daemonConfig.update')?.({ patch: 'nope' })).rejects.toThrow(
      'daemon config patch must be an object'
    );
    await expect(handlers.get('daemonConfig.update')?.({ patch: [1] })).rejects.toThrow(
      'daemon config patch must be an object'
    );
  });
});
