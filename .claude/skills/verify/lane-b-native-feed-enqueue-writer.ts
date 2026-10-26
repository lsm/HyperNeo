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
const { scheduleClaudeFeed } = await import('../../../packages/daemon/src/lib/drivers/claude-feed.ts');
const { scheduleCodexFeed } = await import('../../../packages/daemon/src/lib/drivers/codex-feed.ts');
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
  await Promise.all([...processors].map((owned) => owned.stop()));
  const repo = app.jobQueue;
  const raw = app.db.getDatabase();
  raw.prepare("UPDATE job_queue SET run_at = ? WHERE status = 'pending'").run(Date.now() + 86_400_000);
  const fixtures = ['claude', 'codex'].map((kind) => repo.enqueue({ queue: `work.feed.${kind}`, payload: { scope: kind } }));
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (/\bjob_queue\b/i.test(args[0]) && /\/(?:drivers\/(?:claude-feed|codex-feed)|repositories\/native-feed-enqueue-write)\.ts/.test(new Error().stack ?? '')) {
      mainSqlAttempts++;
      throw new Error('native feed job admission SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  try {
    evidence.healthBefore = await hub.request('system.health', {});
    evidence.claimed = await app.jobProcessor.tick();
    const deadline = Date.now() + 5_000;
    while (fixtures.some((job) => repo.getJob(job.id)?.status === 'processing') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    evidence.jobs = fixtures.map((job) => repo.getJob(job.id));
    evidence.successors = fixtures.map((job) => repo.listJobs({ queue: job.queue, status: 'pending' }).filter((candidate) => candidate.id !== job.id));
    evidence.healthAfter = await hub.request('system.health', {});
    assert.equal(mainSqlAttempts, 0, 'both registered feed jobs must admit successors off main');
    for (const [index, kind] of ['claude', 'codex'].entries()) {
      const job = repo.getJob(fixtures[index].id)!;
      assert.equal(job.status, 'completed');
      assert.deepEqual(job.result, { files: 0, turns: 0 });
      const pending = repo.listJobs({ queue: job.queue, status: 'pending' });
      assert.equal(pending.length, 1);
      assert.deepEqual(pending[0].payload, { scope: kind });
      assert(pending[0].runAt > job.startedAt! + 59_000);
      assert.equal(pending[0].retryCount, 0);
      await Promise.all([0, 1].map(() => kind === 'claude' ? scheduleClaudeFeed(repo) : scheduleCodexFeed(repo)));
      assert.deepEqual(repo.listJobs({ queue: job.queue, status: 'pending' }), pending);
    }
    assert.equal(mainSqlAttempts, 0);
  } finally {
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
} finally {
  JobQueueProcessor.prototype.start = start;
  await transport?.close();
  await Promise.all([...processors].map((owned) => owned.stop()));
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/native-feed-enqueue-writer.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok both native feed jobs retain one durable successor without main admission SQL');
