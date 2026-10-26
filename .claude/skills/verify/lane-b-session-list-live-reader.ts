import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session, LiveQuerySnapshotEvent, LiveQueryDeltaEvent } from '@hyperneo/shared';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.equal(process.env[key], undefined);
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { JobQueueProcessor } = await import('../../../packages/daemon/src/storage/job-queue-processor.ts');
const { Database: SQLite } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
const { sessionWrites } = await import('../../../packages/daemon/src/storage/repositories/session-repository.ts');
const { SESSIONS_LIST_SQL, SESSION_COUNTERS_SQL, mapSessionRow } = await import('../../../packages/daemon/src/lib/live-query/queries/sessions.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const NativeWorker = globalThis.Worker;
const fetch = globalThis.fetch;
const start = JobQueueProcessor.prototype.start;
const prepare = SQLite.prototype.prepare;
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
let rejectNextList = false;
let listRequests = 0;
let measuring = false;
let mainSqlAttempts = 0;
SQLite.prototype.prepare = function (...args) {
  const statement = Reflect.apply(prepare, this, args);
  if (!/\b(?:sessions|session_counters)\b/i.test(args[0])) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return (...values: unknown[]) => {
      if (measuring && ['get', 'all', 'iterate', 'run', 'values'].includes(String(key))) {
        mainSqlAttempts++;
        throw new Error('live session list or counters SQL reached main connection');
      }
      return Reflect.apply(value, target, values);
    };
  } });
};
globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
  const worker = new NativeWorker(url, options);
  if (String(url).endsWith('/db-gateway-worker.ts')) {
    const post = worker.postMessage.bind(worker);
    worker.postMessage = ((message: { op?: string; lane?: string }) => {
      if (message.op === 'sessions.list.live.read') {
        assert.equal(message.lane, 'read');
        listRequests++;
        if (rejectNextList) {
          rejectNextList = false;
          queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic live session reader failure', cancelable: true })));
          return;
        }
      }
      post(message);
    }) as typeof worker.postMessage;
  }
  return worker;
} as unknown as typeof Worker;
globalThis.fetch = (() => { throw new Error('External HTTP refused by live session fixture'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
let writer: InstanceType<typeof SQLite> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const evidence: Record<string, unknown> = {};
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert(Date.now() < deadline, 'subscription evidence timed out'); await new Promise((resolve) => setTimeout(resolve, 10)); }
};
try {
  JobQueueProcessor.prototype.start = function () { processors.add(this); return start.call(this); };
  try {
    app = await createDaemonApp({ config: {
      ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }),
      disableWorktrees: true, disableGoalProcessing: true,
    }, verbose: false });
  } finally { JobQueueProcessor.prototype.start = start; }
  assert.notEqual(app.server.port, 8399);
  await Promise.all([...processors].map((processor) => processor.stop()));
  const session = (id: string, status: Session['status'], extra: Partial<Session> = {}): Session => ({
    id, title: `Synthetic live ${id}`, workspacePath: join(run, 'workspace'),
    createdAt: '2026-10-26T00:00:00.000Z', lastActiveAt: '2026-10-26T01:00:00.000Z', status,
    config: { queryMode: 'manual', model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0 },
    metadata: { messageCount: 17, totalTokens: 31, inputTokens: 20, outputTokens: 11, totalCost: 0.5, toolCallCount: 2, titleGenerated: true, titleSetBy: 'user', inputDraft: 'full draft 🦊' },
    availableCommands: ['/synthetic-command'], processingState: JSON.stringify({ status: 'idle', heldPrompt: { content: 'retained only in storage' } }),
    sdkSessionId: `synthetic-sdk-${id}`, acpSessionId: `synthetic-acp-${id}`, gitBranch: 'synthetic-branch', ...extra,
  });
  for (const value of [session('live-a', 'active'), session('live-b', 'paused'), session('live-archived', 'archived'), session('live-space', 'active', { context: { spaceId: 'synthetic-space' } }), session('live-room', 'active', { type: 'room_chat', context: { roomId: 'synthetic-room' } })]) await app.db.createSession(value);
  const raw = app.db.getDatabase();
  raw.exec('CREATE TABLE synthetic_live_counter(value INTEGER); INSERT INTO synthetic_live_counter VALUES(0)');
  const reference = (includeArchived: number) => {
    const counters = raw.prepare(SESSION_COUNTERS_SQL).get() as { total_count: number; archived_count: number };
    return { rows: (raw.prepare(SESSIONS_LIST_SQL).all(includeArchived) as Record<string, unknown>[]).map(mapSessionRow), metadata: { totalCount: counters.total_count, archivedCount: counters.archived_count } };
  };
  const expectedAll = JSON.parse(JSON.stringify(reference(1)));
  const expectedActive = JSON.parse(JSON.stringify(reference(0)));
  assert.equal(expectedAll.rows.length, 3); assert.equal(expectedActive.rows.length, 2);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport); await transport.initialize();
  const snapshots: LiveQuerySnapshotEvent[] = [];
  const deltas: LiveQueryDeltaEvent[] = [];
  const errors: { subscriptionId: string }[] = [];
  hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => snapshots.push(event));
  hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => deltas.push(event));
  hub.onEvent<{ subscriptionId: string }>('liveQuery.error', (event) => errors.push(event));
  const subscribe = (subscriptionId: string, includeArchived: number) => hub.request('liveQuery.subscribe', { subscriptionId, queryName: 'sessions.list', params: [includeArchived] });
  const unsubscribe = (subscriptionId: string) => hub.request('liveQuery.unsubscribe', { subscriptionId });
  let previous = performance.now(); let maxLagMs = 0;
  timer = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - previous - 5); previous = now; }, 5);
  measuring = true;
  writer = new SQLite(app.db.getDbPath()); writer.exec('BEGIN IMMEDIATE; UPDATE synthetic_live_counter SET value=value+1');
  try {
    const coldAt = performance.now();
    await subscribe('live-all', 1); evidence.coldSubscribeMs = performance.now() - coldAt;
    const warmAt = performance.now(); const healthAt = performance.now();
    await Promise.all([subscribe('live-active', 0), hub.request('system.health', {}).then((value) => { assert.equal((value as { status: string }).status, 'ok'); evidence.concurrentHealthMs = performance.now() - healthAt; })]);
    evidence.warmSubscribeMs = performance.now() - warmAt;
    evidence.concurrentWalWriter = true;
  } finally {
    try { writer.exec('ROLLBACK'); } catch (error) { evidence.rollbackAfterFailure = String(error); }
    writer.close(); writer = undefined;
  }
  const all = snapshots.find((event) => event.subscriptionId === 'live-all')!;
  const active = snapshots.find((event) => event.subscriptionId === 'live-active')!;
  assert.deepEqual({ rows: all.rows, metadata: all.metadata }, expectedAll);
  assert.deepEqual({ rows: active.rows, metadata: active.metadata }, expectedActive);
  for (const row of all.rows) assert(!JSON.parse(String(row.processingState)).heldPrompt);
  evidence.fullSnapshotsMatched = true;
  await app.db.gateway.call(sessionWrites, 'guardedUpdateSession', 'live-a', { status: 'archived', archivedAt: new Date().toISOString() }, 'active');
  await waitFor(() => ['live-all', 'live-active'].every((id) => deltas.some((event) => event.subscriptionId === id && event.metadata?.archivedCount === 2)));
  const archiveDelta = deltas.find((event) => event.subscriptionId === 'live-active' && event.metadata?.archivedCount === 2)!;
  assert.deepEqual(archiveDelta.removed?.map((row) => row.id), ['live-a']);
  assert.equal(archiveDelta.rowCount, 1); assert.equal(archiveDelta.metadata?.totalCount, 3);
  await app.db.gateway.call(sessionWrites, 'createSession', session('live-extra-archived', 'archived'));
  await waitFor(() => deltas.some((event) => event.subscriptionId === 'live-active' && event.metadata?.totalCount === 4));
  const metadataOnly = deltas.find((event) => event.subscriptionId === 'live-active' && event.metadata?.totalCount === 4)!;
  assert.equal(metadataOnly.rowCount, 1); assert.equal(metadataOnly.metadata?.archivedCount, 3);
  assert.equal(metadataOnly.added?.length ?? 0, 0); assert.equal(metadataOnly.updated?.length ?? 0, 0); assert.equal(metadataOnly.removed?.length ?? 0, 0);
  evidence.archiveAndMetadataOnlyDeltas = true;
  const beforeUnknown = listRequests;
  app.reactiveDb.notifyChange('sessions', { sessionId: 'live-space' });
  await waitFor(() => listRequests >= beforeUnknown + 2);
  evidence.unknownScopeInvalidatedWithoutLookup = true;
  const beforeKnown = listRequests;
  app.reactiveDb.notifyChange('sessions', { sessionId: 'live-space', spaceId: 'synthetic-space' });
  await new Promise((resolve) => setTimeout(resolve, 200)); assert.equal(listRequests, beforeKnown);
  await unsubscribe('live-all'); await unsubscribe('live-active');
  rejectNextList = true;
  evidence.initialReaderFailure = await subscribe('live-failed', 1).then(() => 'unexpected success', String);
  assert.match(String(evidence.initialReaderFailure), /synthetic live session reader failure/);
  await subscribe('live-recovered', 1);
  const recovered = snapshots.find((event) => event.subscriptionId === 'live-recovered')!;
  assert.equal(recovered.rows.length, 4); assert.equal(recovered.metadata?.archivedCount, 3); assert.equal(recovered.metadata?.totalCount, 4);
  rejectNextList = true; app.reactiveDb.notifyChange('sessions');
  await waitFor(() => errors.some((event) => event.subscriptionId === 'live-recovered'));
  await subscribe('live-final', 1);
  evidence.healthAfterFailures = await hub.request('system.health', {});
  assert.equal((evidence.healthAfterFailures as { status: string }).status, 'ok');
  await unsubscribe('live-final');
  evidence.workerFailureRecoveryAndDisposal = true;
  assert.equal(app.sessionManager.getCachedSessions().length, 0);
  evidence.actorCacheStayedEmpty = true;
  evidence.readLaneRequests = listRequests; evidence.maxLoopLagMs = maxLagMs;
  evidence.snapshotLatencyUnder250ms = Number(evidence.coldSubscribeMs) < 250 && Number(evidence.warmSubscribeMs) < 250;
  assert.equal(mainSqlAttempts, 0); assert(maxLagMs < 1000);
  measuring = false;
  assert(JSON.parse(String((raw.prepare('SELECT processing_state FROM sessions WHERE id = ?').get('live-a') as { processing_state: string }).processing_state)).heldPrompt);
  evidence.storedHeldPromptRetained = true;
} finally {
  measuring = false;
  if (timer) clearInterval(timer);
  writer?.close();
  JobQueueProcessor.prototype.start = start;
  await transport?.close();
  await Promise.all([...processors].map((processor) => processor.stop()));
  await app?.cleanup();
  SQLite.prototype.prepare = prepare;
  globalThis.Worker = NativeWorker; globalThis.fetch = fetch;
  evidence.mainSqlAttempts = mainSqlAttempts;
  writeFileSync(join(run, 'evidence/session-list-live-reader.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok live session rows and counters share the read snapshot; snapshot/delta/failure paths run no target SQL on main');
