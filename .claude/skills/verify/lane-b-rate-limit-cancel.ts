import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
const evidence: Record<string, unknown> = {};
try {
  app = await createDaemonApp({ config: {
    ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }),
    disableWorktrees: true, disableGoalProcessing: true,
  }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: join(run, 'workspace'), config: { queryMode: 'manual' },
  });
  const session = await app.sessionManager.getSessionForControl(sessionId);
  assert(session);
  await app.jobProcessor.stop();
  const messageId = 'synthetic-cancelled-episode';
  const nextId = 'synthetic-next-input';
  const retryAt = Date.now() + 60000;
  await session.stateManager.setRateLimitCooldown({ retryAt, retryCount: 0, maxRetries: 3, messageId });
  for (const uuid of [messageId, nextId]) {
    await app.db.saveUserMessage(sessionId, { type: 'user', uuid, message: { role: 'user', content: uuid } }, 'enqueued');
  }
  const owning = app.jobQueue.enqueue({ queue: 'message_delivery', payload: { sessionId, messageUuid: messageId, origin: 'chat' }, runAt: retryAt });
  const next = app.jobQueue.enqueue({ queue: 'message_delivery', payload: { sessionId, messageUuid: nextId, origin: 'chat' }, runAt: retryAt });
  const raw = app.db.getDatabase();
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (/DELETE FROM job_queue|UPDATE (job_queue|sdk_messages)/.test(args[0]) && (new Error().stack ?? '').includes('/agent/rate-limit-manual-cancel.ts')) {
      mainSqlAttempts++;
      throw new Error('rate limit cancellation SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  try {
    evidence.healthBefore = await hub.request('system.health', {});
    evidence.cancel = await hub.request('session.cancelRateLimitRetry', { sessionId });
    evidence.status = await hub.request('operation.invoke', { name: 'message.status', input: { sessionId, messageId } });
    evidence.nextStatus = await hub.request('operation.invoke', { name: 'message.status', input: { sessionId, messageId: nextId } });
    evidence.owningJob = app.jobQueue.getJob(owning.id);
    evidence.nextJob = app.jobQueue.getJob(next.id);
    evidence.state = session.stateManager.getState().status;
    evidence.healthAfter = await hub.request('system.health', {});
    assert.equal(mainSqlAttempts, 0, 'cancellation must not write to the main SQLite connection');
    assert.deepEqual(evidence.cancel, { success: true });
    assert.deepEqual(evidence.status, { status: 'failed' });
    assert.deepEqual(evidence.nextStatus, { status: 'queued' });
    assert.equal(evidence.owningJob, null);
    assert.equal(evidence.state, 'idle');
    const released = app.jobQueue.getJob(next.id);
    assert(released);
    assert.equal(released.status, 'pending');
    assert(released.runAt < retryAt);
    assert.equal(released.retryCount, 0);
  } finally {
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
} finally {
  writeFileSync(join(run, 'evidence/rate-limit-cancel.json'), JSON.stringify(evidence, null, 2));
  await transport?.close();
  await app?.cleanup();
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok cancellation RPC settles the episode on the writer and releases the next queued input');
