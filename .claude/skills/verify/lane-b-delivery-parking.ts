import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
  const retryAt = Date.now() + 60000;
  await session.stateManager.setRateLimitCooldown({ retryAt, retryCount: 0, maxRetries: 3 });
  const messageId = 'synthetic-parking';
  await app.db.saveUserMessage(sessionId, { type: 'user', uuid: messageId, message: { role: 'user', content: 'Retain this queued input' } }, 'enqueued');
  const job = app.jobQueue.enqueue({ queue: 'message_delivery', payload: { sessionId, messageUuid: messageId, origin: 'chat' }, runAt: Date.now() + 50 });
  const raw = app.db.getDatabase();
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (args[0].includes('__parkCount') && (new Error().stack ?? '').includes('/job-handlers/message-delivery.handler.ts')) {
      mainSqlAttempts++;
      throw new Error('delivery parking SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  try {
    evidence.healthBefore = await hub.request('system.health', {});
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && mainSqlAttempts === 0 && !app.jobQueue.getJob(job.id)?.payload.__parkCount) {
      await new Promise(done => setTimeout(done, 20));
    }
    const parked = app.jobQueue.getJob(job.id);
    evidence.job = parked;
    assert.equal(mainSqlAttempts, 0, 'parking must not update the main SQLite connection');
    assert(parked);
    assert.equal(parked.status, 'pending');
    assert.equal(parked.runAt, retryAt);
    assert.equal(parked.retryCount, 0);
    assert.equal(parked.payload.__parkCount, 1);
    assert(parked.claimToken);
    assert.equal(parked.startedAt, null);
    assert.equal(parked.heartbeatAt, null);
    evidence.status = await hub.request('operation.invoke', { name: 'message.status', input: { sessionId, messageId } });
    assert.deepEqual(evidence.status, { status: 'queued' });
    evidence.healthAfter = await hub.request('system.health', {});
  } finally {
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
} finally {
  writeFileSync(join(run, 'evidence/delivery-parking.json'), JSON.stringify(evidence, null, 2));
  await transport?.close();
  await app?.cleanup();
}
console.log('ok real delivery handler parks on writer without spending a retry; RPC keeps input queued');
