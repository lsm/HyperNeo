import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';

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
let pollRequests = 0;
const http = createServer((_request, response) => { pollRequests++; response.end('ok'); });
const { handleGitHubPoll } = await import('../../../packages/daemon/src/lib/job-handlers/github-poll.handler.ts');
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
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert(address && typeof address !== 'string');
  const service = {
    isRunning: () => true,
    triggerPoll: async () => {
      const reply = await fetch(`http://127.0.0.1:${address.port}/poll`);
      assert.equal(await reply.text(), 'ok');
    },
  } as unknown as NonNullable<Parameters<typeof handleGitHubPoll>[0]['pollingService']>;
  const first = repo.enqueue({ queue: 'github.poll', payload: {} });
  processor = new JobQueueProcessor(repo, { db: app.db.gateway });
  processor.register('github.poll', () => handleGitHubPoll({ pollingService: service, jobQueue: repo, intervalMs: () => 60_000 }));
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (/\/(?:job-handlers\/github-poll\.handler|repositories\/github-poll-successor-write)\.ts/.test(new Error().stack ?? '')) {
      mainSqlAttempts++;
      throw new Error('GitHub poll successor admission SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  try {
    evidence.healthBefore = await hub.request('system.health', {});
    evidence.claimed = await processor.tick();
    const deadline = Date.now() + 5_000;
    while (repo.getJob(first.id)?.status === 'processing' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    evidence.first = repo.getJob(first.id);
    evidence.successors = repo.listJobs({ queue: 'github.poll', status: 'pending' }).filter((job) => job.id !== first.id);
    evidence.pollRequests = pollRequests;
    evidence.healthAfter = await hub.request('system.health', {});
    assert.equal(mainSqlAttempts, 0, 'poll successor admission must not run SQL on main');
    assert.equal(repo.getJob(first.id)?.status, 'completed');
    assert.equal(repo.getJob(first.id)?.result?.polled, true);
    assert.equal(pollRequests, 1);
    const pending = repo.listJobs({ queue: 'github.poll', status: 'pending' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].runAt, repo.getJob(first.id)?.result?.nextRunAt);
    assert.deepEqual(pending[0].payload, {});
    assert.equal(pending[0].retryCount, 0);
    await handleGitHubPoll({ pollingService: service, jobQueue: repo, intervalMs: 60_000 });
    const afterDuplicate = repo.listJobs({ queue: 'github.poll', status: 'pending' });
    evidence.afterDuplicate = afterDuplicate;
    assert.deepEqual(afterDuplicate, pending);
    const disabled = await handleGitHubPoll({ pollingService: undefined, jobQueue: repo, intervalMs: 0 });
    evidence.disabled = disabled;
    assert.deepEqual(disabled, { polled: false, nextRunAt: 0 });
    assert.deepEqual(repo.listJobs({ queue: 'github.poll', status: 'pending' }), pending);
    assert.equal(mainSqlAttempts, 0);
  } finally {
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
} finally {
  JobQueueProcessor.prototype.start = start;
  await transport?.close();
  await processor?.stop();
  await Promise.all([...processors].map((owned) => owned.stop()));
  await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/github-poll-successor-writer.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok poll job completes after durable successor admission without main SQL');
