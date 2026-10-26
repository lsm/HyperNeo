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
  const sessionId = 'synthetic-title-session';
  await app.db.createSession({
    id: sessionId, title: 'Human title wins', workspacePath: join(run, 'workspace'),
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active',
    config: { queryMode: 'manual', model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0 },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0, titleGenerated: false, titleSetBy: 'user' },
  });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const publish = (needsWorkspaceInit: boolean) => app!.internalEventBus.publish('message.persisted', {
    sessionId, messageId: 'synthetic-title-input', messageContent: 'Synthetic first input',
    userMessageText: 'Synthetic first input', needsWorkspaceInit, hasDraftToClear: false,
    sendStatus: 'enqueued', deliveryMode: 'immediate', skipQueryStart: true,
  });
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (/INSERT(?:\s+OR\s+\w+)?\s+INTO\s+job_queue\b/i.test(args[0])) {
      mainSqlAttempts++;
      throw new Error('session title admission SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  try {
    evidence.healthBefore = await hub.request('system.health', {});
    await publish(false);
    assert.equal(repo.listJobs({ queue: 'session.title_generation' }).length, 0);
    await publish(true);
    evidence.jobs = repo.listJobs({ queue: 'session.title_generation' });
    assert.equal(mainSqlAttempts, 0, 'persisted-message title job must be admitted off main');
    const jobs = repo.listJobs({ queue: 'session.title_generation' });
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0].payload, { sessionId, userMessageText: 'Synthetic first input' });
    assert.equal(jobs[0].maxRetries, 2);
    assert.equal(jobs[0].retryCount, 0);
    await hub.request('session.get', { sessionId });
    evidence.claimed = await app.jobProcessor.tick();
    const deadline = Date.now() + 5_000;
    while (repo.getJob(jobs[0].id)?.status === 'processing' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    evidence.completed = repo.getJob(jobs[0].id);
    assert.equal(repo.getJob(jobs[0].id)?.status, 'completed');
    assert.deepEqual(repo.getJob(jobs[0].id)?.result, { generated: true });
    evidence.session = await hub.request<{ session: { title: string } }>('session.get', { sessionId });
    assert.equal((evidence.session as { session: { title: string } }).session.title, 'Human title wins');
    evidence.healthAfter = await hub.request('system.health', {});
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
  writeFileSync(join(run, 'evidence/session-title-enqueue-writer.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok persisted-message title admission and registered job completion without main admission SQL');
