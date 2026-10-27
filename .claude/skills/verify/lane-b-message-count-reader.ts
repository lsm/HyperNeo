import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { Session } from '@hyperneo/shared';

const run = resolve(process.argv.at(-1)!);
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
const nativeFetch = globalThis.fetch;
const start = JobQueueProcessor.prototype.start;
const prepare = SQLite.prototype.prepare;
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
let measuring = false;
let mainSqlAttempts = 0;
let rejectNextRead = false;
const workerTimings: { roundTripMs: number; replyBytes: number; encodeMs: number }[] = [];
SQLite.prototype.prepare = function (...args) {
  const statement = Reflect.apply(prepare, this, args);
  if (!/\b(?:sessions|session_counters|sdk_messages|sdk_message_bodies)\b/i.test(args[0])) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return (...values: unknown[]) => {
      if (measuring && ['get', 'all', 'iterate', 'run', 'values'].includes(String(key))) {
        mainSqlAttempts++;
        throw new Error('message-count session or message SQL reached main');
      }
      return Reflect.apply(value, target, values);
    };
  } });
};
globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
  const worker = new NativeWorker(url, options);
  if (String(url).endsWith('/db-gateway-worker.ts')) {
    const post = worker.postMessage.bind(worker);
    const sent = new Map<number, number>();
    worker.postMessage = ((message: { id: number; op?: string; lane?: string }) => {
      if (message.op === 'sdk.message.count.read') {
        assert.equal(message.lane, 'read');
        if (rejectNextRead) {
          rejectNextRead = false;
          queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic message-count reader failure', cancelable: true })));
          return;
        }
        sent.set(message.id, performance.now());
      }
      post(message);
    }) as typeof worker.postMessage;
    worker.addEventListener('message', ({ data }) => {
      const at = sent.get(data.id);
      if (at === undefined) return;
      sent.delete(data.id);
      if (data.error) return;
      const encodeAt = performance.now();
      const encoded = JSON.stringify(data.result);
      workerTimings.push({ roundTripMs: encodeAt - at, replyBytes: Buffer.byteLength(encoded), encodeMs: performance.now() - encodeAt });
    });
  }
  return worker;
} as unknown as typeof Worker;
globalThis.fetch = (() => { throw new Error('External HTTP refused by message-count fixture'); }) as typeof fetch;
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
  assert.notEqual(app.server.port, 8399);
  await Promise.all([...processors].map((processor) => processor.stop()));
  for (const id of ['count-history', 'other-history', 'empty-history']) {
    const session: Session = { id, title: 'Synthetic message count', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active',
      config: { queryMode: 'manual', model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0 },
      metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0, titleGenerated: true, titleSetBy: 'user' } };
    await app.db.createSession(session);
  }
  for (const status of ['consumed', 'enqueued'] as const) await app.db.saveUserMessage('count-history', { type: 'user', uuid: `count-${status}`, parent_tool_use_id: null, message: { role: 'user', content: status } }, status);
  for (const message of [
    { type: 'assistant', uuid: 'count-assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'count this reply' }] } },
    { type: 'assistant', uuid: 'count-child', parent_tool_use_id: 'tool', message: { role: 'assistant', content: [{ type: 'text', text: 'exclude child' }] } },
    { type: 'system', uuid: 'count-hidden', subtype: 'thinking_tokens', parent_tool_use_id: null },
    { type: 'result', uuid: 'count-result', subtype: 'success', parent_tool_use_id: null, result: 'done' },
  ]) await app.db.saveSDKMessage('count-history', message as SDKMessage);
  await app.db.saveSDKMessage('other-history', { type: 'assistant', uuid: 'count-other', message: { role: 'assistant', content: [{ type: 'text', text: 'other session' }] } } as SDKMessage);
  const raw = app.db.getDatabase();
  evidence.expectedCount = app.db.getSDKMessageCount('count-history');
  assert.equal(evidence.expectedCount, 3);
  const copyDone = raw.prepare('SELECT 1 FROM migration_markers WHERE key IN (?,?)');
  const deadline = performance.now() + 30_000;
  while (!copyDone.get('sdk_message_bodies_copy_v1:complete', 'sdk_message_bodies_copy_v1:reversed')) {
    assert(performance.now() < deadline, 'SDK body copy did not settle');
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(app.db.getDataMigrationStatus().state, 'complete');
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const read = (sessionId = 'count-history') => hub.request<{ count: number }>('message.count', { sessionId });
  assert.equal(app.sessionManager.getCachedSessions().length, 0);
  raw.exec('CREATE TABLE synthetic_count_writer(value INTEGER); INSERT INTO synthetic_count_writer VALUES(0)');
  writer = new SQLite(app.db.getDbPath());
  writer.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  writer.prepare('UPDATE synthetic_count_writer SET value=value+1').run();
  const counters = () => ({ outside: (raw.prepare('SELECT value FROM synthetic_count_writer').get() as { value: number }).value, inside: (writer!.prepare('SELECT value FROM synthetic_count_writer').get() as { value: number }).value });
  evidence.writerBefore = counters();
  assert.deepEqual(evidence.writerBefore, { outside: 0, inside: 1 });
  let previous = performance.now();
  let maxLoopLagMs = 0;
  timer = setInterval(() => { const now = performance.now(); maxLoopLagMs = Math.max(maxLoopLagMs, now - previous - 5); previous = now; }, 5);
  measuring = true;
  try {
    const coldAt = performance.now();
    try { assert.deepEqual(await read(), { count: 3 }); evidence.coldMs = performance.now() - coldAt; }
    catch (error) { evidence.coldError = String(error); throw error; }
    const warmAt = performance.now();
    const replies = await Promise.all(Array.from({ length: 10 }, () => read()));
    replies.forEach((reply) => assert.deepEqual(reply, { count: 3 }));
    evidence.concurrentWarmMs = performance.now() - warmAt;
    assert.deepEqual(await read('empty-history'), { count: 0 });
    assert.deepEqual(await read('other-history'), { count: 1 });
    assert.deepEqual(await read('conv:missing-history'), { count: 0 });
    evidence.missingSession = await read('missing-history').then(() => 'unexpected success', String);
    assert.match(String(evidence.missingSession), /Session not found/);
    const healthAt = performance.now();
    assert.equal((await hub.request<{ status: string }>('system.health', {})).status, 'ok');
    evidence.healthMs = performance.now() - healthAt;
    evidence.writerAfter = counters();
    assert.deepEqual(evidence.writerAfter, { outside: 0, inside: 1 });
  } finally { writer.exec('ROLLBACK'); writer.close(); writer = undefined; }
  await app.db.saveSDKMessage('count-history', { type: 'assistant', uuid: 'count-later', message: { role: 'assistant', content: [{ type: 'text', text: 'later committed reply' }] } } as SDKMessage);
  assert.deepEqual(await read(), { count: 4 });
  evidence.laterCommitObserved = true;
  rejectNextRead = true;
  evidence.workerFailure = await read().then(() => 'unexpected success', String);
  assert.match(String(evidence.workerFailure), /synthetic message-count reader failure/);
  assert.equal((await hub.request<{ status: string }>('system.health', {})).status, 'ok');
  assert.deepEqual(await read(), { count: 4 });
  evidence.readerRecovered = true;
  assert.equal(app.sessionManager.getCachedSessions().length, 0);
  evidence.actorCacheStayedEmpty = true;
  await new Promise((done) => setTimeout(done, 10));
  evidence.maxLoopLagMs = maxLoopLagMs;
  assert(maxLoopLagMs < 1000);
  evidence.rpcLatencyUnder250ms = [evidence.coldMs, evidence.concurrentWarmMs, evidence.healthMs].every((ms) => Number(ms) < 250);
  assert.equal(evidence.rpcLatencyUnder250ms, true);
  evidence.rssBytes = process.memoryUsage().rss;
  evidence.walBytes = statSync(`${app.db.getDbPath()}-wal`).size;
  assert.equal(mainSqlAttempts, 0);
} finally {
  measuring = false;
  if (timer) clearInterval(timer);
  writer?.close();
  await transport?.close();
  await Promise.all([...processors].map((processor) => processor.stop()));
  await app?.cleanup();
  SQLite.prototype.prepare = prepare;
  JobQueueProcessor.prototype.start = start;
  globalThis.Worker = NativeWorker;
  globalThis.fetch = nativeFetch;
  evidence.mainSqlAttempts = mainSqlAttempts;
  evidence.workerTimings = workerTimings;
  writeFileSync(join(run, 'evidence/message-count-reader.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok real count RPC preserves filtering and errors with zero main SQL or actor restoration');
