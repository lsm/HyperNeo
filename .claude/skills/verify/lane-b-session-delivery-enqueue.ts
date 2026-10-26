import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { JobQueueProcessor } = await import('../../../packages/daemon/src/storage/job-queue-processor.ts');
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
const start = JobQueueProcessor.prototype.start;
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
  assert(processors.size >= 3);
  await Promise.all([...processors].map((processor) => processor.stop()));
  const sessionId = 'synthetic-delivery-session';
  const recoveryUuid = 'synthetic-orphaned-input';
  const chatUuid = 'synthetic-direct-chat';
  await app.db.createSession({
    id: sessionId, title: 'Synthetic delivery session', workspacePath: join(run, 'workspace'),
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active',
    config: { queryMode: 'manual', model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0 },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0, titleGenerated: true, titleSetBy: 'user' },
  });
  await app.db.saveUserMessage(sessionId, { type: 'user', uuid: recoveryUuid, message: { role: 'user', content: 'synthetic queued input' } }, 'enqueued');
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const raw = app.db.getDatabase();
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (/INSERT(?:\s+OR\s+\w+)?\s+INTO\s+job_queue\b/i.test(args[0])) {
      mainSqlAttempts++;
      throw new Error('session delivery enqueue SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  try {
    evidence.healthBefore = await hub.request('system.health', {});
    const loaded = await hub.request<{ session: { id: string } }>('session.get', { sessionId });
    assert.equal(loaded.session.id, sessionId);
    const deadline = Date.now() + 2000;
    while (mainSqlAttempts === 0 && app.jobQueue.activeDeliveryMessageUuids(sessionId).size === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    evidence.recoveryQueued = app.jobQueue.activeDeliveryMessageUuids(sessionId).has(recoveryUuid);
    await app.db.saveUserMessage(sessionId, { type: 'user', uuid: chatUuid, message: { role: 'user', content: 'synthetic direct chat' } }, 'enqueued');
    let publication: { delivered: number; failures: unknown[] };
    try {
      publication = await app.internalEventBus.publish('message.persisted', {
        sessionId, messageId: chatUuid, messageContent: 'synthetic direct chat',
        userMessageText: 'synthetic direct chat', needsWorkspaceInit: false,
        hasDraftToClear: false, sendStatus: 'enqueued', deliveryMode: 'immediate',
      });
    } catch (error) {
      publication = (error as { result?: typeof publication }).result ?? { delivered: 0, failures: [error] };
    }
    evidence.publication = { delivered: publication.delivered, failures: publication.failures.length };
    evidence.recoveryStatus = await hub.request('operation.invoke', { name: 'message.status', input: { sessionId, messageId: recoveryUuid } });
    evidence.chatStatus = await hub.request('operation.invoke', { name: 'message.status', input: { sessionId, messageId: chatUuid } });
    const jobs = raw.prepare("SELECT payload, max_retries, status FROM job_queue WHERE queue = 'message_delivery' AND json_extract(payload, '$.sessionId') = ? ORDER BY created_at, rowid").all(sessionId) as Array<{ payload: string; max_retries: number; status: string }>;
    evidence.jobs = jobs.map((job) => ({ ...job, payload: JSON.parse(job.payload) }));
    const rejectedUuid = 'synthetic-sql-reject';
    raw.exec(`CREATE TRIGGER reject_fixture_enqueue BEFORE INSERT ON job_queue
      WHEN json_extract(NEW.payload, '$.messageUuid') = '${rejectedUuid}'
      BEGIN SELECT RAISE(ABORT, 'synthetic enqueue rejection'); END`);
    await app.db.saveUserMessage(sessionId, { type: 'user', uuid: rejectedUuid, message: { role: 'user', content: 'synthetic rejected input' } }, 'enqueued');
    let rejectedFailures = 0;
    try {
      await app.internalEventBus.publish('message.persisted', {
        sessionId, messageId: rejectedUuid, messageContent: 'synthetic rejected input',
        userMessageText: 'synthetic rejected input', needsWorkspaceInit: false,
        hasDraftToClear: false, sendStatus: 'enqueued', deliveryMode: 'immediate',
      });
    } catch (error) {
      rejectedFailures = (error as { result?: { failures: unknown[] } }).result?.failures.length ?? -1;
    }
    evidence.rejectedFailures = rejectedFailures;
    evidence.rejectedStatus = await hub.request('operation.invoke', { name: 'message.status', input: { sessionId, messageId: rejectedUuid } });
    evidence.rejectedJobPresent = app.jobQueue.activeDeliveryMessageUuids(sessionId).has(rejectedUuid);
    evidence.healthAfter = await hub.request('system.health', {});
    assert.equal(mainSqlAttempts, 0, 'direct and recovery delivery enqueue must not write to main');
    assert.equal(evidence.recoveryQueued, true);
    assert.equal(publication.failures.length, 0);
    assert.deepEqual(evidence.recoveryStatus, { status: 'queued' });
    assert.deepEqual(evidence.chatStatus, { status: 'queued' });
    assert.equal(jobs.length, 2);
    assert.equal(rejectedFailures, 1);
    assert.deepEqual(evidence.rejectedStatus, { status: 'failed' });
    assert.equal(evidence.rejectedJobPresent, false);
    for (const [uuid, origin] of [[recoveryUuid, 'recovery'], [chatUuid, 'chat']]) {
      const job = jobs.find((row) => JSON.parse(row.payload).messageUuid === uuid);
      assert(job);
      assert.deepEqual(JSON.parse(job.payload), { sessionId, messageUuid: uuid, origin, parentToolUseId: null });
      assert.equal(job.max_retries, 8);
      assert.equal(job.status, 'pending');
    }
  } finally {
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
} finally {
  JobQueueProcessor.prototype.start = start;
  await transport?.close();
  await Promise.all([...processors].map((processor) => processor.stop()));
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/session-delivery-enqueue.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok session.get recovers orphaned input and persisted-chat delivery commits on the writer');
