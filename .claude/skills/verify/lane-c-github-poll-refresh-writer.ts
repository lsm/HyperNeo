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
const { GitHubService } = await import('../../../packages/daemon/src/lib/github/github-service.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
const start = JobQueueProcessor.prototype.start;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
const evidence: Record<string, unknown> = {};
let service: InstanceType<typeof GitHubService> | undefined;
let unsubscribe: (() => void) | undefined;
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
  service = new GitHubService({
    db: app.db, internalEventBus: app.internalEventBus, config: getConfig(),
    apiKey: '', githubToken: 'synthetic-transport-only', jobQueue: repo,
    jobProcessor: app.jobProcessor,
    getPollingIntervalSeconds: () => app!.settingsManager.getGlobalSettings().githubPollingInterval ?? 120,
    collectPollPage: async () => Response.json([]),
  });
  let refreshCount = 0;
  unsubscribe = app.internalEventBus.subscribe('settings.updated', async (event) => {
    if (event.namespaceId !== 'global') return;
    await service!.refreshPolling({ reschedulePending: true });
    refreshCount++;
  }, { subscriberName: 'synthetic-github-refresh-door' });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (/\bjob_queue\b/i.test(args[0]) && /\/(?:github\/github-service|repositories\/github-poll-refresh-write)\.ts/.test(new Error().stack ?? '')) {
      mainSqlAttempts++;
      throw new Error('GitHub poll refresh SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  try {
    evidence.healthBefore = await hub.request('system.health', {});
    try { await service.start(); } catch (error) { evidence.startError = String(error); }
    evidence.initial = repo.listJobs({ queue: 'github.poll' });
    assert.equal(mainSqlAttempts, 0, 'GitHub service refresh must not run job SQL on main');
    const initial = repo.listJobs({ queue: 'github.poll', status: 'pending' });
    assert.equal(initial.length, 1);
    assert(initial[0].runAt <= Date.now());
    await Promise.all([service.refreshPolling(), service.refreshPolling()]);
    assert.deepEqual(repo.listJobs({ queue: 'github.poll', status: 'pending' }), initial);
    service.addRepository('synthetic', 'refresh-fixture');
    evidence.claimed = await app.jobProcessor.tick();
    const deadline = Date.now() + 5_000;
    while (repo.getJob(initial[0].id)?.status === 'processing' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    evidence.completed = repo.getJob(initial[0].id);
    assert.equal(repo.getJob(initial[0].id)?.status, 'completed');
    assert.equal(repo.getJob(initial[0].id)?.result?.polled, true);
    const completed = repo.getJob(initial[0].id);
    const successor = repo.listJobs({ queue: 'github.poll', status: 'pending' });
    assert.equal(successor.length, 1);
    const update = async (githubPollingInterval: number) => {
      const previous = refreshCount;
      const reply = await hub.request('settings.global.update', { updates: { githubPollingInterval } });
      const deadline = Date.now() + 5_000;
      while (refreshCount === previous && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(refreshCount, previous + 1);
      return reply;
    };
    evidence.reschedule = await update(30);
    const replacement = repo.listJobs({ queue: 'github.poll', status: 'pending' });
    assert.equal(replacement.length, 1);
    assert.notEqual(replacement[0].id, successor[0].id);
    assert(replacement[0].runAt <= Date.now());
    const claimed = repo.dequeue('github.poll')[0];
    assert.equal(claimed.id, replacement[0].id);
    repo.enqueue({ queue: 'github.poll', payload: {}, runAt: Date.now() + 60_000 });
    const foreign = repo.enqueue({ queue: 'synthetic.other', payload: {} });
    evidence.disable = await update(0);
    assert.equal(service.isPolling(), false);
    assert.deepEqual(repo.listJobs({ queue: 'github.poll', status: 'pending' }), []);
    assert.deepEqual(repo.getJob(claimed.id), claimed);
    assert.deepEqual(repo.getJob(foreign.id), foreign);
    evidence.enable = await update(45);
    assert.equal(service.isPolling(), true);
    assert.deepEqual(repo.listJobs({ queue: 'github.poll', status: 'pending' }), []);
    assert.deepEqual(repo.getJob(claimed.id), claimed);
    assert.deepEqual(repo.getJob(initial[0].id), completed);
    evidence.processingLeaseRetained = true;
    evidence.jobs = repo.listJobs({ queue: 'github.poll' });
    evidence.healthAfter = await hub.request('system.health', {});
    assert.equal(mainSqlAttempts, 0);
  } finally {
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
} finally {
  JobQueueProcessor.prototype.start = start;
  unsubscribe?.();
  service?.stop();
  await transport?.close();
  await Promise.all([...processors].map((owned) => owned.stop()));
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/github-poll-refresh-writer.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok GitHub service startup and settings refresh preserve jobs and leases without main SQL');
