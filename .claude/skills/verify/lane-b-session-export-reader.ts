import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
        throw new Error('session-export session or message SQL reached main');
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
      if (message.op === 'session.export.read') {
        assert.equal(message.lane, 'read');
        if (rejectNextRead) {
          rejectNextRead = false;
          queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic session-export reader failure', cancelable: true })));
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
globalThis.fetch = (() => { throw new Error('External HTTP refused by session-export fixture'); }) as typeof fetch;
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
  for (const id of ['export-history', 'other-history', 'empty-history']) {
    const session: Session = { id, title: 'Synthetic session export', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active',
      config: { queryMode: 'manual', model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0 },
      metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0, titleGenerated: true, titleSetBy: 'user' } };
    await app.db.createSession(session);
  }
  const text = 'Full export output 🦊\n'.repeat(2000);
  for (const status of ['consumed', 'enqueued', 'failed'] as const) await app.db.saveUserMessage('export-history', { type: 'user', uuid: `export-${status}`, parent_tool_use_id: null, message: { role: 'user', content: status } }, status);
  for (const message of [
    { type: 'assistant', uuid: 'export-assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', id: 'export-tool', name: 'Task', input: { prompt: 'synthetic child' } }] } },
    { type: 'assistant', uuid: 'export-child', parent_tool_use_id: 'export-tool', message: { role: 'assistant', content: [{ type: 'text', text: 'child reply' }] } },
    { type: 'system', uuid: 'export-hidden', subtype: 'thinking_tokens', parent_tool_use_id: null },
    { type: 'result', uuid: 'export-result', subtype: 'success', parent_tool_use_id: null, result: 'done' },
  ]) await app.db.saveSDKMessage('export-history', message as SDKMessage);
  await app.db.saveSDKMessage('other-history', { type: 'assistant', uuid: 'export-other', message: { role: 'assistant', content: [{ type: 'text', text: 'other session' }] } } as SDKMessage);
  const raw = app.db.getDatabase();
  const expected = { session: app.db.getSession('export-history'), messages: app.db.getSDKMessages('export-history', 10000).messages };
  assert(expected.session);
  const wireExpected = JSON.parse(JSON.stringify(expected)) as typeof expected;
  const serialized = JSON.stringify(expected.messages);
  assert(serialized.includes('export-consumed') && serialized.includes('export-failed') && serialized.includes('export-child'));
  assert(!serialized.includes('export-enqueued') && !serialized.includes('export-hidden'));
  evidence.expectedMessageCount = expected.messages.length;
  evidence.originalBodyHashBefore = createHash('sha256').update(serialized).digest('hex');
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
  const read = (sessionId = 'export-history') => hub.request<typeof expected>('session.export', { sessionId, format: 'json' });
  const markdown = (format?: string) => hub.request<{ markdown: string }>('session.export', { sessionId: 'export-history', ...(format ? { format } : {}) });
  assert.equal(app.sessionManager.getCachedSessions().length, 0);
  raw.exec('CREATE TABLE synthetic_export_writer(value INTEGER); INSERT INTO synthetic_export_writer VALUES(0)');
  writer = new SQLite(app.db.getDbPath());
  writer.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  writer.prepare('UPDATE synthetic_export_writer SET value=value+1').run();
  const counters = () => ({ outside: (raw.prepare('SELECT value FROM synthetic_export_writer').get() as { value: number }).value, inside: (writer!.prepare('SELECT value FROM synthetic_export_writer').get() as { value: number }).value });
  evidence.writerBefore = counters();
  assert.deepEqual(evidence.writerBefore, { outside: 0, inside: 1 });
  let previous = performance.now();
  let maxLoopLagMs = 0;
  timer = setInterval(() => { const now = performance.now(); maxLoopLagMs = Math.max(maxLoopLagMs, now - previous - 5); previous = now; }, 5);
  measuring = true;
  try {
    const coldAt = performance.now();
    try { assert.deepEqual(await read(), wireExpected); evidence.coldMs = performance.now() - coldAt; }
    catch (error) { evidence.coldError = String(error); throw error; }
    const warmAt = performance.now();
    const replies = await Promise.all(Array.from({ length: 10 }, () => read()));
    replies.forEach((reply) => assert.deepEqual(reply, wireExpected));
    evidence.concurrentWarmMs = performance.now() - warmAt;
    assert.equal((await read('empty-history')).messages.length, 0);
    assert.equal((await read('other-history')).messages.length, 1);
    const ordinary = await markdown();
    assert.deepEqual(await markdown('markdown'), ordinary);
    assert(ordinary.markdown.includes(text));
    assert(ordinary.markdown.includes('# Synthetic session export'));
    assert(ordinary.markdown.includes('## Result'));
    evidence.fullMarkdownMatched = true;
    evidence.markdownHash = createHash('sha256').update(ordinary.markdown).digest('hex');
    evidence.missingConversation = await read('conv:missing-history').then(() => 'unexpected success', String);
    assert.match(String(evidence.missingConversation), /Session not found/);
    evidence.missingSession = await read('missing-history').then(() => 'unexpected success', String);
    assert.match(String(evidence.missingSession), /Session not found/);
    const healthAt = performance.now();
    assert.equal((await hub.request<{ status: string }>('system.health', {})).status, 'ok');
    evidence.healthMs = performance.now() - healthAt;
    evidence.writerAfter = counters();
    assert.deepEqual(evidence.writerAfter, { outside: 0, inside: 1 });
  } finally { writer.exec('ROLLBACK'); writer.close(); writer = undefined; }
  await app.db.saveSDKMessage('export-history', { type: 'assistant', uuid: 'export-later', message: { role: 'assistant', content: [{ type: 'text', text: 'later committed reply' }] } } as SDKMessage);
  assert((await read()).messages.some((row) => row.uuid === 'export-later'));
  evidence.laterCommitObserved = true;
  rejectNextRead = true;
  evidence.workerFailure = await read().then(() => 'unexpected success', String);
  assert.match(String(evidence.workerFailure), /synthetic session-export reader failure/);
  assert.equal((await hub.request<{ status: string }>('system.health', {})).status, 'ok');
  assert((await read()).messages.some((row) => row.uuid === 'export-later'));
  evidence.readerRecovered = true;
  assert.equal(app.sessionManager.getCachedSessions().length, 0);
  evidence.actorCacheStayedEmpty = true;
  await new Promise((done) => setTimeout(done, 10));
  evidence.maxLoopLagMs = maxLoopLagMs;
  assert(maxLoopLagMs < 1000);
  evidence.rpcLatencyUnder250ms = [evidence.coldMs, evidence.concurrentWarmMs, evidence.healthMs].every((ms) => Number(ms) < 250);
  assert.equal(evidence.rpcLatencyUnder250ms, true);
  measuring = false;
  const unchanged = app.db.getSDKMessages('export-history', 10000).messages.filter((row) => row.uuid !== 'export-later');
  evidence.originalBodyHashAfter = createHash('sha256').update(JSON.stringify(unchanged)).digest('hex');
  assert.equal(evidence.originalBodyHashAfter, evidence.originalBodyHashBefore);
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
  writeFileSync(join(run, 'evidence/session-export-reader.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok real JSON and Markdown export RPCs preserve full output with zero main SQL or actor restoration');
