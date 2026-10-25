import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JOB_QUEUE_CLEANUP } from '../../../packages/daemon/src/lib/job-queue-constants.ts';

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
  app = await createDaemonApp({
    config: {
      ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }),
      disableWorktrees: true,
      disableGoalProcessing: true,
    },
    verbose: false,
  });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  const raw = app.db.getDatabase();
  raw.prepare('DELETE FROM job_queue WHERE queue = ?').run(JOB_QUEUE_CLEANUP);
  const job = app.jobQueue.enqueue({ queue: JOB_QUEUE_CLEANUP, payload: {}, runAt: 0 });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  evidence.health = await hub.request('system.health', {});
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if ((new Error().stack ?? '').includes('/job-handlers/cleanup.handler.ts')) {
      mainSqlAttempts++;
      throw new Error('cleanup scheduling SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  try {
    app.jobProcessor.start();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && mainSqlAttempts === 0 && app.jobQueue.getJob(job.id)?.status !== 'completed') {
      await new Promise((done) => setTimeout(done, 20));
    }
    evidence.mainSqlAttempts = mainSqlAttempts;
    evidence.job = app.jobQueue.getJob(job.id);
    evidence.pending = app.jobQueue.listJobs({ queue: JOB_QUEUE_CLEANUP, status: 'pending' });
    evidence.healthAfter = await hub.request('system.health', {});
    assert.equal(mainSqlAttempts, 0, 'cleanup admission must not use main SQLite');
    assert.equal(app.jobQueue.getJob(job.id)?.status, 'completed');
    const pending = app.jobQueue.listJobs({ queue: JOB_QUEUE_CLEANUP, status: 'pending' });
    assert.equal(pending.length, 1);
    assert(pending[0].runAt > Date.now() + 3500000);
  } finally {
    raw.prepare = prepare;
  }
} finally {
  writeFileSync(join(run, 'evidence/cleanup-enqueue.json'), JSON.stringify(evidence, null, 2));
  await transport?.close();
  await app?.cleanup();
}
console.log('ok real cleanup job completed and scheduled one successor without main admission SQL');
