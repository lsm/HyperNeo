import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import type { CustomEndpointConfig, GlobalSettings } from '@hyperneo/shared';
import { registerSettingsHandlers } from '../../../../src/lib/rpc-handlers/settings-handlers';
import { registerCustomEndpointHandlers } from '../../../../src/lib/rpc-handlers/custom-endpoint-handlers';
import type { SettingsManager } from '../../../../src/lib/settings-manager';
import type { Database } from '../../../../src/storage/database';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';

const syncCalls: Array<CustomEndpointConfig[] | undefined> = [];
mock.module('../../../../src/lib/providers/factory', () => ({
  syncCustomEndpointProviders: mock(async (configs: CustomEndpointConfig[] | undefined) => {
    syncCalls.push(configs);
  }),
}));

const clearModelsCacheCalls: Array<string | undefined> = [];
mock.module('../../../../src/lib/model-service', () => ({
  clearModelsCache: mock((cacheKey?: string) => {
    clearModelsCacheCalls.push(cacheKey);
  }),
}));

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
  const handlers = new Map<string, RequestHandler>();
  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
  } as unknown as MessageHub;
  return { hub, handlers };
}

function makeSettings(initial: GlobalSettings): {
  manager: SettingsManager;
  state: { settings: GlobalSettings };
} {
  const state = { settings: initial };
  const manager = {
    getGlobalSettings: mock(() => state.settings),
    updateGlobalSettings: mock((updates: Partial<GlobalSettings>) => {
      state.settings = { ...state.settings, ...updates };
      return state.settings;
    }),
    saveGlobalSettings: mock((settings: GlobalSettings) => {
      state.settings = settings;
    }),
    readFileOnlySettings: mock(() => ({})),
    listMcpServersFromSources: mock(() => []),
  } as unknown as SettingsManager;
  return { manager, state };
}

const validEndpoint: CustomEndpointConfig = {
  id: 'lmstudio',
  name: 'LM Studio',
  baseUrl: 'http://localhost:1234/v1',
  models: [{ id: 'qwen2.5-7b' }],
};

