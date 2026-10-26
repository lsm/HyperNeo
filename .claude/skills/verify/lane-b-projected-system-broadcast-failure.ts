import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { HealthStatus, SystemState } from '@hyperneo/shared';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data')));
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.equal(process.env[key], undefined);
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { ProviderCredentialManager } = await import('../../../packages/daemon/src/lib/credentials/provider-credential-manager.ts');
const { installProcessFatalLogging } = await import('../../../packages/daemon/src/lib/process-fatal-logger.ts');
const { Logger } = await import('../../../packages/daemon/src/lib/logger.ts');
const { JobQueueProcessor } = await import('../../../packages/daemon/src/storage/job-queue-processor.ts');
const { Database: SQLite } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport, STATE_CHANNELS } = await import('../../../packages/shared/src/mod.ts');
const NativeWorker = globalThis.Worker;
const fetch = globalThis.fetch;
const start = JobQueueProcessor.prototype.start;
const register = ProviderCredentialManager.prototype.registerStatusChangeCallback;
const prepare = SQLite.prototype.prepare;
const warn = Logger.prototype.warn;
const emit = MessageHub.prototype.event;
const callbacks: (() => void)[] = [];
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
const exitRequests: number[] = [];
const warnings: string[] = [];
const broadcasts: { version: unknown; health: unknown }[] = [];
let measuring = false; let rejectNextCount = false; let readRequests = 0; let mainSqlAttempts = 0;
const disposeFatal = installProcessFatalLogging({ exit: (code) => { exitRequests.push(code); } });
ProviderCredentialManager.prototype.registerStatusChangeCallback = function (callback) {
  callbacks.push(callback);
  return Reflect.apply(register, this, [callback]);
};
Logger.prototype.warn = function (...args) {
  if (String(args[0]).includes('Failed to broadcast system state')) warnings.push(args.map(String).join(' '));
  return Reflect.apply(warn, this, args);
};
MessageHub.prototype.event = function (...args) {
  if (measuring && args[0] === STATE_CHANNELS.GLOBAL_SYSTEM) {
    const state = args[1] as SystemState & { version: unknown };
    broadcasts.push({ version: state.version, health: state.health });
  }
  return Reflect.apply(emit, this, args);
};
SQLite.prototype.prepare = function (...args) {
  const statement = Reflect.apply(prepare, this, args);
  if (!/\b(?:sessions|session_counters)\b/i.test(args[0])) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key); if (typeof value !== 'function') return value;
    return (...values: unknown[]) => {
      if (measuring && ['get', 'all', 'iterate', 'run', 'values'].includes(String(key))) { mainSqlAttempts++; throw new Error('broadcast session or counter SQL reached main connection'); }
      return Reflect.apply(value, target, values);
    };
  } });
};
globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
  const worker = new NativeWorker(url, options);
  if (String(url).endsWith('/db-gateway-worker.ts')) {
    const post = worker.postMessage.bind(worker);
    worker.postMessage = ((message: { op?: string; lane?: string }) => {
      if (message.op === 'sessions.healthCount.read' && measuring) {
        readRequests++; assert.equal(message.lane, 'read');
        if (rejectNextCount) {
          rejectNextCount = false;
          queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic broadcast reader failure', cancelable: true })));
          return;
        }
      }
      post(message);
    }) as typeof worker.postMessage;
  }
  return worker;
} as unknown as typeof Worker;
globalThis.fetch = (() => { throw new Error('External HTTP refused by broadcast fixture'); }) as typeof fetch;
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert(Date.now() < deadline, 'broadcast evidence timed out'); await new Promise((resolve) => setTimeout(resolve, 10)); }
};
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
const evidence: Record<string, unknown> = { fatalExitObservedThroughInjectedHook: true };
try {
  JobQueueProcessor.prototype.start = function () { processors.add(this); return start.call(this); };
  try {
    app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  } finally { JobQueueProcessor.prototype.start = start; }
  assert.notEqual(app.server.port, 8399);
  await Promise.all([...processors].map((processor) => processor.stop()));
  await app.db.startSdkMessageColumnsBackfill();
  await app.db.createSession({ id: 'broadcast-session', title: 'Synthetic broadcast', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual', model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0 }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false }); hub.registerTransport(transport); await transport.initialize();
  evidence.healthBefore = await hub.request<HealthStatus>('system.health', {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(callbacks.length, 1, 'capture the actual app credential-status callback');
  evidence.actualAppCallbackCaptured = true;
  measuring = true; rejectNextCount = true;
  callbacks[0]();
  await waitFor(() => exitRequests.length > 0 || warnings.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  evidence.attemptsAfterFailure = readRequests;
  evidence.eventsAfterFailure = broadcasts.length;
  evidence.exitRequestsAfterFailure = [...exitRequests];
  assert.deepEqual(exitRequests, [], 'the actual app callback must not request a process-fatal exit after reader failure');
  assert.equal(warnings.length, 1); assert.match(warnings[0], /synthetic broadcast reader failure/);
  assert.equal(readRequests, 1, 'failed fire-and-forget broadcast must not automatically replay the read');
  assert.equal(broadcasts.length, 0, 'failed broadcast must not emit stale system state');
  evidence.healthAfterFailure = await hub.request<HealthStatus>('system.health', {});
  assert.equal((evidence.healthAfterFailure as HealthStatus).status, 'ok');
  callbacks[0]();
  await waitFor(() => broadcasts.length === 1);
  assert.equal((broadcasts[0].health as HealthStatus).sessions.total, 1);
  evidence.successfulBroadcast = broadcasts[0];
  const state = await hub.request<{ system: SystemState }>(STATE_CHANNELS.GLOBAL_SNAPSHOT, { includeSessions: false });
  assert.equal(state.system.health.sessions.total, 1);
  evidence.projectedRpcRecovered = true;
  assert.equal(app.sessionManager.getCachedSessions().length, 0); evidence.actorCacheStayedEmpty = true;
  assert.deepEqual(exitRequests, []); assert.equal(mainSqlAttempts, 0);
} finally {
  measuring = false;
  disposeFatal();
  JobQueueProcessor.prototype.start = start;
  await transport?.close(); await Promise.all([...processors].map((processor) => processor.stop())); await app?.cleanup();
  ProviderCredentialManager.prototype.registerStatusChangeCallback = register;
  Logger.prototype.warn = warn; MessageHub.prototype.event = emit; SQLite.prototype.prepare = prepare;
  globalThis.Worker = NativeWorker; globalThis.fetch = fetch;
  evidence.exitRequests = exitRequests; evidence.warnings = warnings; evidence.mainSqlAttempts = mainSqlAttempts;
  writeFileSync(join(run, 'evidence/projected-system-broadcast-failure.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok actual credential-status callback absorbs failed system broadcast without fatal exit, stale emission or automatic retry');
