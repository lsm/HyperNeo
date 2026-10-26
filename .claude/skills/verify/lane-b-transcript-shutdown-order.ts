import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session } from '@hyperneo/shared';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data')));
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.equal(process.env[key], undefined);
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { JobQueueProcessor } = await import('../../../packages/daemon/src/storage/job-queue-processor.ts');
const { Database: SQLite } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
const { deriveSdkMessageColumns, SDK_MESSAGE_COLUMN_TYPES } = await import('../../../packages/daemon/src/storage/sdk-message-columns.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const NativeWorker = globalThis.Worker; const fetch = globalThis.fetch;
const start = JobQueueProcessor.prototype.start; const prepare = SQLite.prototype.prepare;
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
let measuring = false; let mainSqlAttempts = 0; let rejectNextPage = false;
const workerTimings: { workerMs: number; queueMs: number; replyBytes: number; encodeMs: number; deliveryMs: number }[] = [];
SQLite.prototype.prepare = function (...args) {
  const statement = Reflect.apply(prepare, this, args);
  if (!/\b(?:sessions|session_counters|sdk_messages|sdk_message_bodies)\b/i.test(args[0])) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key); if (typeof value !== 'function') return value;
    return (...values: unknown[]) => {
      if (measuring && ['get', 'all', 'iterate', 'run', 'values'].includes(String(key))) { mainSqlAttempts++; throw new Error('transcript SQL reached the main connection'); }
      return Reflect.apply(value, target, values);
    };
  } });
};
globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
  const worker = new NativeWorker(url, options);
  if (String(url).endsWith('/sdk-status-worker.ts')) {
    const post = worker.postMessage.bind(worker);
    worker.postMessage = ((message: { args?: { page?: unknown } }) => {
      if (message.args?.page && rejectNextPage) {
        rejectNextPage = false;
        queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic shutdown page worker failure', cancelable: true })));
        return;
      }
      post(message);
    }) as typeof worker.postMessage;
    worker.addEventListener('message', ({ data }) => {
      if (!measuring || !data.result?.sdkMessages) return;
      const at = performance.now(); const encoded = JSON.stringify(data.result);
      workerTimings.push({ workerMs: data.workerMs, queueMs: data.queueMs, replyBytes: Buffer.byteLength(encoded), encodeMs: performance.now() - at, deliveryMs: Math.max(0, Date.now() - data.finishedAt) });
    });
  }
  return worker;
} as unknown as typeof Worker;
globalThis.fetch = (() => { throw new Error('External HTTP refused by shutdown-order fixture'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
let writer: InstanceType<typeof SQLite> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const evidence: Record<string, unknown> = {};
const timestamp = '2026-10-26T00:00:00.000Z';
type Row = { uuid: string; rowid: number; timestamp: number };
type Page = { sdkMessages: Row[]; hasMore: boolean; backgroundTaskMessages: Row[] };
const checks: { name: string; expected: string[]; actual: string[]; passed: boolean }[] = [];
const check = (name: string, page: Page, expected: string[]) => {
  const actual = page.sdkMessages.map((message) => message.uuid);
  checks.push({ name, actual, expected, passed: JSON.stringify(actual) === JSON.stringify(expected) });
};
try {
  JobQueueProcessor.prototype.start = function () { processors.add(this); return start.call(this); };
  try {
    app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  } finally { JobQueueProcessor.prototype.start = start; }
  assert.notEqual(app.server.port, 8399); await Promise.all([...processors].map((processor) => processor.stop()));
  for (const id of ['stale', 'tail', 'double', 'queued', 'consumed', 'failed', 'nested', 'other']) {
    const session: Session = { id, title: 'Synthetic shutdown order', workspacePath: join(run, 'workspace'), createdAt: timestamp, lastActiveAt: timestamp, status: 'active',
      config: { queryMode: 'manual', model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0 },
      metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0, titleGenerated: true, titleSetBy: 'user' } };
    await app.db.createSession(session);
  }
  const raw = app.db.getDatabase();
  const names = Object.keys(SDK_MESSAGE_COLUMN_TYPES) as (keyof typeof SDK_MESSAGE_COLUMN_TYPES)[];
  const fullText = 'Ordinary complete transcript 🦊\n'.repeat(1000);
  const seed = (sessionId: string, id: string, type: string, options: { at?: string; status?: string; parent?: string } = {}) => {
    const message = { type, uuid: `${sessionId}-${id}`, session_id: sessionId, parent_tool_use_id: options.parent ?? null,
      ...(type === 'system' ? { subtype: 'worker_shutting_down', reason: 'host_exit' } : { message: { role: type, content: [{ type: 'text', text: fullText }] } }) };
    const derived = deriveSdkMessageColumns(message, null);
    raw.prepare(`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, parent_tool_use_id, sdk_uuid, replacement_metadata_normalized, ${names.join(',')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ${names.map(() => '?').join(',')})`).run(`${sessionId}-${id}`, sessionId, type, type === 'system' ? 'worker_shutting_down' : null, JSON.stringify(message), options.at ?? timestamp, options.status ?? 'consumed', options.parent ?? null, message.uuid, ...names.map((key) => derived[key]));
  };
  seed('stale', 'older', 'assistant', { at: '2026-10-25T23:59:59.000Z' }); seed('stale', 'z-shutdown', 'system'); seed('stale', 'a-newer', 'assistant');
  seed('tail', 'z-older', 'assistant'); seed('tail', 'a-shutdown', 'system');
  seed('double', 'z-shutdown', 'system'); seed('double', 'a-shutdown', 'system');
  for (const id of ['queued', 'consumed', 'failed']) { seed(id, 'z-shutdown', 'system'); seed(id, 'a-user', 'user', { status: id === 'queued' ? 'enqueued' : id }); }
  seed('nested', 'a-shutdown', 'system'); seed('nested', 'z-child', 'assistant', { parent: 'nested-tool' }); seed('other', 'z-later', 'assistant');
  raw.prepare('INSERT INTO sdk_message_bodies (seq, sdk_message) SELECT rowid, sdk_message FROM sdk_messages').run();
  raw.prepare("UPDATE sdk_messages SET sdk_message='' WHERE session_id IN ('stale','tail','double','queued','consumed','failed','nested','other')").run();
  const newerRowid = (raw.prepare('SELECT rowid AS rowid FROM sdk_messages WHERE sdk_uuid=?').get('stale-a-newer') as { rowid: number }).rowid;
  assert(Number.isInteger(newerRowid) && newerRowid > 0);
  const bodies = () => createHash('sha256').update(JSON.stringify(raw.prepare('SELECT seq,sdk_message FROM sdk_message_bodies ORDER BY seq').all())).digest('hex');
  const beforeHash = bodies(); evidence.storedBodyHashBefore = beforeHash;
  raw.exec('CREATE TABLE synthetic_shutdown_writer(value INTEGER); INSERT INTO synthetic_shutdown_writer VALUES(0)');
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false }); hub.registerTransport(transport); await transport.initialize();
  const page = (sessionId: string, extra: Record<string, number> = {}) => hub.request<Page>('message.sdkMessages', { sessionId, limit: 2, ...extra });
  writer = new SQLite(app.db.getDbPath()); writer.exec('PRAGMA busy_timeout=5000'); writer.exec('BEGIN IMMEDIATE'); writer.prepare('UPDATE synthetic_shutdown_writer SET value=value+1').run();
  const counters = () => ({ outside: (raw.prepare('SELECT value FROM synthetic_shutdown_writer').get() as { value: number }).value, inside: (writer!.prepare('SELECT value FROM synthetic_shutdown_writer').get() as { value: number }).value });
  evidence.writerBefore = counters(); assert.deepEqual(evidence.writerBefore, { outside: 0, inside: 1 });
  let previous = performance.now(); let maxLoopLagMs = 0;
  timer = setInterval(() => { const now = performance.now(); maxLoopLagMs = Math.max(maxLoopLagMs, now - previous - 5); previous = now; }, 5);
  measuring = true;
  try {
    const coldAt = performance.now(); const cold = await page('stale'); evidence.coldMs = performance.now() - coldAt;
    check('cold stale shutdown excluded before limit', cold, ['stale-older', 'stale-a-newer']);
    const warmAt = performance.now(); const replies = await Promise.all(Array.from({ length: 10 }, () => page('stale'))); evidence.concurrentWarmMs = performance.now() - warmAt;
    for (const [i, value] of replies.entries()) check(`warm stale page ${i}`, value, ['stale-older', 'stale-a-newer']);
    evidence.replyHash = createHash('sha256').update(JSON.stringify(cold)).digest('hex');
    const visibleBody = cold.sdkMessages.find((message) => message.uuid === 'stale-a-newer') as unknown as { message: { content: { text: string }[] } };
    assert.equal(visibleBody.message.content[0].text, fullText); evidence.completeBodyMatched = true;
    check('actual shutdown tail retained', await page('tail'), ['tail-z-older', 'tail-a-shutdown']);
    check('only last tied shutdown retained', await page('double'), ['double-a-shutdown']);
    check('queued user cannot supersede shutdown', await page('queued'), ['queued-z-shutdown']);
    check('consumed tied user supersedes shutdown', await page('consumed'), ['consumed-a-user']);
    check('failed tied user supersedes shutdown', await page('failed'), ['failed-a-user']);
    check('child and other session cannot supersede tail', await page('nested'), ['nested-a-shutdown']);
    const before = await page('stale', { before: Date.parse(timestamp), beforeRowid: newerRowid });
    check('before rowid cursor', before, ['stale-older']); evidence.beforeHasMore = before.hasMore;
    check('since rowid cursor', await page('stale', { since: Date.parse(timestamp), sinceRowid: newerRowid - 1 }), ['stale-a-newer']);
    const healthAt = performance.now(); const health = await hub.request<{ status: string }>('system.health', {}); evidence.healthMs = performance.now() - healthAt; assert.equal(health.status, 'ok');
    evidence.writerAfter = counters(); assert.deepEqual(evidence.writerAfter, { outside: 0, inside: 1 });
  } finally { writer.exec('ROLLBACK'); writer.close(); writer = undefined; }
  rejectNextPage = true; evidence.workerFailure = await page('stale').then(() => 'unexpected success', String); assert.match(String(evidence.workerFailure), /synthetic shutdown page worker failure/);
  assert.equal((await hub.request<{ status: string }>('system.health', {})).status, 'ok');
  check('reader recovers without main fallback', await page('stale'), ['stale-older', 'stale-a-newer']);
  assert.equal(app.sessionManager.getCachedSessions().length, 0); evidence.actorCacheStayedEmpty = true;
  await new Promise((resolve) => setTimeout(resolve, 10)); evidence.maxLoopLagMs = maxLoopLagMs; assert(maxLoopLagMs < 1000);
  evidence.rpcLatencyUnder250ms = [evidence.coldMs, evidence.concurrentWarmMs, evidence.healthMs].every((ms) => Number(ms) < 250); assert.equal(evidence.rpcLatencyUnder250ms, true);
  measuring = false; evidence.storedBodyHashAfter = bodies(); assert.equal(evidence.storedBodyHashAfter, beforeHash);
  evidence.rssBytes = process.memoryUsage().rss; evidence.walBytes = statSync(`${app.db.getDbPath()}-wal`).size;
  assert.equal(mainSqlAttempts, 0); assert(checks.every((entry) => entry.passed), JSON.stringify(checks.filter((entry) => !entry.passed))); assert.equal(evidence.beforeHasMore, false);
} finally {
  measuring = false; if (timer) clearInterval(timer); writer?.close(); JobQueueProcessor.prototype.start = start;
  await transport?.close(); await Promise.all([...processors].map((processor) => processor.stop())); await app?.cleanup();
  SQLite.prototype.prepare = prepare; globalThis.Worker = NativeWorker; globalThis.fetch = fetch;
  evidence.mainSqlAttempts = mainSqlAttempts; evidence.checks = checks; evidence.workerTimings = workerTimings;
  writeFileSync(join(run, 'evidence/transcript-shutdown-order.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok history shutdown visibility follows timestamp/rowid order through the off-main RPC');
