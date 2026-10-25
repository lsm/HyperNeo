import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import type { Database as Facade } from '../../../../src/storage/database.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { AppMcpServerRepository } from '../../../../src/storage/repositories/app-mcp-server-repository.ts';
import { McpEnablementRepository } from '../../../../src/storage/repositories/mcp-enablement-repository.ts';
import {
  registerAppMcpHandlers,
  setupAppMcpHandlers,
} from '../../../../src/lib/rpc-handlers/app-mcp-handlers.ts';
import { setupSpaceMcpHandlers } from '../../../../src/lib/rpc-handlers/space-mcp-handlers.ts';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { noOpReactiveDb } from '../../../helpers/reactive-database.ts';
import { createTestSession } from '../../../helpers/database.ts';

let db: Database;
let gateway: DbGateway;
let registry: AppMcpServerRepository;
let overrides: McpEnablementRepository;
let spaces: SpaceRepository;
let sessions: SessionRepository;
let handlers: Map<string, (data: unknown) => unknown>;
let publish: ReturnType<typeof mock>;
const selection = (selected = false) => ({
  version: 1,
  choices: { 'mcp:browser': { selected, aliases: ['frozen-browser'] } },
});
const globalDefaults = () =>
  JSON.parse(
    (db.prepare('SELECT settings FROM global_settings WHERE id=1').get() as { settings: string })
      .settings
  ).toolSelectionDefaults;
const spaceDefaults = () =>
  (spaces.getSpace('space')!.config as Record<string, unknown>).toolSelectionDefaults as ReturnType<
    typeof selection
  >;
const call = (method: string, data: unknown) => Promise.resolve(handlers.get(method)!(data));
beforeEach(() => {
  db = new Database(':memory:');
  createTables(db);
  createSpaceTables(db);
  gateway = new DbGateway(':memory:', db);
  registry = new AppMcpServerRepository(db, noOpReactiveDb);
  overrides = new McpEnablementRepository(db, noOpReactiveDb);
  spaces = new SpaceRepository(db);
  sessions = new SessionRepository(db);
  db.prepare(
    "INSERT INTO app_mcp_servers (id,name,source_type,command,enabled) VALUES ('browser','registry-name','stdio','synthetic',0)"
  ).run();
  db.prepare(
    "INSERT INTO skills (id,name,display_name,description,source_type,config,enabled,created_at) VALUES ('wrapper','wrapper','Wrapper','','mcp_server',?,0,1)"
  ).run(JSON.stringify({ type: 'mcp_server', appMcpServerId: 'browser' }));
  db.prepare('UPDATE global_settings SET settings=? WHERE id=1').run(
    JSON.stringify({ toolSelectionDefaults: selection() })
  );
  db.prepare(
    "INSERT INTO spaces (id,slug,name,workspace_path,config,created_at,updated_at) VALUES ('space','space','Space','/synthetic',?,1,1)"
  ).run(JSON.stringify({ toolSelectionDefaults: selection() }));
  sessions.createSession({
    ...createTestSession('frozen'),
    config: { ...createTestSession('frozen').config, toolSelection: selection() },
  });
  const facade = {
    gateway,
    appMcpServers: registry,
    mcpEnablement: overrides,
    getDatabase: () => db,
    getSession: (id: string) => sessions.getSession(id),
  } as unknown as Facade;
  handlers = new Map();
  const hub = {
    onRequest: (method: string, handler: (data: unknown) => unknown) => {
      handlers.set(method, handler);
    },
  } as unknown as MessageHub;
  publish = mock(async () => {});
  const bus = { publish } as unknown as InternalEventBus<never>;
  registerAppMcpHandlers(hub, { db: facade, internalEventBus: bus });
  setupAppMcpHandlers(hub, bus, facade, async () => {
    throw new Error('session path outside fixture');
  });
  setupSpaceMcpHandlers(hub, bus, facade, {
    getSpace: async (id: string) => spaces.getSpace(id),
  } as unknown as SpaceManager);
});
afterEach(async () => {
  await gateway.close();
  db.close();
});

