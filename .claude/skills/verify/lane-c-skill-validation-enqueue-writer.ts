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
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (/INSERT(?:\s+OR\s+\w+)?\s+INTO\s+job_queue\b/i.test(args[0])) {
      mainSqlAttempts++;
      throw new Error('skill validation admission SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  try {
    evidence.healthBefore = await hub.request('system.health', {});
    let created: { skill: { id: string; validationStatus: string } } | undefined;
    try {
      created = await hub.request('skill.create', { params: {
        name: 'synthetic-validation-skill', displayName: 'Synthetic validation',
        description: 'Owned RPC fixture', sourceType: 'plugin', enabled: false,
        validationStatus: 'pending', config: { type: 'plugin', pluginPath: join(run, 'workspace') },
      } });
    } catch (error) { evidence.createError = String(error); }
    evidence.initial = repo.listJobs({ queue: 'skill.validate' });
    assert.equal(mainSqlAttempts, 0, 'skill RPC validation admission must not insert jobs on main');
    assert(created);
    const first = repo.listJobs({ queue: 'skill.validate', status: 'pending' });
    assert.equal(first.length, 1);
    assert.deepEqual(first[0].payload, { skillId: created.skill.id });
    assert.equal(first[0].maxRetries, 3);
    const runJob = async (id: string) => {
      await app!.jobProcessor.tick();
      const deadline = Date.now() + 5_000;
      while (repo.getJob(id)?.status === 'processing' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      const job = repo.getJob(id);
      assert.equal(job?.status, 'completed');
      assert.deepEqual(job?.result, { valid: true, skillId: created!.skill.id });
      return job;
    };
    evidence.firstCompleted = await runJob(first[0].id);
    const observe = async () => {
      const reply = await hub.request<{ skill: { validationStatus: string } }>('skill.update', {
        id: created!.skill.id, params: { description: 'Observed synthetic validation' },
      });
      assert.equal(reply.skill.validationStatus, 'valid');
      return reply;
    };
    evidence.firstObserved = await observe();
    assert.deepEqual(repo.listJobs({ queue: 'skill.validate', status: 'pending' }), []);
    const updated = await hub.request<{ skill: { validationStatus: string } }>('skill.update', {
      id: created.skill.id, params: { config: { type: 'plugin', pluginPath: join(run, 'workspace') } },
    });
    assert.equal(updated.skill.validationStatus, 'pending');
    const second = repo.listJobs({ queue: 'skill.validate', status: 'pending' });
    assert.equal(second.length, 1);
    assert.notEqual(second[0].id, first[0].id);
    assert.deepEqual(second[0].payload, first[0].payload);
    evidence.secondCompleted = await runJob(second[0].id);
    evidence.secondObserved = await observe();
    raw.exec("CREATE TRIGGER reject_skill_job BEFORE INSERT ON job_queue WHEN NEW.queue = 'skill.validate' BEGIN SELECT RAISE(ABORT, 'synthetic validation rejection'); END");
    try {
      await hub.request('skill.update', { id: created.skill.id, params: { config: { type: 'plugin', pluginPath: join(run, 'workspace') } } });
    } catch (error) { evidence.rejectedUpdate = String(error); }
    assert(evidence.rejectedUpdate);
    assert.equal(repo.listJobs({ queue: 'skill.validate' }).length, 2);
    assert.deepEqual(repo.listJobs({ queue: 'skill.validate', status: 'pending' }), []);
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
  writeFileSync(join(run, 'evidence/skill-validation-enqueue-writer.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok skill create/config-update RPCs admit validation jobs off main and registered jobs validate owned files');
