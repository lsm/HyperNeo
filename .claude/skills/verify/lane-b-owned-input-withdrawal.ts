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
  const ref = { adapter: 'hyperneo', id: sessionId };
  async function queueInput(message: string) {
    const sent = await hub.request<{ ok: boolean; value: { queuedSubmissionId: string } }>('operation.invoke', {
      name: 'work.queue', input: { ref, message },
    });
    assert.equal(sent.ok, true);
    assert(sent.value.queuedSubmissionId);
    const job = app!.jobQueue.getLatestByPayload('mailbox', { id: sent.value.queuedSubmissionId });
    assert(job);
    return { id: sent.value.queuedSubmissionId, job };
  }
  const queued = await queueInput('Withdraw this queued input');
  const raw = app.db.getDatabase();
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if ((new Error().stack ?? '').includes('/drivers/owned-input-withdrawal.ts')) {
      mainSqlAttempts++;
      throw new Error('owned-input withdrawal admission SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  const withdraw = (id: string) => hub.request('operation.invoke', { name: 'work.withdraw', input: { ref, queuedSubmissionId: id } });
  try {
    evidence.healthBefore = await hub.request('system.health', {});
    try { evidence.withdraw = await withdraw(queued.id); }
    catch (error) { evidence.rpcError = String(error); }
    evidence.pendingJob = app.jobQueue.getJob(queued.job.id);
    assert.equal(mainSqlAttempts, 0, 'withdrawal admission must not use main SQLite');
    assert.deepEqual(evidence.withdraw, { ok: true, value: { queuedSubmissionId: queued.id, withdrawn: true } });
    assert.equal(app.jobQueue.getJob(queued.job.id)?.error, 'driver_input_withdrawn');
    evidence.retry = await withdraw(queued.id);
    assert.deepEqual(evidence.retry, evidence.withdraw);
    const materialized = await queueInput('Withdraw a materialized deferred input');
    const uuid = materialized.job.payload.messageUuid;
    assert.equal(typeof uuid, 'string');
    const dbId = await app.db.saveUserMessage(sessionId, { type: 'user', uuid: uuid as string, message: { role: 'user', content: 'Withdraw a materialized deferred input' } }, 'deferred');
    raw.prepare("UPDATE job_queue SET status = 'completed' WHERE id = ?").run(materialized.job.id);
    evidence.materialized = await withdraw(materialized.id);
    assert.deepEqual(evidence.materialized, { ok: true, value: { queuedSubmissionId: materialized.id, withdrawn: true } });
    evidence.retainedMessageId = app.db.getSDKMessageRepo().findMessageIdByUuid(sessionId, uuid as string);
    assert.equal(evidence.retainedMessageId, null);
    evidence.materializedJob = app.jobQueue.getJob(materialized.job.id);
    assert.equal(app.jobQueue.getJob(materialized.job.id)?.error, 'driver_input_withdrawn');
    evidence.removedDbId = dbId;
    evidence.healthAfter = await hub.request('system.health', {});
    assert.equal(mainSqlAttempts, 0);
  } finally {
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
} finally {
  writeFileSync(join(run, 'evidence/owned-input-withdrawal.json'), JSON.stringify(evidence, null, 2));
  await transport?.close();
  await app?.cleanup();
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok work.withdraw claims owned input on the writer and preserves deferred removal and retry');