describe('settings handlers — custom endpoints integration', () => {
  let hubData: ReturnType<typeof createMockMessageHub>;
  let settings: ReturnType<typeof makeSettings>;
  let eventBus: InternalEventBus<DaemonInternalEventMap>;
  let db: Database;

  beforeEach(() => {
    syncCalls.splice(0);
    clearModelsCacheCalls.splice(0);
    hubData = createMockMessageHub();
    settings = makeSettings({ customEndpoints: [validEndpoint] } as unknown as GlobalSettings);
    eventBus = {
      publish: mock(async () => {}),
      publishAsync: mock(() => {}),
      subscribe: mock(() => () => {}),
    } as unknown as InternalEventBus<DaemonInternalEventMap>;
    db = {
      getSession: mock(() => null),
      workspaceHistory: { list: mock(() => []) },
      getDatabase: mock(() => ({ prepare: mock(() => ({ get: () => ({}), all: () => [] })) })),
    } as unknown as Database;
    registerSettingsHandlers(hubData.hub, settings.manager, eventBus, db);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('settings.global.update', () => {
    it('validates customEndpoints before persisting', async () => {
      const handler = hubData.handlers.get('settings.global.update')!;
      await expect(
        handler({ updates: { customEndpoints: [{ ...validEndpoint, baseUrl: 'ftp://nope' }] } }, {})
      ).rejects.toThrow(/baseUrl/);
      expect(syncCalls).toHaveLength(0);
    });

    it('syncs and clears cache when customEndpoints provided', async () => {
      const handler = hubData.handlers.get('settings.global.update')!;
      await handler({ updates: { customEndpoints: [validEndpoint] } }, {});
      expect(syncCalls).toHaveLength(1);
      expect(clearModelsCacheCalls).toHaveLength(1);
    });

    it('does not sync when customEndpoints omitted', async () => {
      const handler = hubData.handlers.get('settings.global.update')!;
      await handler({ updates: { showArchived: true } }, {});
      expect(syncCalls).toHaveLength(0);
      expect(clearModelsCacheCalls).toHaveLength(0);
    });

    it('rejects a null customEndpoints payload', async () => {
      const handler = hubData.handlers.get('settings.global.update')!;
      await expect(
        handler({ updates: { customEndpoints: null as unknown as CustomEndpointConfig[] } }, {})
      ).rejects.toThrow(/customEndpoints must be an array/);
      expect(syncCalls).toHaveLength(0);
    });
  });

  describe('settings.global.save', () => {
    it('preserves existing custom endpoints when payload omits the field', async () => {
      const handler = hubData.handlers.get('settings.global.save')!;
      await handler({ settings: {} as GlobalSettings }, {});
      expect(syncCalls).toHaveLength(0);
      expect(clearModelsCacheCalls).toHaveLength(0);
      expect(settings.state.settings.customEndpoints).toEqual([validEndpoint]);
    });

    it('rejects a null customEndpoints payload instead of silently wiping providers', async () => {
      const handler = hubData.handlers.get('settings.global.save')!;
      await expect(
        handler(
          {
            settings: { customEndpoints: null } as unknown as GlobalSettings,
          },
          {}
        )
      ).rejects.toThrow(/customEndpoints must be an array/);
      expect(settings.state.settings.customEndpoints).toEqual([validEndpoint]);
      expect(syncCalls).toHaveLength(0);
    });

    it('explicitly clears endpoints when payload sets customEndpoints to []', async () => {
      const handler = hubData.handlers.get('settings.global.save')!;
      await handler({ settings: { customEndpoints: [] } as unknown as GlobalSettings }, {});
      expect(syncCalls).toEqual([[]]);
      expect(clearModelsCacheCalls).toHaveLength(1);
    });

    it('validates customEndpoints before persisting on save', async () => {
      const handler = hubData.handlers.get('settings.global.save')!;
      await expect(
        handler(
          {
            settings: {
              customEndpoints: [{ ...validEndpoint, id: 'bad/id' }],
            } as unknown as GlobalSettings,
          },
          {}
        )
      ).rejects.toThrow(/invalid/);
      expect(syncCalls).toHaveLength(0);
    });
  });

  describe('cross-RPC mutation serialisation', () => {
    it('serialises a concurrent settings.global.update + customEndpoints.remove via the shared lock', async () => {
      registerCustomEndpointHandlers(hubData.hub, settings.manager, eventBus);

      const updateHandler = hubData.handlers.get('settings.global.update')!;
      const removeHandler = hubData.handlers.get('customEndpoints.remove')!;
      const second: CustomEndpointConfig = { ...validEndpoint, id: 'second' };

      const results = await Promise.allSettled([
        updateHandler({ updates: { customEndpoints: [validEndpoint, second] } }, {}),
        removeHandler({ id: 'lmstudio' }, {}),
      ]);

      const final = (settings.state.settings.customEndpoints ?? []).map((e) => e.id).sort();
      const orderA = ['lmstudio', 'second'];
      const orderB = ['second'];
      expect([JSON.stringify(orderA), JSON.stringify(orderB)]).toContain(JSON.stringify(final));
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    });

    it('serialises settings.global.update (no customEndpoints in payload) against customEndpoints.add', async () => {
      registerCustomEndpointHandlers(hubData.hub, settings.manager, eventBus);
      const real = settings.manager.updateGlobalSettings as unknown as (
        updates: Partial<GlobalSettings>
      ) => GlobalSettings;
      let stallResolve: (() => void) | undefined;
      const stall = new Promise<void>((r) => {
        stallResolve = r;
      });
      let firstCall = true;
      settings.manager.updateGlobalSettings = mock(async (updates: Partial<GlobalSettings>) => {
        if (firstCall) {
          firstCall = false;
          await stall;
        }
        return real.call(settings.manager, updates);
      }) as unknown as typeof settings.manager.updateGlobalSettings;

      const updateHandler = hubData.handlers.get('settings.global.update')!;
      const addHandler = hubData.handlers.get('customEndpoints.add')!;
      const second: CustomEndpointConfig = { ...validEndpoint, id: 'second' };

      const updatePromise = updateHandler({ updates: { showArchived: true } }, {});
      await Promise.resolve();
      await Promise.resolve();
      const addPromise = addHandler({ endpoint: second }, {});

      stallResolve?.();
      await Promise.all([updatePromise, addPromise]);

      const ids = (settings.state.settings.customEndpoints ?? []).map((e) => e.id).sort();
      expect(ids).toEqual(['lmstudio', 'second']);
    });

    it('serialises settings.global.save (no customEndpoints in payload) against customEndpoints.add', async () => {
      registerCustomEndpointHandlers(hubData.hub, settings.manager, eventBus);

      const realSave = settings.manager.saveGlobalSettings as unknown as (
        s: GlobalSettings
      ) => void;
      let stallResolve: (() => void) | undefined;
      const stall = new Promise<void>((r) => {
        stallResolve = r;
      });
      let firstSave = true;
      settings.manager.saveGlobalSettings = mock(async (s: GlobalSettings) => {
        if (firstSave) {
          firstSave = false;
          await stall;
        }
        realSave.call(settings.manager, s);
      }) as unknown as typeof settings.manager.saveGlobalSettings;

      const saveHandler = hubData.handlers.get('settings.global.save')!;
      const addHandler = hubData.handlers.get('customEndpoints.add')!;
      const second: CustomEndpointConfig = { ...validEndpoint, id: 'second' };

      const savePromise = saveHandler({ settings: { showArchived: true } as GlobalSettings }, {});
      await Promise.resolve();
      await Promise.resolve();
      const addPromise = addHandler({ endpoint: second }, {});
      stallResolve?.();
      await Promise.all([savePromise, addPromise]);

      const ids = (settings.state.settings.customEndpoints ?? []).map((e) => e.id).sort();
      expect(ids).toEqual(['lmstudio', 'second']);
    });
  });
});
