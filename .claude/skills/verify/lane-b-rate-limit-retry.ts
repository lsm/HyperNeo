import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { Database } = await import('../../../packages/daemon/src/storage/index.ts');
const { createReactiveDatabase } = await import('../../../packages/daemon/src/storage/reactive-database.ts');
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const sessionId = 'synthetic-persisted-retry';
const messageId = 'synthetic-retry-episode';
const retryAt = Date.now() + 600000;
let seed: InstanceType<typeof Database> | undefined;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
const evidence: Record<string, unknown> = {};
try {
  seed = new Database(join(run, 'data/daemon.db'));
  await seed.initialize(createReactiveDatabase(seed));
  await seed.createSession({
    id: sessionId, title: 'Synthetic persisted retry', workspacePath: join(run, 'workspace'),
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active',
    config: { queryMode: 'manual', model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0 },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
    processingState: JSON.stringify({ status: 'rate_limit_cooldown', retryAt, retryCount: 0, maxRetries: 3, messageId, manualRetry: true }),
  });
  await seed.close();
  seed = undefined;
  app = await createDaemonApp({ config: {
    ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }),
    disableWorktrees: true, disableGoalProcessing: true,
  }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  const session = await app.sessionManager.getSessionForControl(sessionId);
  assert(session);
  assert.equal(session.getRateLimitWatchdogState().persistedCooldown, true);
  const owning = app.jobQueue.enqueue({ queue: 'message_delivery', payload: { sessionId, messageUuid: messageId, origin: 'chat' }, runAt: Date.now() - 100 });
  const [claim] = app.jobQueue.dequeue('message_delivery');
  assert.equal(claim.id, owning.id);
  assert(claim.claimToken);
  const next = app.jobQueue.enqueue({ queue: 'message_delivery', payload: { sessionId, messageUuid: 'synthetic-next', origin: 'chat' }, runAt: retryAt });
  const other = app.jobQueue.enqueue({ queue: 'message_delivery', payload: { sessionId: 'another-session', messageUuid: 'unrelated' }, runAt: retryAt });
  const raw = app.db.getDatabase();
  raw.prepare('UPDATE job_queue SET retry_count = 2 WHERE id = ?').run(owning.id);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (/UPDATE\s+job_queue/i.test(args[0])) {
      mainSqlAttempts++;
      throw new Error('manual retry SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  try {
    evidence.healthBefore = await hub.request('system.health', {});
    const started = performance.now();
    evidence.retry = await hub.request('session.retryNowAfterRateLimit', { sessionId });
    evidence.rpcMs = performance.now() - started;
    evidence.owningJob = app.jobQueue.getJob(owning.id);
    evidence.nextJob = app.jobQueue.getJob(next.id);
    evidence.otherJob = app.jobQueue.getJob(other.id);
    evidence.state = session.stateManager.getState().status;
    evidence.persistedState = app.db.getSession(sessionId)?.processingState;
    evidence.healthAfter = await hub.request('system.health', {});
    assert.equal(mainSqlAttempts, 0, 'manual retry must not write to the main SQLite connection');
    assert.deepEqual(evidence.retry, { success: true });
    assert.equal(evidence.state, 'idle');
    assert.equal(JSON.parse(String(evidence.persistedState)).status, 'idle');
    for (const id of [owning.id, next.id]) {
      const job = app.jobQueue.getJob(id);
      assert(job);
      assert.equal(job.status, 'pending');
      assert(job.runAt < retryAt);
      assert.equal(job.startedAt, null);
      assert.equal(job.heartbeatAt, null);
      assert.equal(job.claimToken, null);
    }
    assert.equal(app.jobQueue.getJob(owning.id)?.retryCount, 2);
    assert.equal(app.jobQueue.getJob(other.id)?.runAt, retryAt);
  } finally {
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
  evidence.oldHeartbeat = app.jobQueue.heartbeat(owning.id, claim.claimToken);
  assert.equal(evidence.oldHeartbeat, false);
} finally {
  await transport?.close();
  await app?.cleanup();
  await seed?.close();
  writeFileSync(join(run, 'evidence/rate-limit-retry.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok persisted retry RPC releases all session deliveries on the writer with stale claims fenced');
