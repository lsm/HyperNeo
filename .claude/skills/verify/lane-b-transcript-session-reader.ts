import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SDKMessage } from '@hyperneo/shared/sdk';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.equal(process.env[key], undefined);
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { JobQueueProcessor } = await import('../../../packages/daemon/src/storage/job-queue-processor.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const NativeWorker = globalThis.Worker;
const fetch = globalThis.fetch;
const start = JobQueueProcessor.prototype.start;
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
let rejectNextPage = false;
let pageRequests = 0;
globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
  const worker = new NativeWorker(url, options);
  if (String(url).endsWith('/sdk-status-worker.ts')) {
    const post = worker.postMessage.bind(worker);
    worker.postMessage = ((message: { args?: { page?: unknown } }) => {
      if (message.args?.page) {
        pageRequests++;
        if (rejectNextPage) {
          rejectNextPage = false;
          queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic transcript worker failure', cancelable: true })));
          return;
        }
      }
      post(message);
    }) as typeof worker.postMessage;
  }
  return worker;
} as unknown as typeof Worker;
globalThis.fetch = (() => { throw new Error('External HTTP refused by transcript fixture'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
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
  const sessionId = 'synthetic-cold-history';
  await app.db.createSession({
    id: sessionId, title: 'Synthetic history', workspacePath: join(run, 'workspace'),
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active',
    config: { queryMode: 'manual', model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0 },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0, titleGenerated: true, titleSetBy: 'user' },
  });
  const text = 'Complete ordinary history 🦊\n'.repeat(1000);
  for (let n = 0; n < 4; n++) await app.db.saveSDKMessage(sessionId, {
    type: 'user', uuid: `history-${n}`, parent_tool_use_id: null,
    message: { role: 'user', content: `${n}:${text}` },
  } as SDKMessage);
  await app.db.saveSDKMessage(sessionId, { type: 'assistant', uuid: 'history-parent', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'history-tool', name: 'Bash', input: {} }] } } as SDKMessage);
  await app.db.saveSDKMessage(sessionId, { type: 'user', uuid: 'history-child', parent_tool_use_id: 'history-tool', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'history-tool', content: 'child tool result' }] } } as SDKMessage);
  await app.db.saveSDKMessage(sessionId, { type: 'system', subtype: 'task_started', uuid: 'history-task', task_id: 'synthetic-task' } as SDKMessage);
  const raw = app.db.getDatabase();
  raw.prepare('UPDATE sdk_messages SET timestamp = ? WHERE session_id = ?').run('2026-10-26T00:00:00.000Z', sessionId);
  const reference = (page: { limit: number; before?: number; beforeRowid?: number; since?: number; sinceRowid?: number }) => app!.db.getSDKMessagePageAsync(sessionId, page);
  const latest = await reference({ limit: 3 });
  const first = latest.sdkMessages[0] as { timestamp: number; rowid: number };
  const queries = [
    { limit: 3 },
    { limit: 3, before: first.timestamp, beforeRowid: first.rowid },
    { limit: 3, since: first.timestamp, sinceRowid: first.rowid },
  ];
  const expected = await Promise.all(queries.map(reference));
  const bodyHash = () => {
    const hash = createHash('sha256');
    for (const row of raw.prepare('SELECT sdk_message FROM sdk_message_bodies ORDER BY seq').all() as { sdk_message: string }[]) hash.update(row.sdk_message);
    return hash.digest('hex');
  };
  const beforeHash = bodyHash();
  assert.equal(app.sessionManager.getCachedSession(sessionId), null);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (/\b(?:sessions|sdk_messages|sdk_message_bodies)\b/i.test(args[0])) {
      mainSqlAttempts++;
      throw new Error('transcript session or page SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  try {
    const started = performance.now();
    const cold = await hub.request('message.sdkMessages', { sessionId, ...queries[0] });
    evidence.coldMs = performance.now() - started;
    assert.deepEqual(cold, JSON.parse(JSON.stringify(expected[0])));
    const warmAt = performance.now();
    const replies = await Promise.all(queries.map((page) => hub.request('message.sdkMessages', { sessionId, ...page })));
    evidence.warmConcurrentMs = performance.now() - warmAt;
    assert.deepEqual(replies, JSON.parse(JSON.stringify(expected)));
    evidence.missingSession = await hub.request('message.sdkMessages', { sessionId: 'missing-history' }).then(() => 'unexpected success', String);
    assert.match(String(evidence.missingSession), /Session not found/);
    evidence.conversationFallback = await hub.request('message.sdkMessages', { sessionId: 'conv:missing-history' });
    assert.deepEqual(evidence.conversationFallback, { sdkMessages: [], hasMore: false, backgroundTaskMessages: [] });
    rejectNextPage = true;
    evidence.workerFailure = await hub.request('message.sdkMessages', { sessionId }).then(() => 'unexpected success', String);
    assert.match(String(evidence.workerFailure), /synthetic transcript worker failure/);
    evidence.healthAfterFailure = await hub.request('system.health', {});
    assert.equal((evidence.healthAfterFailure as { status: string }).status, 'ok');
    assert.deepEqual(await hub.request('message.sdkMessages', { sessionId, ...queries[0] }), JSON.parse(JSON.stringify(expected[0])));
    assert.equal(app.sessionManager.getCachedSession(sessionId), null);
    evidence.actorRemainedCold = true;
    evidence.pageWorkerRequests = pageRequests;
    evidence.replyHash = createHash('sha256').update(JSON.stringify(replies)).digest('hex');
    assert.equal(mainSqlAttempts, 0);
  } finally {
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
  evidence.bodyHashUnchanged = bodyHash() === beforeHash;
  assert.equal(evidence.bodyHashUnchanged, true);
} finally {
  JobQueueProcessor.prototype.start = start;
  await transport?.close();
  await Promise.all([...processors].map((processor) => processor.stop()));
  await app?.cleanup();
  globalThis.Worker = NativeWorker;
  globalThis.fetch = fetch;
  writeFileSync(join(run, 'evidence/transcript-session-reader.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok transcript RPC checks persisted session existence and reads pages off main without restoring an actor');
