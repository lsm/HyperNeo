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
let processor: InstanceType<typeof JobQueueProcessor> | undefined;
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
  await Promise.all([...processors].map((owned) => owned.stop()));
  const repo = app.jobQueue;
  const raw = app.db.getDatabase();
  const queue = 'synthetic-reclaim-owned';
  const stale = [0, 1].map((seq) => repo.enqueue({ queue, payload: { seq }, maxRetries: 8 }));
  const oldClaims = repo.dequeue(queue, 2);
  const fresh = repo.enqueue({ queue, payload: { fresh: true } });
  repo.dequeue(queue, 1);
  const foreign = repo.enqueue({ queue: 'synthetic-reclaim-foreign', payload: {} });
  repo.dequeue(foreign.queue, 1);
  for (const job of [...stale, foreign]) {
    raw.prepare('UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?').run(Date.now() - 60_000, Date.now() - 60_000, job.id);
  }
  const processed: string[] = [];
  processor = new JobQueueProcessor(repo, { db: app.db.gateway, staleThresholdMs: 5_000, maxConcurrent: 2, jitterRandom: () => 0.5 });
  processor.register(queue, async (job) => { processed.push(job.id); });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (/UPDATE\s+job_queue\s+SET\s+(?:status\s*=\s*'pending',\s*started_at|run_at\s*=\s*\?\s+WHERE\s+id)/i.test(args[0])) {
      mainSqlAttempts++;
      throw new Error('stale reclaim or jitter SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  try {
    evidence.healthBefore = await hub.request('system.health', {});
    await processor.tick();
    evidence.reclaimed = stale.map((job) => repo.getJob(job.id));
    evidence.foreign = repo.getJob(foreign.id)?.status;
    evidence.fresh = repo.getJob(fresh.id)?.status;
    evidence.oldClaimHeartbeats = oldClaims.map((job) => repo.heartbeat(job.id, job.claimToken));
    evidence.oldClaimCompletions = oldClaims.map((job) => repo.complete(job.id, {}, job.claimToken) !== null);
    evidence.processedBeforeDue = [...processed];
    for (const job of stale) raw.prepare('UPDATE job_queue SET run_at = 0 WHERE id = ?').run(job.id);
    await processor.tick();
    const deadline = Date.now() + 5_000;
    while (stale.some((job) => repo.getJob(job.id)?.status !== 'completed') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    evidence.processed = [...processed];
    evidence.completed = stale.map((job) => repo.getJob(job.id));
    evidence.healthAfter = await hub.request('system.health', {});
    assert.equal(mainSqlAttempts, 0, 'reclaim and jitter must not write on main');
    assert.equal(evidence.foreign, 'processing');
    assert.equal(evidence.fresh, 'processing');
    assert.deepEqual(evidence.oldClaimHeartbeats, [false, false]);
    assert.deepEqual(evidence.oldClaimCompletions, [false, false]);
    assert.deepEqual(evidence.processedBeforeDue, []);
    assert.deepEqual(processed.sort(), stale.map((job) => job.id).sort());
    for (const job of stale) {
      const done = repo.getJob(job.id)!;
      assert.equal(done.status, 'completed');
      assert.equal(done.retryCount, 0);
      assert.equal(done.maxRetries, 8);
      assert.notEqual(done.claimToken, oldClaims.find((claim) => claim.id === job.id)?.claimToken);
    }
  } finally {
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
} finally {
  JobQueueProcessor.prototype.start = start;
  await transport?.close();
  await processor?.stop();
  await Promise.all([...processors].map((owned) => owned.stop()));
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/stale-reclaim-writer.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok writer reclaim preserves queue scope, leases, jitter and durable redelivery');
