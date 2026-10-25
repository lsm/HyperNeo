import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageHub } from '@hyperneo/shared';
import type { Database as Facade } from '../../../../src/storage/database.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { AppMcpServerRepository } from '../../../../src/storage/repositories/app-mcp-server-repository.ts';
import { McpEnablementRepository } from '../../../../src/storage/repositories/mcp-enablement-repository.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { McpImportService } from '../../../../src/lib/mcp/mcp-import-service.ts';
import { setupSpaceMcpHandlers } from '../../../../src/lib/rpc-handlers/space-mcp-handlers.ts';
import { noOpReactiveDb } from '../../../helpers/reactive-database.ts';
import { createTestSession } from '../../../helpers/database.ts';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';

let raw: Database;
let gateway: DbGateway;
let registry: AppMcpServerRepository;
let sessions: SessionRepository;
let importer: McpImportService;
let handlers: Map<string, (data: unknown) => unknown>;
let publish: ReturnType<typeof mock>;
let root: string;
let workspace: string;
let file: string;
const frozen = { version: 1, choices: {} };
const defaults = (space = false) =>
  JSON.parse(
    (
      raw
        .prepare(
          space
            ? "SELECT config AS json FROM spaces WHERE id='space'"
            : 'SELECT settings AS json FROM global_settings WHERE id=1'
        )
        .get() as { json: string }
    ).json
  ).toolSelectionDefaults;
const write = (names: string[]) =>
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: Object.fromEntries(names.map((name) => [name, { command: 'synthetic' }])),
    })
  );