describe('MCP default RPC writes', () => {
  it.each(['mcp.registry.update', 'mcp.registry.setEnabled'])(
    '%s commits intent despite the old wrapper veto',
    async (method) => {
      await call(method, { id: 'browser', enabled: true });
      expect(registry.get('browser')!.enabled).toBe(true);
      expect(globalDefaults()).toEqual(selection(true));
      expect(spaceDefaults()).toEqual(selection(true));
      expect(sessions.getSession('frozen')!.config.toolSelection).toEqual(selection());
    }
  );
  it('creates and deletes matching default choices', async () => {
    const { server } = (await call('mcp.registry.create', {
      name: 'created',
      sourceType: 'stdio',
      command: 'synthetic',
      enabled: true,
    })) as { server: { id: string } };
    expect(globalDefaults().choices[`mcp:${server.id}`].selected).toBe(true);
    await call('mcp.registry.delete', { id: server.id });
    expect(registry.get(server.id)).toBeNull();
    expect(globalDefaults().choices[`mcp:${server.id}`].selected).toBe(false);
  });
  it.each(['mcp.enablement', 'space.mcp'])(
    '%s set and clear persist Space defaults and preserve global intent',
    async (prefix) => {
      registry.update('browser', { enabled: true });
      db.prepare('UPDATE global_settings SET settings=? WHERE id=1').run(
        JSON.stringify({ toolSelectionDefaults: selection(true) })
      );
      await call(prefix === 'space.mcp' ? 'space.mcp.setEnabled' : 'mcp.enablement.setOverride', {
        scopeType: 'space',
        scopeId: 'space',
        spaceId: 'space',
        serverId: 'browser',
        enabled: false,
      });
      expect(spaceDefaults()).toEqual(selection());
      const method =
        prefix === 'space.mcp' ? 'space.mcp.clearOverride' : 'mcp.enablement.clearOverride';
      const params = {
        scopeType: 'space',
        scopeId: 'space',
        spaceId: 'space',
        serverId: 'browser',
      };
      await call(method, params);
      expect(spaceDefaults()).toEqual(selection(true));
      expect(overrides.getOverride('space', 'space', 'browser')).toBeNull();
      const repeated = await call(method, params);
      expect(repeated).toEqual(prefix === 'space.mcp' ? { ok: true } : { deleted: false });
      expect(globalDefaults()).toEqual(selection(true));
    }
  );
  it('clears a missing legacy override when the canonical Space default differs', async () => {
    db.prepare("UPDATE spaces SET config=? WHERE id='space'").run(
      JSON.stringify({ toolSelectionDefaults: selection(true) })
    );
    expect(
      await call('mcp.enablement.clearOverride', {
        scopeType: 'space',
        scopeId: 'space',
        serverId: 'browser',
      })
    ).toEqual({ deleted: false });
    expect(spaceDefaults()).toEqual(selection());
    expect(publish).toHaveBeenCalled();
  });
  it('rolls back catalog/default failures and never publishes success', async () => {
    db.exec(
      "CREATE TRIGGER refuse_rpc_default BEFORE UPDATE ON spaces BEGIN SELECT RAISE(ABORT,'synthetic RPC default failure'); END"
    );
    await expect(call('mcp.registry.setEnabled', { id: 'browser', enabled: true })).rejects.toThrow(
      'synthetic RPC default failure'
    );
    expect(registry.get('browser')!.enabled).toBe(false);
    expect(globalDefaults()).toEqual(selection());
    expect(publish).not.toHaveBeenCalled();
  });
  it('retains missing-server and reserved-name admission errors', async () => {
    await expect(call('mcp.registry.update', { id: 'missing', enabled: true })).rejects.toThrow(
      'MCP server not found: missing'
    );
    await expect(
      call('mcp.registry.create', {
        name: 'hyperneo-operations',
        sourceType: 'stdio',
        command: 'synthetic',
      })
    ).rejects.toThrow('reserved');
    expect(publish).not.toHaveBeenCalled();
  });
});
