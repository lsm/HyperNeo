import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const { ProviderCredentialManager } = await import('../../../packages/daemon/src/lib/credentials/provider-credential-manager.ts');
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
const evidence: Record<string, unknown> = {};
try {
  app = await createDaemonApp({ config: {
    ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }),
    disableWorktrees: true, disableGoalProcessing: true,
  }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  const repo = app.db.providers;
  const params = (providerId: string) => ({ providerId, displayName: providerId, kind: 'built_in' as const, authType: 'none' as const, isEnabled: false });
  const first = repo.createProvider({ ...params('synthetic-provider-first'), configJson: JSON.stringify({ command: 'synthetic-command', discoveredModels: { models: [{ id: 'synthetic-model' }] } }) });
  const second = repo.createProvider(params('synthetic-provider-second'));
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const raw = app.db.getDatabase();
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (/(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+providers\b/i.test(args[0])) {
      mainSqlAttempts++;
      throw new Error('provider mutation SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  async function request(name: string, method: string, input: unknown) {
    try {
      const value = await hub.request(method, input);
      evidence[name] = value;
      return value;
    } catch (error) {
      evidence[name] = { error: error instanceof Error ? error.message : String(error) };
      return undefined;
    }
  }
  try {
    evidence.healthBefore = await hub.request('system.health', {});
    await request('create', 'providers.create', { params: params('synthetic-provider-created') });
    await request('update', 'providers.update', { id: first.id, params: { displayName: 'Updated synthetic provider', sortOrder: 4 } });
    await request('setDefault', 'providers.setDefault', { id: first.id });
    await request('health', 'providers.test', { id: first.id });
    await request('credentialsUpdate', 'providers.update', { id: first.id, params: {}, credentials: { apiKey: 'synthetic-proof-only' } });
    evidence.persisted = repo.getProvider(first.id);
    const store = ProviderCredentialManager.prototype.storeApiKey;
    ProviderCredentialManager.prototype.storeApiKey = async () => { throw new Error('synthetic credential failure'); };
    try {
      await request('rollback', 'providers.create', { params: params('synthetic-provider-rollback'), credentials: { apiKey: 'synthetic-proof-only' } });
    } finally {
      ProviderCredentialManager.prototype.storeApiKey = store;
    }
    evidence.rolledBack = repo.getProviderByProviderId('synthetic-provider-rollback');
    await request('delete', 'providers.delete', { id: second.id });
    evidence.deleted = repo.getProvider(second.id);
    evidence.healthAfter = await hub.request('system.health', {});
    assert.equal(mainSqlAttempts, 0, 'provider RPC mutations must not write to the main SQLite connection');
    for (const name of ['create', 'update', 'setDefault', 'credentialsUpdate', 'delete']) {
      assert.equal((evidence[name] as { success?: boolean }).success, true, name);
    }
    assert.deepEqual(evidence.health, { healthy: false, error: 'Provider not registered' });
    const persisted = repo.getProvider(first.id);
    assert(persisted);
    assert.equal(persisted.displayName, 'Updated synthetic provider');
    assert.equal(persisted.isDefault, true);
    assert.equal(persisted.healthStatus, 'unhealthy');
    assert.equal(persisted.authType, 'api_key');
    assert.deepEqual(JSON.parse(persisted.configJson!), { command: 'synthetic-command' });
    assert.match(String((evidence.rollback as { error?: string }).error), /synthetic credential failure/);
    assert.equal(evidence.rolledBack, null);
    assert.equal(evidence.deleted, null);
  } finally {
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
} finally {
  await transport?.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/provider-rpc-writes.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok provider RPC CRUD, default, health and discovery invalidation persist on the writer');
