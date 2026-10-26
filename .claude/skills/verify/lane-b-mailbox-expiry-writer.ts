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
const { createUlid } = await import('../../../packages/daemon/src/lib/mailbox/ulid.ts');
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
const start = JobQueueProcessor.prototype.start;
const register = JobQueueProcessor.prototype.register;
let expiryProcessor: InstanceType<typeof JobQueueProcessor> | undefined;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
const evidence: Record<string, unknown> = {};
try {
  JobQueueProcessor.prototype.start = function () { processors.add(this); return start.call(this); };
  JobQueueProcessor.prototype.register = function (...args) {
    if (args[0] === 'mailbox.expire') expiryProcessor = this;
    return Reflect.apply(register, this, args);
  };
  try {
    app = await createDaemonApp({ config: {
      ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }),
      disableWorktrees: true, disableGoalProcessing: true,
    }, verbose: false });
  } finally {
    JobQueueProcessor.prototype.start = start;
    JobQueueProcessor.prototype.register = register;
  }
  assert.notEqual(app.server.port, 8399);
  assert(expiryProcessor);
  await Promise.all([...processors].map((processor) => processor.stop()));
  const sessionId = 'synthetic-expiry-session';
  await app.db.createSession({
    id: sessionId, title: 'Synthetic mailbox expiry', workspacePath: join(run, 'workspace'),
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active',
    config: { queryMode: 'manual', model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0 },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0, titleGenerated: true, titleSetBy: 'user' },
  });
  const repo = app.jobQueue;
  const raw = app.db.getDatabase();
  const seed = (uuid: string, expired: boolean, queue = 'mailbox') => repo.enqueue({ queue, maxRetries: 4, payload: {
    id: createUlid(Date.now() - (expired ? 120_000 : 0)),
    to: { kind: 'session', sessionId }, origin: 'chat', messageUuid: uuid,
    message: { type: 'user', message: { role: 'user', content: uuid }, parent_tool_use_id: null },
    status: 'enqueued', deliveryMode: 'immediate', policy: { ttlMs: 60_000, maxAttempts: 5, priority: 0 },
  } });
  const expiredPending = seed('expired-pending', true);
  const [oldClaim] = repo.dequeue('mailbox', 1);
  const expiredSecond = seed('expired-second', true);
  const fresh = seed('fresh-entry', false);
  const foreign = seed('foreign-entry', true, 'synthetic-foreign');
  const corrupt = repo.enqueue({ queue: 'mailbox', payload: { invalid: true } });
  const completed = seed('completed-entry', true);
  raw.prepare("UPDATE job_queue SET status = 'completed' WHERE id = ?").run(completed.id);
  for (const uuid of ['expired-pending', 'expired-second', 'fresh-entry']) {
    await app.db.saveUserMessage(sessionId, { type: 'user', uuid, session_id: sessionId, parent_tool_use_id: null, inputKind: 'human', message: { role: 'user', content: uuid } }, 'enqueued');
  }
  const pending = repo.listJobs({ queue: 'mailbox.expire', status: 'pending', limit: 10 });
  assert.equal(pending.length, 1);
  raw.prepare('UPDATE job_queue SET run_at = 0 WHERE id = ?').run(pending[0].id);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (/\/(?:mailbox\/expire|job-handlers\/mailbox-expire\.handler|repositories\/mailbox-expiry-commands)\.ts/.test(new Error().stack ?? '')) {
      mainSqlAttempts++;
      throw new Error('mailbox expiry SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  try {
    evidence.healthBefore = await hub.request('system.health', {});
    evidence.claimed = await expiryProcessor.tick();
    const deadline = Date.now() + 2_000;
    while (repo.getJob(pending[0].id)?.status === 'processing' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const status = (uuid: string) => hub.request('operation.invoke', { name: 'message.status', input: { sessionId, messageId: uuid } });
    let statuses = await Promise.all(['expired-pending', 'expired-second'].map(status));
    while (mainSqlAttempts === 0 && statuses.some((value) => (value as { status?: string }).status !== 'failed') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      statuses = await Promise.all(['expired-pending', 'expired-second'].map(status));
    }
    evidence.publicStatuses = statuses;
    evidence.freshPublicStatus = await status('fresh-entry');
    evidence.sweep = repo.getJob(pending[0].id);
    evidence.expired = [expiredPending, expiredSecond].map((job) => repo.getJob(job.id));
    evidence.retained = [fresh, foreign, corrupt, completed].map((job) => repo.getJob(job.id)?.status);
    evidence.followups = repo.listJobs({ queue: 'mailbox.expire', status: 'pending', limit: 10 });
    evidence.oldLeaseHeartbeat = repo.heartbeat(oldClaim.id, oldClaim.claimToken);
    evidence.healthAfter = await hub.request('system.health', {});
    assert.equal(mainSqlAttempts, 0, 'real registered expiry job must not run SQL on main');
    assert.deepEqual(statuses, [{ status: 'failed', reason: 'mailbox: entry expired (ttl)' }, { status: 'failed', reason: 'mailbox: entry expired (ttl)' }]);
    assert.deepEqual(evidence.freshPublicStatus, { status: 'queued' });
    assert.deepEqual(evidence.retained, ['pending', 'pending', 'pending', 'completed']);
    assert.equal(evidence.oldLeaseHeartbeat, false);
    const sweep = repo.getJob(pending[0].id)!;
    assert.equal(sweep.status, 'completed');
    assert.equal(sweep.result?.expired, 2);
    const followups = repo.listJobs({ queue: 'mailbox.expire', status: 'pending', limit: 10 });
    assert.equal(followups.length, 1);
    assert.equal(followups[0].runAt, sweep.result?.nextRunAt);
    for (const job of [expiredPending, expiredSecond]) {
      const dead = repo.getJob(job.id)!;
      assert.equal(dead.status, 'dead');
      assert.equal(dead.error, 'mailbox: entry expired (ttl)');
      assert.equal(dead.retryCount, 0);
      assert.equal(dead.maxRetries, 4);
    }
  } finally {
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
} finally {
  JobQueueProcessor.prototype.start = start;
  JobQueueProcessor.prototype.register = register;
  await transport?.close();
  await Promise.all([...processors].map((processor) => processor.stop()));
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/mailbox-expiry-writer.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok registered expiry sweep commits failure statuses and its successor off main');
