import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.equal(process.env[key], undefined);
for (const name of ['home', 'workspace', 'bin', 'evidence']) mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { JobQueueProcessor } = await import('../../../packages/daemon/src/storage/job-queue-processor.ts');
const { ExternalEventExtensionManager } = await import('../../../packages/daemon/src/lib/external-events/extension-manager.ts');
const { ExternalEventExtensionConfigStore } = await import('../../../packages/daemon/src/lib/external-events/extension-config-store.ts');
const { Database } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const original = { start: JobQueueProcessor.prototype.start, register: ExternalEventExtensionManager.prototype.register, prepare: Database.prototype.prepare, fetch: globalThis.fetch };
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
let manager: InstanceType<typeof ExternalEventExtensionManager> | undefined;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
let main: InstanceType<typeof Database> | undefined;
let scratch: InstanceType<typeof Database> | undefined;
let measuring = false;
const bindings: unknown[][] = [];
const evidence: Record<string, unknown> = { mainThreadMovementClaim: false, boundary: 'Historical SQL extraction characterized direct helper behavior; current public setter uses the activated writer' };
const source = 'synthetic-extension';
const config = { source, globallyEnabled: false, capabilities: { polling: true }, secretsRef: 'synthetic-reference', settings: { label: 'Synthetic 🦊' } };
const callbacks: { kind: string; enabled: boolean }[] = [];
globalThis.fetch = (() => { throw new Error('External HTTP refused by extension extraction fixture'); }) as typeof fetch;
try {
  JobQueueProcessor.prototype.start = function () { processors.add(this); return original.start.call(this); };
  ExternalEventExtensionManager.prototype.register = function (extension) { manager = this; return original.register.call(this, extension); };
  try {
    app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  } finally {
    JobQueueProcessor.prototype.start = original.start;
    ExternalEventExtensionManager.prototype.register = original.register;
  }
  assert.notEqual(app.server.port, 8399);
  await Promise.all([...processors].map(p => p.stop()));
  main = app.db.getDatabase();
  await waitForSdkBodyCopy(main);
  assert(manager, 'real daemon extension manager must be captured');
  const store = new ExternalEventExtensionConfigStore(main);
  await store.setGlobalConfig(source, config);
  const initial = main.prepare('SELECT * FROM external_event_extension_configs WHERE source=?').get(source)!;
  manager.register({ sourceId: source, async start(ctx) { callbacks.push({ kind: 'start', enabled: (await ctx.config.getGlobalConfig(source)).globallyEnabled }); }, async stop() { callbacks.push({ kind: 'stop', enabled: (await store.getGlobalConfig(source)).globallyEnabled }); } });
  Database.prototype.prepare = function (sql, ...rest) {
    const db = this, statement = Reflect.apply(original.prepare, this, [sql, ...rest]);
    if (!/INSERT INTO external_event_extension_configs/i.test(sql)) return statement;
    return new Proxy(statement, { get(target, key) { const value = Reflect.get(target, key); if (typeof value !== 'function') return value; return (...args: unknown[]) => { if (measuring && db === main && key === 'run') bindings.push(args); return Reflect.apply(value, target, args); }; } });
  };
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  measuring = true;
  const replies = [];
  for (const enabled of [true, false]) {
    const reply = await hub.request('externalEvents.extensions.setGlobalEnabled', { source, enabled });
    assert.deepEqual(reply, { source, globallyEnabled: enabled });
    const listed = await hub.request<{ extensions: { source: string; status: string; config: typeof config }[] }>('externalEvents.extensions.list', {});
    assert.deepEqual(listed.extensions.find(e => e.source === source), { source, status: enabled ? 'started' : 'stopped', config: { ...config, globallyEnabled: enabled } });
    const row = main.prepare('SELECT * FROM external_event_extension_configs WHERE source=?').get(source)!;
    assert.deepEqual({ ...row, globally_enabled: initial.globally_enabled, updated_at: initial.updated_at }, { ...initial });
    assert.equal(row.globally_enabled, enabled ? 1 : 0);
    assert((row.updated_at as number) >= (initial.updated_at as number));
    replies.push(reply);
  }
  assert.deepEqual(callbacks, [{ kind: 'start', enabled: true }, { kind: 'stop', enabled: true }]);
  assert.equal(bindings.length, 0);
  assert.deepEqual(bindings, []);
  evidence.publicRpc = { replies, callbacks, mainUpsertRuns: bindings.length, exactJsonAndCreationTimePreserved: true };
  measuring = false;
  const helper = new URL('../../../packages/daemon/src/storage/repositories/global-extension-config-persist.ts', import.meta.url);
  assert(existsSync(helper), 'Global extension SQL helper is unavailable');
  const { persistGlobalExtensionConfig } = await import(helper.href);
  scratch = new Database(':memory:');
  new ExternalEventExtensionConfigStore(scratch);
  persistGlobalExtensionConfig(scratch, source, config, 41);
  const saved = scratch.prepare('SELECT * FROM external_event_extension_configs WHERE source=?').get(source)!;
  assert.equal(saved.created_at, 41);
  assert.equal(saved.updated_at, 41);
  assert.throws(() => scratch!.transaction(() => { persistGlobalExtensionConfig(scratch!, source, { ...config, globallyEnabled: true }, 99); throw new Error('synthetic rollback'); })(), /synthetic rollback/);
  assert.deepEqual(scratch.prepare('SELECT * FROM external_event_extension_configs WHERE source=?').get(source), saved);
  evidence.suppliedTimeAndCallerRollbackPreserved = true;
  assert.equal((await hub.request<{ status: string }>('system.health', {})).status, 'ok');
  evidence.pass = true;
} finally {
  measuring = false;
  scratch?.close();
  try { await transport?.close(); await Promise.all([...processors].map(p => p.stop())); await app?.cleanup(); }
  finally { JobQueueProcessor.prototype.start = original.start; ExternalEventExtensionManager.prototype.register = original.register; Database.prototype.prepare = original.prepare; globalThis.fetch = original.fetch; writeFileSync(join(run, 'evidence/extension-global-sql-extract.json'), JSON.stringify(evidence, null, 2)); }
}
console.log('ok global extension SQL extraction preserves native enable/disable RPC, stored JSON, timestamps and caller rollback; no main-thread movement claimed');
