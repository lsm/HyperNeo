import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { HealthStatus, Session, GlobalStateSnapshot, GlobalSystemSnapshot } from '@hyperneo/shared';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data')));
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.equal(process.env[key], undefined);
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { JobQueueProcessor } = await import('../../../packages/daemon/src/storage/job-queue-processor.ts');
const { Database: SQLite } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
const { sessionWrites } = await import('../../../packages/daemon/src/storage/repositories/session-repository.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { BUILD_METADATA } = await import('../../../packages/daemon/src/lib/build-metadata.ts');
const { MessageHub, WebSocketClientTransport, STATE_CHANNELS } = await import('../../../packages/shared/src/mod.ts');
const NativeWorker = globalThis.Worker; const fetch = globalThis.fetch;
const start = JobQueueProcessor.prototype.start; const prepare = SQLite.prototype.prepare;
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
let measuring = false; let mainSqlAttempts = 0; let rejectNextCount = false; let countRequests = 0;
let rejectNextProjection = false;
SQLite.prototype.prepare = function (...args) {
  const statement = Reflect.apply(prepare, this, args);
  if (!/\b(?:sessions|session_counters)\b/i.test(args[0])) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key); if (typeof value !== 'function') return value;
    return (...values: unknown[]) => {
      if (measuring && ['get', 'all', 'iterate', 'run', 'values'].includes(String(key))) { mainSqlAttempts++; throw new Error('projected session or counter SQL reached main connection'); }
      return Reflect.apply(value, target, values);
    };
  } });
};
globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
  const worker = new NativeWorker(url, options);
  if (String(url).endsWith('/db-gateway-worker.ts')) {
    const post = worker.postMessage.bind(worker);
    worker.postMessage = ((message: { op?: string; lane?: string }) => {
      if (message.op === 'sessions.projection.read' && rejectNextProjection) {
        rejectNextProjection = false;
        queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic projection row worker failure', cancelable: true })));
        return;
      }
      if (message.op === 'sessions.healthCount.read') {
        assert.equal(message.lane, 'read'); countRequests++;
        if (rejectNextCount) { rejectNextCount = false; queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic health count worker failure', cancelable: true }))); return; }
      }
      post(message);
    }) as typeof worker.postMessage;
  }
  return worker;
} as unknown as typeof Worker;
globalThis.fetch = (() => { throw new Error('External HTTP refused by health counter fixture'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
let writer: InstanceType<typeof SQLite> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const evidence: Record<string, unknown> = {};
try {
  JobQueueProcessor.prototype.start = function () { processors.add(this); return start.call(this); };
  try {
    app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  } finally { JobQueueProcessor.prototype.start = start; }
  assert.notEqual(app.server.port, 8399); await Promise.all([...processors].map((processor) => processor.stop()));
  const session = (id: string, extra: Partial<Session> = {}): Session => ({
    id, title: 'Synthetic health counter', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active',
    config: { queryMode: 'manual', model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0 },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0, titleGenerated: true, titleSetBy: 'user' }, ...extra,
  });
  for (const value of [session('health-active'), session('health-paused', { status: 'paused' }), session('health-archived', { status: 'archived' }), session('health-space', { context: { spaceId: 'synthetic-space' } }), session('health-room', { context: { roomId: 'synthetic-room' } }), session('health-lobby', { type: 'lobby' })]) await app.db.createSession(value);
  assert.equal(app.db.countHumanSessions(), 3);
  const expectedVisible = JSON.parse(JSON.stringify(app.db.listSessions()));
  const expectedAll = JSON.parse(JSON.stringify(app.db.listSessions({ includeArchived: true })));
  const active = app.sessionManager.getActiveSessions(); assert.equal(active, 0);
  const raw = app.db.getDatabase(); raw.exec('CREATE TABLE synthetic_health_counter(value INTEGER); INSERT INTO synthetic_health_counter VALUES(0)');
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false }); hub.registerTransport(transport); await transport.initialize();
  const health = async () => {
    const projected = await hub.request<GlobalSystemSnapshot>(STATE_CHANNELS.GLOBAL_SNAPSHOT, { includeSessions: false });
    assert(!('sessions' in projected)); assert.equal(projected.meta.channel, 'global');
    assert.equal(projected.system.version, BUILD_METADATA.version); assert.equal(projected.system.claudeSDKVersion, BUILD_METADATA.claudeSdkVersion);
    assert.equal(projected.system.auth.isAuthenticated, false); assert(projected.settings.settings);
    evidence.systemOnlyContractMatched = true;
    return projected.system.health;
  };
  const full = () => hub.request<GlobalStateSnapshot>(STATE_CHANNELS.GLOBAL_SNAPSHOT, {});
  const validate = (value: HealthStatus, total: number) => {
    assert.equal(value.status, 'ok'); assert.equal(value.version, BUILD_METADATA.version); assert(Number.isFinite(value.uptime) && value.uptime >= 0);
    assert.deepEqual(value.sessions, { active, total }); assert.equal(value.dataMigration?.state, 'complete');
  };
  writer = new SQLite(app.db.getDbPath()); writer.exec('PRAGMA busy_timeout=5000'); writer.exec('BEGIN IMMEDIATE'); writer.prepare('UPDATE synthetic_health_counter SET value=value+1').run();
  const counters = () => ({ outside: (raw.prepare('SELECT value FROM synthetic_health_counter').get() as { value: number }).value, inside: (writer!.prepare('SELECT value FROM synthetic_health_counter').get() as { value: number }).value });
  evidence.writerCounterBefore = counters(); assert.deepEqual(evidence.writerCounterBefore, { outside: 0, inside: 1 });
  let previous = performance.now(); let maxLagMs = 0;
  timer = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - previous - 5); previous = now; }, 5);
  measuring = true;
  try {
    const coldAt = performance.now(); const first = await health(); evidence.coldMs = performance.now() - coldAt; validate(first, 3); evidence.firstHealth = first;
    const initialFull = await full(); validate(initialFull.system.health, 3); assert.deepEqual(initialFull.sessions.sessions, expectedVisible); assert.equal(initialFull.sessions.hasArchivedSessions, true); evidence.fullContractMatched = true;
    const warmAt = performance.now(); const replies = await Promise.all(Array.from({ length: 20 }, health)); evidence.concurrentWarmMs = performance.now() - warmAt; replies.forEach((value) => validate(value, 3));
    evidence.writerCounterAfter = counters(); assert.deepEqual(evidence.writerCounterAfter, { outside: 0, inside: 1 }); evidence.concurrentWalWriter = true;
  } finally { writer.exec('ROLLBACK'); writer.close(); writer = undefined; }
  await hub.request('settings.global.update', { updates: { showArchived: true } });
  const archived = await full(); assert.equal(archived.settings.settings.showArchived, true); assert.deepEqual(archived.sessions.sessions, expectedAll); assert.equal(archived.sessions.hasArchivedSessions, true); evidence.archivedToggleMatched = true;
  await app.db.gateway.call(sessionWrites, 'createSession', session('health-later'));
  const updated = await health(); validate(updated, 4); evidence.committedCount = updated.sessions.total;
  rejectNextProjection = true; evidence.rowWorkerFailure = await full().then(() => 'unexpected success', String); assert.match(String(evidence.rowWorkerFailure), /synthetic projection row worker failure/);
  validate(await health(), 4);
  rejectNextCount = true; evidence.workerFailure = await health().then(() => 'unexpected success', String); assert.match(String(evidence.workerFailure), /synthetic health count worker failure/);
  evidence.otherRpcAfterFailure = await hub.request('message.sdkMessages', { sessionId: 'conv:health-liveness' }); assert.deepEqual(evidence.otherRpcAfterFailure, { sdkMessages: [], hasMore: false, backgroundTaskMessages: [] });
  const recovered = await full(); validate(recovered.system.health, 4); assert.equal(recovered.sessions.sessions.length, 4); assert.equal(recovered.sessions.hasArchivedSessions, true); evidence.recoveredHealth = recovered.system.health; evidence.fullRecoveryRows = recovered.sessions.sessions.length;
  assert.equal(app.sessionManager.getCachedSessions().length, 0); evidence.actorCacheStayedEmpty = true;
  evidence.readLaneRequests = countRequests;
  await new Promise((resolve) => setTimeout(resolve, 10)); evidence.maxLoopLagMs = maxLagMs;
  evidence.rpcLatencyUnder250ms = Number(evidence.coldMs) < 250 && Number(evidence.concurrentWarmMs) < 250;
  assert.equal(evidence.rpcLatencyUnder250ms, true); assert(maxLagMs < 1000); assert.equal(mainSqlAttempts, 0);
} finally {
  measuring = false; if (timer) clearInterval(timer); writer?.close(); JobQueueProcessor.prototype.start = start;
  await transport?.close(); await Promise.all([...processors].map((processor) => processor.stop())); await app?.cleanup();
  SQLite.prototype.prepare = prepare; globalThis.Worker = NativeWorker; globalThis.fetch = fetch;
  evidence.mainSqlAttempts = mainSqlAttempts; writeFileSync(join(run, 'evidence/projected-session-reader.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok projected system/full snapshots preserve session rows and health counts with no target SQL on main');
