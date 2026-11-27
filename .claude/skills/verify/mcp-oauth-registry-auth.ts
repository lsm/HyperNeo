import assert from 'node:assert/strict';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport, type AppMcpServer } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const run = resolve(process.argv.at(-1) ?? '');
const baseline = process.argv[2] === '--baseline';
const data = join(run, 'data');
const workspace = join(run, 'workspace');
const dbPath = join(data, 'daemon.db');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, data);
assert(!existsSync(data));
for (const dir of ['workspace', 'evidence']) mkdirSync(join(run, dir));

const config = {
  ...getConfig({ host: '127.0.0.1', port: 0, dbPath, workspaceRoot: workspace }),
  disableWorktrees: true,
};

async function withDaemon<T>(
  drive: (hub: MessageHub, db: Database) => Promise<T>
): Promise<T> {
  const app = await createDaemonApp({ config, verbose: false });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  const transport = new WebSocketClientTransport({
    url: `ws://127.0.0.1:${app.server.port}/ws`,
    autoReconnect: false,
    createSocket: (url) => createLocalSocket(url, join(data, 'local-rpc.credential')),
  });
  try {
    await app.jobProcessor.stop();
    hub.registerTransport(transport);
    await transport.initialize();
    return await drive(hub, app.db.getDatabase());
  } finally {
    await transport.close();
    await app.cleanup();
  }
}

const marker = (db: Database) =>
  db.prepare("SELECT applied_at FROM migration_markers WHERE key = 'migration_539'").get();
const todoPlan = (db: Database) =>
  db.prepare(
    "SELECT name FROM pragma_table_info('neo_todos') WHERE name IN ('plan', 'plan_check_json') ORDER BY name"
  ).all();
const planColumns = [{ name: 'plan' }, { name: 'plan_check_json' }];
const list = async (hub: MessageHub) =>
  (await hub.request<{ servers: AppMcpServer[] }>('mcp.registry.list', {})).servers;
const oldUrl = 'https://original.example.test/mcp';
const newUrl = 'https://changed.example.test/mcp';
const file = join(workspace, '.mcp.json');
const write = (url: string) =>
  writeFileSync(
    file,
    JSON.stringify({ mcpServers: { remote: { type: 'http', url, description: url } } })
  );
const auth = { kind: 'oauth', preset: 'synthetic', generation: 1, active: false };
const evidence: Record<string, unknown> = { testedHead: process.argv[3] };

try {
  const legacy = await withDaemon(async (hub, db) => {
    if (!baseline) assert.deepEqual(todoPlan(db), planColumns);
    const { server } = await hub.request<{ server: AppMcpServer }>('mcp.registry.create', {
      name: 'legacy-proof',
      sourceType: 'http',
      url: oldUrl,
      enabled: false,
    });
    return server;
  });

  const offline = new Database(dbPath);
  try {
    if (!baseline) {
      assert(marker(offline));
      offline.exec(`DELETE FROM migration_markers WHERE key = 'migration_539';
        ALTER TABLE neo_todos DROP COLUMN plan_check_json;
        ALTER TABLE neo_todos DROP COLUMN plan;`);
      assert(offline.prepare("SELECT 1 FROM migration_markers WHERE key = 'migration_537'").get());
    }
  } finally {
    offline.close();
  }

  if (!baseline) {
    await withDaemon(async (hub, db) => {
      assert.deepEqual(todoPlan(db), planColumns);
      assert(marker(db));
      assert.deepEqual((await list(hub)).find(({ id }) => id === legacy.id), legacy);
      evidence.todoPlanRecoveredWith537AlreadyMarked = true;
    });
  }

  const beforeUpgrade = new Database(dbPath);
  try {
    if (!baseline) {
      beforeUpgrade.exec(`DELETE FROM migration_markers WHERE key = 'migration_539';
        ALTER TABLE app_mcp_servers DROP COLUMN auth;`);
    }
    assert(!(beforeUpgrade.prepare('PRAGMA table_info(app_mcp_servers)').all() as { name: string }[])
      .some(({ name }) => name === 'auth'));
  } finally {
    beforeUpgrade.close();
  }

  const migratedMarker = await withDaemon(async (hub, db) => {
    if (baseline) db.exec('ALTER TABLE app_mcp_servers ADD COLUMN auth TEXT');
    const applied = marker(db);
    evidence.migrationApplied = Boolean(applied);
    assert.deepEqual((await list(hub)).find(({ id }) => id === legacy.id), legacy);
    const refresh = () => hub.request('workspace.add', { path: workspace });
    write(oldUrl);
    await refresh();
    const imported = (await list(hub)).find(({ sourcePath }) => sourcePath === file);
    assert(imported);
    db.prepare('UPDATE app_mcp_servers SET auth = ? WHERE id = ?').run(
      JSON.stringify(auth),
      imported.id
    );
    const read = async () => (await list(hub)).find(({ id }) => id === imported.id);
    const before = await read();
    write(newUrl);
    await refresh();
    evidence.importRetargetRefused = (await read())?.url === oldUrl;
    unlinkSync(file);
    await refresh();
    evidence.importPruneRefused = Boolean(await read());
    if (baseline) {
      db.prepare('UPDATE app_mcp_servers SET auth = ? WHERE id = ?').run(
        JSON.stringify(auth),
        legacy.id
      );
    } else {
      assert.deepEqual(before?.auth, auth);
      assert.deepEqual(await read(), before);
      await assert.rejects(
        hub.request('mcp.registry.update', { id: imported.id, url: newUrl }),
        /disconnect it first/
      );
    }
    const deletion = await hub
      .request('mcp.registry.delete', { id: baseline ? legacy.id : imported.id })
      .then(() => 'accepted', (error: Error) => error.message);
    evidence.deleteReply = deletion;
    assert.match(deletion, /disconnect it first/);
    assert.deepEqual(await read(), before);
    assert.deepEqual(await hub.request('mcp.registry.delete', { id: legacy.id }), { success: true });
    evidence.plainDeleteAccepted = !(await list(hub)).some(({ id }) => id === legacy.id);
    assert(evidence.plainDeleteAccepted);
    return applied;
  });

  await withDaemon(async (hub, db) => {
    assert(migratedMarker);
    assert.deepEqual(marker(db), migratedMarker);
    assert.deepEqual((await list(hub)).find(({ sourcePath }) => sourcePath === file)?.auth, auth);
    evidence.restartRetainedAuth = true;
  });
  evidence.pass = true;
  console.log('PASS: migration applied once, OAuth import and registry writes refused, plain delete accepted');
} finally {
  writeFileSync(join(run, 'evidence/mcp-oauth-registry-auth.json'), JSON.stringify(evidence, null, 2));
}
