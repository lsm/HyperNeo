import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../packages/daemon/src/storage/repositories/space-task-repository.ts';
import { DirectTaskExecutionRepository } from '../../../packages/daemon/src/storage/repositories/direct-task-execution-repository.ts';
import { createDirectOutcomeRequester, createDirectOutcomeHandler, DIRECT_TASK_OUTCOME } from '../../../packages/daemon/src/lib/tasks/direct-outcome-jobs.ts';

const [mode, directory] = process.argv.slice(2), run = resolve(directory);
assert.equal(mode, 'verify');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP forbidden'); }) as typeof fetch;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const mainSql: string[] = [], results: unknown[] = [];
let measuring = false;
const raw = app.db.getDatabase(), prepare = raw.prepare.bind(raw);
raw.prepare = ((sql: string) => { if (measuring && /UPDATE job_queue[\s\S]*__parkCount/.test(sql)) mainSql.push(sql); return prepare(sql); }) as typeof raw.prepare;
try {
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const space = new SpaceRepository(raw).createSpace({ slug: 'outcome-fixture', name: 'Outcome fixture', workspacePath: join(run, 'workspace') });
  const tasks = new SpaceTaskRepository(raw), attempts = new DirectTaskExecutionRepository(raw);
  const task = tasks.createTask({ spaceId: space.id, title: 'Unverified stop', description: '' });
  attempts.select(task.id); attempts.claim(task.id, 'synthetic-attempt', 'synthetic-absent-worker');
  assert.equal(attempts.activate('synthetic-attempt', 'synthetic-absent-worker')?.phase, 'running');
  tasks.updateTask(task.id, { status: 'in_progress', taskAgentSessionId: 'synthetic-absent-worker' });
  const request = createDirectOutcomeRequester(raw, app.jobQueue)({ attemptId: 'synthetic-attempt', sessionId: 'synthetic-absent-worker', generation: 1, status: 'blocked', options: { result: 'Keep the frozen outcome 甲乙🙂'.repeat(3000) } });
  assert(request.accepted && request.jobId, 'A durable outcome job must be accepted');
  const jobId = request.jobId;
  measuring = true;
  await app.jobProcessor.start();
  let parked: ReturnType<typeof app.jobQueue.getJob>;
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const current = app.jobQueue.getJob(jobId);
      if (current?.status === 'pending' && current.payload.__parkCount === 1) { parked = current; break; }
      if (current && ['completed', 'dead', 'failed'].includes(current.status)) throw new Error(`Outcome did not park: ${JSON.stringify(current)}`);
      await new Promise(done => setTimeout(done, 20));
    }
  } finally { await app.jobProcessor.stop(); measuring = false; }
  assert(parked, 'The actual registered direct-outcome handler must park its unverified stop');
  assert.equal(parked.queue, DIRECT_TASK_OUTCOME); assert.equal(parked.retryCount, 0);
  assert.equal(tasks.getTask(task.id)?.status, 'in_progress');
  assert.equal(attempts.getActive(task.id)?.phase, 'running');
  assert(attempts.isStopRequested('synthetic-attempt', 'synthetic-absent-worker'));
  results.push({ phase: 'registered-job', job: parked });
  app.jobQueue.reschedulePending(jobId, Date.now() - 1);
  const replacement = app.jobQueue.dequeue(DIRECT_TASK_OUTCOME)[0];
  assert(replacement.claimToken); assert.notEqual(replacement.claimToken, parked.claimToken);
  const handler = createDirectOutcomeHandler({ db: raw, sessionManager: app.sessionManager });
  measuring = true;
  const stale = await handler(parked);
  measuring = false;
  assert.equal('parked' in stale, false, 'A superseded claim must not report successful parking');
  assert.equal(app.jobQueue.getJob(jobId)?.status, 'processing');
  assert.equal(app.jobQueue.getJob(jobId)?.payload.__parkCount, 1);
  measuring = true;
  const owned = await handler(replacement);
  measuring = false;
  assert.equal('parked' in owned && owned.parked, 'direct_stop_unverified');
  assert.equal(app.jobQueue.getJob(jobId)?.payload.__parkCount, 2);
  results.push({ phase: 'fencing', stale, owned, stored: app.jobQueue.getJob(jobId) });
  assert.deepEqual(mainSql, [], 'Direct-outcome parking SQL must leave the daemon main connection');
  console.log('ok: actual direct-outcome job parks off main without spending a retry; stale ownership cannot park its replacement');
} finally {
  measuring = false; await app.cleanup(); globalThis.fetch = originalFetch;
  writeFileSync(join(run, 'evidence/direct-outcome-parking-writer.json'), JSON.stringify({ mode, mainSql, results }, null, 2));
}
