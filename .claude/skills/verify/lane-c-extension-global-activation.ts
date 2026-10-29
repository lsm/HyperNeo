import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home')); assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data')));
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.equal(process.env[key], undefined);
for (const name of ['home', 'workspace', 'bin', 'evidence']) mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 }); process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { JobQueueProcessor } = await import('../../../packages/daemon/src/storage/job-queue-processor.ts');
const { ExternalEventExtensionManager } = await import('../../../packages/daemon/src/lib/external-events/extension-manager.ts');
const { ExternalEventExtensionConfigStore } = await import('../../../packages/daemon/src/lib/external-events/extension-config-store.ts');
const { Database } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const name = 'extension.global.config.write', source = 'synthetic-extension-activation';
const config = { source, globallyEnabled: false, capabilities: { polling: true }, secretsRef: 'synthetic-reference', settings: { label: 'Synthetic 🦊' } };
const original = { Worker: globalThis.Worker, start: JobQueueProcessor.prototype.start, register: ExternalEventExtensionManager.prototype.register, prepare: Database.prototype.prepare, fetch: globalThis.fetch };
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, transport: InstanceType<typeof WebSocketClientTransport> | undefined, manager: InstanceType<typeof ExternalEventExtensionManager> | undefined, main: InstanceType<typeof Database> | undefined, lock: InstanceType<typeof Database> | undefined;
let measuring = false, mainSqlAttempts = 0, commandPosts = 0, rejectNext = false, loseNext = false, failStart = false;
const callbacks: {kind:string;enabled:boolean}[] = [];
const capturedTimes: number[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
const metrics: { roundTripMs: number; requestBytes: number; replyBytes: number }[] = [];
const evidence: Record<string, unknown> = { publicSetterActivated: true };
Database.prototype.prepare = function (sql, ...rest) {
  const db = this, statement = Reflect.apply(original.prepare, this, [sql, ...rest]);
  if (!/INSERT INTO external_event_extension_configs/i.test(sql)) return statement;
  return new Proxy(statement, { get(target, key) { const value = Reflect.get(target, key); if (typeof value !== 'function') return value; return (...args: unknown[]) => { if (measuring && db === main && key === 'run') { mainSqlAttempts++; throw new Error('Global config UPSERT reached main'); } return Reflect.apply(value, target, args); }; } });
};
globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
  const worker = new original.Worker(url, options);
  if (String(url).endsWith('/db-gateway-worker.ts')) {
    const post = worker.postMessage.bind(worker), sent = new Map<number, { at: number; bytes: number }>(), lost = new Set<number>();
    let receive: ((event: MessageEvent) => void) | null = null;
    Object.defineProperty(worker, 'onmessage', { configurable: true, get: () => receive, set: (handler: typeof receive) => { receive = handler; } });
    worker.addEventListener('message', event => {
      const request = sent.get(event.data.id);
      if (request) { sent.delete(event.data.id); if (!event.data.error) metrics.push({ roundTripMs: performance.now() - request.at, requestBytes: request.bytes, replyBytes: Buffer.byteLength(JSON.stringify(event.data)) }); }
      if (lost.delete(event.data.id) && !event.data.error) { worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic committed global config reply lost; outcome unknown', cancelable: true })); return; }
      receive?.call(worker, event);
    });
    worker.postMessage = ((message: { id: number; op?: string; lane?: string; args?: unknown }) => {
      if (message.op === name && (message.args as {args?:unknown[]})?.args?.[0] === source) {
        commandPosts++; assert.equal(message.lane, 'write');
        const payload = message.args as { method: string; args: unknown[] };
        assert.equal(payload.method, 'persist'); assert.equal(payload.args.length, 3); assert.equal(typeof payload.args[0], 'string'); assert.equal(typeof payload.args[2], 'number'); capturedTimes.push(payload.args[2] as number); assert.deepEqual(structuredClone(payload), payload);
        if (rejectNext) { rejectNext = false; queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic global config admission rejected', cancelable: true }))); return; }
        sent.set(message.id, { at: performance.now(), bytes: Buffer.byteLength(JSON.stringify(payload)) }); if (loseNext) { loseNext = false; lost.add(message.id); }
      }
      post(message);
    }) as typeof worker.postMessage;
  }
  return worker;
} as unknown as typeof Worker;
globalThis.fetch = (() => { throw new Error('External HTTP refused by global command fixture'); }) as typeof fetch;
try {
  JobQueueProcessor.prototype.start = function () { processors.add(this); return original.start.call(this); };
  ExternalEventExtensionManager.prototype.register = function (extension) { manager = this; return original.register.call(this, extension); };
  try { app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false }); }
  finally { JobQueueProcessor.prototype.start = original.start; ExternalEventExtensionManager.prototype.register = original.register; }
  assert.notEqual(app.server.port, 8399); await Promise.all([...processors].map(p => p.stop())); main = app.db.getDatabase(); await waitForSdkBodyCopy(main);
  const store = new ExternalEventExtensionConfigStore(main); await store.setGlobalConfig(source, config); const initial = main.prepare('SELECT * FROM external_event_extension_configs WHERE source=?').get(source)!;
  assert(manager); manager.register({ sourceId: source, async start(ctx) { callbacks.push({ kind: 'start', enabled: (await ctx.config.getGlobalConfig(source)).globallyEnabled }); if (failStart) { failStart = false; throw new Error('synthetic extension start failure'); } }, async stop() { callbacks.push({ kind: 'stop', enabled: (await store.getGlobalConfig(source)).globallyEnabled }); } });
  commandPosts = 0; metrics.length = 0; capturedTimes.length = 0;
  const hub = new MessageHub({ defaultSessionId: 'global' }); transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false }); hub.registerTransport(transport); await transport.initialize();
  const enable = (enabled: boolean) => hub.request('externalEvents.extensions.setGlobalEnabled', { source, enabled });
  const listed = async () => (await hub.request<{ extensions: { source: string; status: string; config: typeof config }[] }>('externalEvents.extensions.list', {})).extensions.find(e => e.source === source)!;
  const row = () => main!.prepare('SELECT * FROM external_event_extension_configs WHERE source=?').get(source)!;
  const check = async (enabled: boolean, status: string) => { assert.deepEqual(await listed(), { source, status, config: { ...config, globallyEnabled: enabled } }); const saved = row(); assert.deepEqual({ ...saved, globally_enabled: initial.globally_enabled, updated_at: initial.updated_at }, { ...initial }); assert.equal(saved.globally_enabled, enabled ? 1 : 0); };
  const cached = main.prepare('INSERT INTO external_event_extension_configs(source,globally_enabled,capabilities_json,created_at,updated_at)VALUES(?,0,?,0,0)');
  measuring = true; assert.throws(() => cached.run('guard-self-check', '{}'), /UPSERT reached main/); assert.throws(() => main!.prepare('INSERT INTO external_event_extension_configs(source,globally_enabled,capabilities_json,created_at,updated_at)VALUES(?,0,?,0,0)').run('guard-self-check', '{}'), /UPSERT reached main/); assert.equal(mainSqlAttempts, 2); mainSqlAttempts = 0; evidence.mainGuardSelfCheckPassed = true;
  let previous = performance.now(), maxLoopLagMs = 0; timer = setInterval(() => { const at = performance.now(); maxLoopLagMs = Math.max(maxLoopLagMs, at - previous - 5); previous = at; }, 5);
  const at = performance.now(); try { assert.deepEqual(await enable(true), { source, globallyEnabled: true }); } catch (error) { evidence.firstRpcError = String(error); throw error; } evidence.firstRpcMs = performance.now() - at; await check(true, 'started'); assert.deepEqual(callbacks, [{kind:'start',enabled:true}]); assert.equal(commandPosts, 1);
  assert.deepEqual(await enable(false), { source, globallyEnabled: false }); await check(false, 'stopped'); assert.deepEqual(callbacks, [{kind:'start',enabled:true},{kind:'stop',enabled:true}]); assert.equal(commandPosts, 2); evidence.publicEnableDisableListPreserved = true;
  const beforeConcurrent = callbacks.length, beforeConcurrentWrites = commandPosts; assert.deepEqual(await Promise.all([enable(true),enable(true)]), [{source,globallyEnabled:true},{source,globallyEnabled:true}]); await check(true, 'started'); assert.equal(callbacks.length, beforeConcurrent + 1); assert.equal(commandPosts, beforeConcurrentWrites + 2); await enable(false); await check(false,'stopped'); evidence.concurrentEnablesStartOnce = true;
  const beforeFailure = commandPosts; failStart = true; await assert.rejects(enable(true), /synthetic extension start failure/); assert.equal(commandPosts, beforeFailure + 2); await check(false,'stopped'); evidence.failedStartRestoresKnownCommittedConfig = true;
  main.exec("CREATE TRIGGER reject_synthetic_extension_update AFTER UPDATE ON external_event_extension_configs WHEN NEW.source='synthetic-extension-activation' BEGIN SELECT RAISE(ABORT,'synthetic rollback');END"); const beforeRollbackCallbacks = callbacks.length, beforeRollback = commandPosts; await assert.rejects(enable(true), /synthetic rollback/); assert.equal(commandPosts, beforeRollback + 1); assert.equal(callbacks.length, beforeRollbackCallbacks); await check(false,'stopped'); main.exec('DROP TRIGGER reject_synthetic_extension_update'); evidence.failedWriterRollsBackBeforeCallback = true;
  main.exec('CREATE TABLE synthetic_extension_lock(value INTEGER);INSERT INTO synthetic_extension_lock VALUES(0)'); lock = new Database(app.db.getDbPath()); lock.exec('BEGIN IMMEDIATE'); lock.prepare('UPDATE synthetic_extension_lock SET value=1').run(); const beforeHeld = commandPosts, beforeHeldCallbacks = callbacks.length; let settled = false; const heldAt = performance.now(); const pending = enable(true).finally(() => { settled = true; }); const deadline = performance.now() + 4000; while (commandPosts === beforeHeld) { assert(performance.now() < deadline); await new Promise(done => setTimeout(done, 5)); } const submittedTime = capturedTimes.at(-1)!; assert.equal(settled, false); await check(false,'stopped'); assert.equal(callbacks.length,beforeHeldCallbacks); const healthAt = performance.now(); assert.equal((await hub.request<{status:string}>('system.health',{})).status,'ok'); evidence.healthWhileWriterHeldMs = performance.now() - healthAt; await new Promise(done => setTimeout(done,1200)); assert.equal(settled,false); lock.exec('COMMIT'); lock.close(); lock=undefined; assert.deepEqual(await pending,{source,globallyEnabled:true}); assert.equal(row().updated_at,submittedTime); await check(true,'started'); assert.equal(callbacks.length,beforeHeldCallbacks+1); evidence.deliberatelyHeldWriterMs=performance.now()-heldAt; evidence.callbackAndReplyWaitForCommit=true; evidence.preAdmissionTimestampRetained=true; await enable(false); await check(false,'stopped');
  const beforeRefusal = commandPosts, beforeRefusalCallbacks = callbacks.length; rejectNext=true; await assert.rejects(enable(true),/admission rejected/); await check(false,'stopped'); await new Promise(done=>setTimeout(done,50)); assert.equal(commandPosts,beforeRefusal+1); assert.equal(callbacks.length,beforeRefusalCallbacks); evidence.rejectedAdmissionHasNoFallbackStartOrReplay=true;
  const beforeLoss=commandPosts,beforeLossCallbacks=callbacks.length; loseNext=true; await assert.rejects(enable(true),/outcome unknown/); await check(true,'stopped'); await new Promise(done=>setTimeout(done,100)); await check(true,'stopped'); assert.equal(commandPosts,beforeLoss+1); assert.equal(callbacks.length,beforeLossCallbacks); evidence.actualLostCommittedReplyNeverStartsOrReplays=true;
  assert.equal(mainSqlAttempts,0); assert(maxLoopLagMs<1000); evidence.maxLoopLagMs=maxLoopLagMs; evidence.commandPosts=commandPosts; evidence.callbackObservations=callbacks; evidence.rssBytes=process.memoryUsage().rss; evidence.walBytes=existsSync(`${app.db.getDbPath()}-wal`)?statSync(`${app.db.getDbPath()}-wal`).size:0; evidence.pass=true;
} finally {
  measuring=false; if(timer)clearInterval(timer); if(lock){try{lock.exec('ROLLBACK');}catch{}lock.close();}
  try{await transport?.close();await Promise.all([...processors].map(p=>p.stop()));await app?.cleanup();}
  finally{JobQueueProcessor.prototype.start=original.start;ExternalEventExtensionManager.prototype.register=original.register;Database.prototype.prepare=original.prepare;globalThis.Worker=original.Worker;globalThis.fetch=original.fetch;evidence.mainSqlAttempts=mainSqlAttempts;evidence.metrics=metrics;writeFileSync(join(run,'evidence/extension-global-activation.json'),JSON.stringify(evidence,null,2));}
}
console.log('ok native public global extension setter uses writer commit before lifecycle/reply, preserves config and rollback, no main UPSERT/fallback/start/replay after unknown admission');
