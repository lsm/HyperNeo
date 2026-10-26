import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session } from '@hyperneo/shared';

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
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const NativeWorker = globalThis.Worker;
const fetch = globalThis.fetch;
const start = JobQueueProcessor.prototype.start;
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
let rejectNextList = false;
let listRequests = 0;
globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
  const worker = new NativeWorker(url, options);
  if (String(url).endsWith('/db-gateway-worker.ts')) {
    const post = worker.postMessage.bind(worker);
    worker.postMessage = ((message: { op?: string; lane?: string }) => {
      if (message.op === 'sessions.list.read') {
        assert.equal(message.lane, 'read');
        listRequests++;
        if (rejectNextList) {
          rejectNextList = false;
          queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic session list worker failure', cancelable: true })));
          return;
        }
      }
      post(message);
    }) as typeof worker.postMessage;
  }
  return worker;
} as unknown as typeof Worker;
globalThis.fetch = (() => { throw new Error('External HTTP refused by session-list fixture'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
let writer: InstanceType<typeof SQLite> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const evidence: Record<string, unknown> = {};
try {
  JobQueueProcessor.prototype.start = function () { processors.add(this); return start.call(this); };
  try {
    app = await createDaemonApp({ config: {
      ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }),
      disableWorktrees: true, disableGoalProcessing: true,
    }, verbose: false });
  } finally {
    JobQueueProcessor.prototype.start = start;
  }
  assert.notEqual(app.server.port, 8399);
  await Promise.all([...processors].map((processor) => processor.stop()));
  const session = (id: string, status: Session['status'], extra: Partial<Session> = {}): Session => ({
    id, title: `Synthetic list ${id}`, workspacePath: join(run, 'workspace'),
    createdAt: '2026-10-26T00:00:00.000Z', lastActiveAt: '2026-10-26T01:00:00.000Z', status,
    config: { queryMode: 'manual', model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0 },
    metadata: { messageCount: 17, totalTokens: 31, inputTokens: 20, outputTokens: 11, totalCost: 0.5, toolCallCount: 2, titleGenerated: true, titleSetBy: 'user', inputDraft: 'retained full draft 🦊' },
    availableCommands: ['/synthetic-command'], processingState: JSON.stringify({ status: 'idle' }),
    sdkSessionId: `synthetic-sdk-${id}`, acpSessionId: `synthetic-acp-${id}`, gitBranch: 'synthetic-branch',
    ...extra,
  });
  const fixtures = [
    session('active-list', 'active', { worktree: { isWorktree: true, worktreePath: join(run, 'workspace'), mainRepoPath: join(run, 'repo'), branch: 'synthetic-branch' } }),
    session('paused-list', 'paused'), session('ended-list', 'ended'),
    session('archived-list', 'archived', { archivedAt: '2026-10-26T04:00:00.000Z' }),
    session('space-list', 'active', { context: { spaceId: 'synthetic-space' } }),
    session('room-list', 'active', { context: { roomId: 'synthetic-room' } }),
    session('child-list', 'active', { parentSessionId: 'active-list' }),
    ...(['lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat'] as const).map((type) => session(`excluded-${type}`, 'active', { type })),
  ];
  for (const [index, value] of fixtures.entries()) await app.db.createSession({ ...value, lastActiveAt: new Date(Date.parse('2026-10-26T01:00:00.000Z') + index * 1000).toISOString() });
  const raw = app.db.getDatabase();
  raw.exec('CREATE TABLE synthetic_session_list_counter(value INTEGER); INSERT INTO synthetic_session_list_counter VALUES(0)');
  const hashRows = () => createHash('sha256').update(JSON.stringify(raw.prepare('SELECT * FROM sessions ORDER BY id').all())).digest('hex');
  const beforeHash = hashRows();
  const queries = [undefined, {}, { status: 'paused' }, { includeArchived: true }, { status: 'archived', includeArchived: false }, { status: 'missing' }, { includeArchived: true, includeSpaceSessions: true }];
  const expected = queries.map((options) => ({ sessions: app!.sessionManager.listSessions({ status: options?.status, includeArchived: options?.includeArchived }) }));
  assert.equal(expected[0].sessions.length, 4);
  assert.equal(expected[3].sessions.length, 5);
  assert.deepEqual(expected[4].sessions.map((row) => row.id), ['archived-list']);
  assert.equal(app.sessionManager.getCachedSessions().length, 0);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (/\bsessions\b/i.test(args[0])) {
      mainSqlAttempts++;
      throw new Error('session list SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  try {
    let previous = performance.now();
    let maxLagMs = 0;
    timer = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - previous - 5); previous = now; }, 5);
    const coldAt = performance.now();
    const cold = await hub.request('session.list', undefined);
    evidence.coldMs = performance.now() - coldAt;
    assert.deepEqual(cold, JSON.parse(JSON.stringify(expected[0])));
    writer = new SQLite(app.db.getDbPath());
    writer.exec('BEGIN IMMEDIATE; UPDATE synthetic_session_list_counter SET value=value+1');
    try {
      const warmAt = performance.now();
      const healthAt = performance.now();
      const health = hub.request('system.health', {}).then((value) => { assert.equal((value as { status: string }).status, 'ok'); evidence.concurrentHealthMs = performance.now() - healthAt; });
      const replies = await Promise.all(queries.map((options) => hub.request('session.list', options)));
      evidence.warmConcurrentMs = performance.now() - warmAt;
      await health;
      assert.deepEqual(replies, JSON.parse(JSON.stringify(expected)));
      evidence.fullRowCounts = replies.map((value) => (value as { sessions: Session[] }).sessions.length);
      evidence.replyHash = createHash('sha256').update(JSON.stringify(replies)).digest('hex');
      evidence.concurrentWalWriter = true;
    } finally {
      writer.exec('ROLLBACK'); writer.close(); writer = undefined;
    }
    rejectNextList = true;
    evidence.workerFailure = await hub.request('session.list', {}).then(() => 'unexpected success', String);
    assert.match(String(evidence.workerFailure), /synthetic session list worker failure/);
    evidence.healthAfterFailure = await hub.request('system.health', {});
    assert.equal((evidence.healthAfterFailure as { status: string }).status, 'ok');
    assert.deepEqual(await hub.request('session.list', {}), JSON.parse(JSON.stringify(expected[0])));
    assert.equal(app.sessionManager.getCachedSessions().length, 0);
    evidence.actorCacheStayedEmpty = true;
    evidence.readLaneRequests = listRequests;
    assert.equal(mainSqlAttempts, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    evidence.maxLoopLagMs = maxLagMs;
    evidence.rpcLatencyUnder250ms = [evidence.coldMs, evidence.warmConcurrentMs, evidence.concurrentHealthMs].every((ms) => Number(ms) < 250);
    assert.equal(evidence.rpcLatencyUnder250ms, true);
    assert(maxLagMs < 1000);
  } finally {
    if (timer) { clearInterval(timer); timer = undefined; }
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
  evidence.storedRowsUnchanged = hashRows() === beforeHash;
  assert.equal(evidence.storedRowsUnchanged, true);
} finally {
  if (timer) clearInterval(timer);
  writer?.close();
  JobQueueProcessor.prototype.start = start;
  await transport?.close();
  await Promise.all([...processors].map((processor) => processor.stop()));
  await app?.cleanup();
  globalThis.Worker = NativeWorker;
  globalThis.fetch = fetch;
  writeFileSync(join(run, 'evidence/session-list-reader.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok session.list preserves full rows and filters on the read worker with no main SQL or actor initialization');
