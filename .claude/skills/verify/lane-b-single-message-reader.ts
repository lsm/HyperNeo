import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';

const run = resolve(process.argv.at(-1)!);
const deferBodyCopy = process.argv.includes('--defer-body-copy');
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data')));
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.equal(process.env[key], undefined);
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { JobQueueProcessor } = await import('../../../packages/daemon/src/storage/job-queue-processor.ts');
const { Database: SQLite } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
const { DatabaseCore } = await import('../../../packages/daemon/src/storage/database-core.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { capSdkMessage } = await import('../../../packages/daemon/src/lib/rpc-handlers/message-output-cap.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const NativeWorker = globalThis.Worker; const fetch = globalThis.fetch;
const start = JobQueueProcessor.prototype.start; const prepare = SQLite.prototype.prepare;
const startBodyCopy = DatabaseCore.prototype.startSdkMessageBodyCopy;
let releaseBodyCopy: (() => void) | undefined;
if (deferBodyCopy) DatabaseCore.prototype.startSdkMessageBodyCopy = function () {
  releaseBodyCopy = () => startBodyCopy.call(this);
};
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
let measuring = false; let mainSqlAttempts = 0; let rejectNextRead = false;
const workerTimings: { roundTripMs: number; replyBytes: number; encodeMs: number }[] = [];
SQLite.prototype.prepare = function (...args) {
  const statement = Reflect.apply(prepare, this, args);
  if (!/\b(?:sessions|session_counters|sdk_messages|sdk_message_bodies)\b/i.test(args[0])) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key); if (typeof value !== 'function') return value;
    return (...values: unknown[]) => {
      if (measuring && ['get', 'all', 'iterate', 'run', 'values'].includes(String(key))) { mainSqlAttempts++; throw new Error('single-message session or body SQL reached main'); }
      return Reflect.apply(value, target, values);
    };
  } });
};
globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
  const worker = new NativeWorker(url, options);
  if (String(url).endsWith('/db-gateway-worker.ts')) {
    const post = worker.postMessage.bind(worker); const sent = new Map<number, number>();
    worker.postMessage = ((message: { id: number; op?: string; lane?: string }) => {
      if (message.op === 'sdk.message.single.read') {
        assert.equal(message.lane, 'read');
        if (rejectNextRead) {
          rejectNextRead = false;
          queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic single-message reader failure', cancelable: true })));
          return;
        }
        sent.set(message.id, performance.now());
      }
      post(message);
    }) as typeof worker.postMessage;
    worker.addEventListener('message', ({ data }) => {
      const at = sent.get(data.id); if (at === undefined) return; sent.delete(data.id);
      if (data.error) return;
      const encodeAt = performance.now(); const encoded = JSON.stringify(data.result);
      workerTimings.push({ roundTripMs: encodeAt - at, replyBytes: Buffer.byteLength(encoded), encodeMs: performance.now() - encodeAt });
    });
  }
  return worker;
} as unknown as typeof Worker;
globalThis.fetch = (() => { throw new Error('External HTTP refused by single-message fixture'); }) as typeof fetch;
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
  for (const id of ['single-history', 'other-history']) {
    const session: Session = { id, title: 'Synthetic full message', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active',
      config: { queryMode: 'manual', model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0 },
      metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0, titleGenerated: true, titleSetBy: 'user' } };
    await app.db.createSession(session);
  }
  const text = 'Complete ordinary output 🦊\n'.repeat(8192);
  const message = { type: 'user', uuid: 'single-full-output', parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'single-tool', content: text }] }, tool_use_result: { stdout: text } } as unknown as SDKMessage;
  await app.db.saveSDKMessage('single-history', message);
  const expected = app.db.getSDKMessageRepo().getMessageByUuid('single-history', 'single-full-output'); assert(expected);
  const raw = app.db.getDatabase();
  const hash = () => createHash('sha256').update(JSON.stringify(raw.prepare('SELECT seq,sdk_message FROM sdk_message_bodies ORDER BY seq').all())).digest('hex');
  evidence.storedBodyHashBefore = hash();
  raw.exec('CREATE TABLE synthetic_single_writer(value INTEGER); INSERT INTO synthetic_single_writer VALUES(0)');
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false }); hub.registerTransport(transport); await transport.initialize();
  const read = (extra: Record<string, unknown> = {}) => hub.request<{ sdkMessage: SDKMessage }>('message.sdkMessage', { sessionId: 'single-history', messageUuid: 'single-full-output', ...extra });
  releaseBodyCopy?.(); evidence.startupCopyDeferred = Boolean(releaseBodyCopy);
  const copyDone = raw.prepare('SELECT 1 FROM migration_markers WHERE key IN (?,?)');
  const copyDeadline = performance.now() + 30_000;
  while (!copyDone.get('sdk_message_bodies_copy_v1:complete', 'sdk_message_bodies_copy_v1:reversed')) {
    assert(performance.now() < copyDeadline, 'Startup SDK body copy did not settle before reader measurement');
    await new Promise((done) => setTimeout(done, 10));
  }
  evidence.startupBodyCopyComplete = true;
  writer = new SQLite(app.db.getDbPath()); writer.exec('PRAGMA busy_timeout=5000'); writer.exec('BEGIN IMMEDIATE'); writer.prepare('UPDATE synthetic_single_writer SET value=value+1').run();
  const counters = () => ({ outside: (raw.prepare('SELECT value FROM synthetic_single_writer').get() as { value: number }).value, inside: (writer!.prepare('SELECT value FROM synthetic_single_writer').get() as { value: number }).value });
  evidence.writerBefore = counters(); assert.deepEqual(evidence.writerBefore, { outside: 0, inside: 1 });
  let previous = performance.now(); let maxLoopLagMs = 0;
  timer = setInterval(() => { const now = performance.now(); maxLoopLagMs = Math.max(maxLoopLagMs, now - previous - 5); previous = now; }, 5);
  measuring = true;
  try {
    if (deferBodyCopy) await new Promise((done) => setTimeout(done, 10));
    const coldAt = performance.now();
    try { const cold = await read(); evidence.coldMs = performance.now() - coldAt; assert.deepEqual(cold, { sdkMessage: expected }); }
    catch (error) { evidence.coldError = String(error); throw error; }
    const warmAt = performance.now(); const replies = await Promise.all(Array.from({ length: 10 }, (_, i) => read({ capped: i % 2 === 0 }))); evidence.concurrentWarmMs = performance.now() - warmAt;
    replies.forEach((reply, i) => assert.deepEqual(reply, { sdkMessage: i % 2 === 0 ? capSdkMessage(expected) : expected }));
    const block = (replies[0].sdkMessage as unknown as { message: { content: { content: string }[] } }).message.content[0];
    assert.equal(block.content, text.slice(0, 16 * 1024)); evidence.cappedReplyMatched = true;
    const complete = replies[1].sdkMessage as unknown as { message: { content: { content: string }[] }; tool_use_result: { stdout: string } };
    assert.equal(complete.message.content[0].content, text); assert.equal(complete.tool_use_result.stdout, text); evidence.fullOutputMatched = true;
    evidence.fullReplyHash = createHash('sha256').update(JSON.stringify(replies[1])).digest('hex');
    for (const [name, params, pattern] of [
      ['missingSession', { sessionId: 'missing-history' }, /Session not found/],
      ['conversationMissing', { sessionId: 'conv:missing-history' }, /Session not found/],
      ['missingMessage', { messageUuid: 'missing-output' }, /Message not found/],
      ['otherSession', { sessionId: 'other-history' }, /Message not found/],
      ['invalidInput', { messageUuid: '' }, /sessionId and messageUuid are required/],
    ] as const) { evidence[name] = await read(params).then(() => 'unexpected success', String); assert.match(String(evidence[name]), pattern); }
    const healthAt = performance.now(); assert.equal((await hub.request<{ status: string }>('system.health', {})).status, 'ok'); evidence.healthMs = performance.now() - healthAt;
    evidence.writerAfter = counters(); assert.deepEqual(evidence.writerAfter, { outside: 0, inside: 1 });
  } finally { writer.exec('ROLLBACK'); writer.close(); writer = undefined; }
  await app.db.saveSDKMessage('single-history', { type: 'assistant', uuid: 'single-later', message: { role: 'assistant', content: [{ type: 'text', text: 'later committed output' }] } } as SDKMessage);
  const later = await read({ messageUuid: 'single-later' }); assert.equal(later.sdkMessage.uuid, 'single-later'); evidence.laterCommittedMessageObserved = true;
  rejectNextRead = true; evidence.workerFailure = await read().then(() => 'unexpected success', String); assert.match(String(evidence.workerFailure), /synthetic single-message reader failure/);
  assert.equal((await hub.request<{ status: string }>('system.health', {})).status, 'ok'); assert.deepEqual(await read(), { sdkMessage: expected }); evidence.readerRecovered = true;
  assert.equal(app.sessionManager.getCachedSessions().length, 0); evidence.actorCacheStayedEmpty = true;
  await new Promise((resolve) => setTimeout(resolve, 10)); evidence.maxLoopLagMs = maxLoopLagMs; assert(maxLoopLagMs < 1000);
  evidence.rpcLatencyUnder250ms = [evidence.coldMs, evidence.concurrentWarmMs, evidence.healthMs].every((ms) => Number(ms) < 250); assert.equal(evidence.rpcLatencyUnder250ms, true);
  measuring = false; const stored = app.db.getSDKMessageRepo().getMessageByUuid('single-history', 'single-full-output'); assert.deepEqual(stored, expected);
  evidence.originalBodyHashAfter = createHash('sha256').update(JSON.stringify(stored)).digest('hex');
  evidence.originalBodyHashBefore = createHash('sha256').update(JSON.stringify(expected)).digest('hex'); assert.equal(evidence.originalBodyHashAfter, evidence.originalBodyHashBefore);
  evidence.rssBytes = process.memoryUsage().rss; evidence.walBytes = statSync(`${app.db.getDbPath()}-wal`).size; assert.equal(mainSqlAttempts, 0);
} finally {
  measuring = false; if (timer) clearInterval(timer); writer?.close(); JobQueueProcessor.prototype.start = start;
  DatabaseCore.prototype.startSdkMessageBodyCopy = startBodyCopy;
  await transport?.close(); await Promise.all([...processors].map((processor) => processor.stop())); await app?.cleanup();
  SQLite.prototype.prepare = prepare; globalThis.Worker = NativeWorker; globalThis.fetch = fetch;
  evidence.mainSqlAttempts = mainSqlAttempts; evidence.workerTimings = workerTimings;
  writeFileSync(join(run, 'evidence/single-message-reader.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok full and capped single-message RPC bodies come from one read snapshot with no target SQL on main');