const call = (params: unknown = { workspacePath: workspace }) =>
  Promise.resolve(handlers.get('mcp.imports.refresh')!(params));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-default-import-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace);
  process.env.TEST_USER_SETTINGS_DIR = join(root, 'settings');
  file = join(workspace, '.mcp.json');
  raw = new Database(':memory:');
  createTables(raw);
  createSpaceTables(raw);
  gateway = new DbGateway(':memory:', raw);
  registry = new AppMcpServerRepository(raw, noOpReactiveDb);
  sessions = new SessionRepository(raw);
  raw
    .prepare(
      "INSERT INTO spaces (id,slug,name,workspace_path,config,created_at,updated_at) VALUES ('space','space','Space',?, '{}',1,1)"
    )
    .run(workspace);
  raw
    .prepare("UPDATE spaces SET config=? WHERE id='space'")
    .run(JSON.stringify({ toolSelectionDefaults: frozen }));
  raw
    .prepare('UPDATE global_settings SET settings=? WHERE id=1')
    .run(JSON.stringify({ toolSelectionDefaults: frozen }));
  sessions.createSession({
    ...createTestSession('frozen'),
    config: { ...createTestSession('frozen').config, toolSelection: frozen },
  });
  const db = { gateway, appMcpServers: registry, getDatabase: () => raw } as unknown as Facade;
  importer = new McpImportService(db);
  handlers = new Map();
  publish = mock(async () => {});
  setupSpaceMcpHandlers(
    {
      onRequest: (method: string, handler: (data: unknown) => unknown) =>
        handlers.set(method, handler),
    } as unknown as MessageHub,
    { publish } as unknown as InternalEventBus<never>,
    db,
    {} as SpaceManager,
    importer
  );
});
afterEach(async () => {
  await gateway.close();
  raw.close();
  delete process.env.TEST_USER_SETTINGS_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('import default RPC writes', () => {
  it('adds disabled canonical defaults through the real import RPC and freezes existing sessions', async () => {
    write(['first', 'second']);
    expect(await call()).toMatchObject({ ok: true, imported: 2, removed: 0, notes: [] });
    for (const row of registry.listImported()) {
      expect(row.enabled).toBe(false);
      expect(defaults().choices[`mcp:${row.id}`].selected).toBe(false);
      expect(defaults(true).choices[`mcp:${row.id}`].selected).toBe(false);
    }
    expect(sessions.getSession('frozen')!.config.toolSelection).toEqual(frozen);
  });
  it('rolls back the whole catalog/default batch on a late Space failure without success notification', async () => {
    write(['first', 'second']);
    raw.exec(
      "CREATE TRIGGER refuse_import_default BEFORE UPDATE ON spaces BEGIN SELECT RAISE(ABORT,'synthetic import failure'); END"
    );
    expect(await call()).toMatchObject({
      imported: 0,
      removed: 0,
      notes: [expect.stringContaining('failed')],
    });
    expect(registry.listImported()).toEqual([]);
    expect(defaults()).toEqual(frozen);
    expect(publish).not.toHaveBeenCalled();
  });
  it('rolls back earlier additions when one imported row cannot persist', async () => {
    write(['first', 'second']);
    raw.exec(
      "CREATE TRIGGER refuse_import_row BEFORE INSERT ON app_mcp_servers WHEN NEW.name='workspace:second' BEGIN SELECT RAISE(ABORT,'synthetic row failure'); END"
    );
    expect(await call()).toMatchObject({
      imported: 0,
      removed: 0,
      notes: [expect.stringContaining('failed')],
    });
    expect(registry.listImported()).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });
  it.each(['remove', 'missing', 'orphan', 'override'])(
    '%s retires imported defaults atomically',
    async (action) => {
      write(['first']);
      await call();
      const row = registry.listImported()[0];
      const on = {
        version: 1,
        choices: { [`mcp:${row.id}`]: { selected: true, aliases: [row.name] } },
      };
      raw
        .prepare('UPDATE global_settings SET settings=? WHERE id=1')
        .run(JSON.stringify({ toolSelectionDefaults: on }));
      raw
        .prepare("UPDATE spaces SET config=? WHERE id='space'")
        .run(JSON.stringify({ toolSelectionDefaults: on }));
      if (action === 'override')
        new McpEnablementRepository(raw, noOpReactiveDb).setOverride(
          'space',
          'space',
          row.id,
          true
        );
      if (action === 'remove' || action === 'override') write([]);
      else if (action === 'missing') unlinkSync(file);
      else registry.update(row.id, { sourcePath: join(root, 'orphan', '.mcp.json') });
      await call(action === 'orphan' ? {} : { workspacePath: workspace });
      expect(registry.get(row.id)).toBeNull();
      expect(defaults().choices[`mcp:${row.id}`].selected).toBe(false);
      expect(defaults(true).choices[`mcp:${row.id}`].selected).toBe(false);
    }
  );
  it('preserves malformed input and manual enablement while applying metadata updates', async () => {
    write(['first']);
    await call();
    const row = registry.listImported()[0];
    const enabled = {
      version: 1,
      choices: { [`mcp:${row.id}`]: { selected: true, aliases: ['frozen-import-name'] } },
    };
    registry.update(row.id, { enabled: true });
    raw
      .prepare('UPDATE global_settings SET settings=? WHERE id=1')
      .run(JSON.stringify({ toolSelectionDefaults: enabled }));
    writeFileSync(file, '{broken');
    expect(await call()).toMatchObject({
      imported: 0,
      notes: [expect.stringContaining('invalid')],
    });
    expect(defaults()).toEqual(enabled);
    expect(registry.get(row.id)!.enabled).toBe(true);
    writeFileSync(file, JSON.stringify({ mcpServers: { first: { command: 'changed' } } }));
    await call();
    expect(registry.get(row.id)).toMatchObject({ enabled: true, command: 'changed' });
    expect(defaults()).toEqual(enabled);
  });
  it('uses the same atomic default transition for direct file refreshes', async () => {
    write(['direct']);
    await importer.refreshFromFile(file);
    const row = registry.getByName('direct')!;
    expect(defaults().choices[`mcp:${row.id}`].selected).toBe(false);
    raw.exec(
      "CREATE TRIGGER refuse_import_default BEFORE UPDATE ON spaces BEGIN SELECT RAISE(ABORT,'synthetic import failure'); END"
    );
    write(['direct', 'new']);
    expect(await importer.refreshFromFile(file)).toMatchObject({
      status: 'failed',
      added: 0,
      updated: 0,
      removed: 0,
    });
    expect(registry.getByName('new')).toBeNull();
  });
});
