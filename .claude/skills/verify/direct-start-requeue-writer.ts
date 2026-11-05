import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../packages/daemon/src/storage/repositories/space-task-repository.ts';
import { DirectTaskExecutionRepository } from '../../../packages/daemon/src/storage/repositories/direct-task-execution-repository.ts';
import { createDirectStartRequester, createDirectStartJobHandler } from '../../../packages/daemon/src/lib/tasks/direct-start-jobs.ts';
import { DIRECT_TASK_START } from '../../../packages/daemon/src/lib/tasks/direct-start-request.ts';

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
raw.prepare = ((sql: string) => { if (measuring && /UPDATE job_queue[\s\S]*(?:json_set|json_remove)[\s\S]*__parkCount/.test(sql)) mainSql.push(sql); return prepare(sql); }) as typeof raw.prepare;
async function processUntil(jobId: string, ready: (job: NonNullable<ReturnType<typeof app.jobQueue.getJob>>) => boolean) {
  measuring = true;
  app.jobProcessor.start();
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const current = app.jobQueue.getJob(jobId);
      if (current && ready(current)) return current;
      if (current && ['completed', 'dead', 'failed'].includes(current.status)) throw new Error(`Start did not requeue: ${JSON.stringify(current)}`);
      await new Promise(done => setTimeout(done, 20));
    }
    throw new Error('Timed out waiting for the durable direct-start job');
  } finally { await app.jobProcessor.stop(); measuring = false; }
}
try {
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const spaces = new SpaceRepository(raw), tasks = new SpaceTaskRepository(raw), attempts = new DirectTaskExecutionRepository(raw);
  const space = spaces.createSpace({ slug: 'start-fixture', name: 'Start fixture', workspacePath: join(run, 'workspace') });
  const task = tasks.createTask({ spaceId: space.id, title: 'Deferred direct start', description: '', status: 'draft' });
  const note = 'Keep the frozen start note 甲乙🙂'.repeat(3000);
  const ack = createDirectStartRequester({ db: raw, jobQueue: app.jobQueue })({ taskId: task.id, requestKey: 'synthetic-request', note });
  assert(ack.accepted && ack.jobId);
  const jobId = ack.jobId, attempt = attempts.getActive(task.id);
  assert(attempt); assert.equal(attempt.phase, 'reserved');
  spaces.pauseSpace(space.id);
  const parked = await processUntil(jobId, job => job.status === 'pending' && job.payload.__parkCount === 1);
  assert.equal(parked.queue, DIRECT_TASK_START); assert.equal(parked.retryCount, 0);
  assert.equal(attempts.getActive(task.id)?.phase, 'reserved');
  assert.equal(tasks.getTask(task.id)?.status, 'open');
  assert.equal(app.sessionManager.getCachedSession(attempt.sessionId), null);
  results.push({ phase: 'registered-handler-paused-space', job: parked });
  spaces.resumeSpace(space.id);
  const waitingHandler = createDirectStartJobHandler(raw, async () => ({ started: false, reason: 'awaiting_capacity' }), app.sessionManager);
  app.jobProcessor.register(DIRECT_TASK_START, waitingHandler);
  app.jobQueue.reschedulePending(jobId, Date.now() - 1);
  const waiting = await processUntil(jobId, job => job.status === 'pending' && job.payload.__parkCount === undefined);
  assert.equal(waiting.payload.__parkedSince, undefined); assert.equal(waiting.retryCount, 0);
  assert.equal(waiting.payload.attemptId, attempt.id);
  assert.equal(attempts.getActive(task.id)?.phase, 'reserved');
  results.push({ phase: 'capacity-result-fixture', job: waiting });
  app.jobQueue.reschedulePending(jobId, Date.now() - 1);
  const replacement = app.jobQueue.dequeue(DIRECT_TASK_START)[0];
  assert(replacement.claimToken); assert.notEqual(replacement.claimToken, waiting.claimToken);
  for (const reason of ['awaiting_dependencies', 'direct_start_unavailable']) {
    const handler = createDirectStartJobHandler(raw, async () => ({ started: false, reason }), app.sessionManager);
    measuring = true;
    const stale = await handler(waiting);
    measuring = false;
    assert.deepEqual(stale, { started: false, reason: 'superseded_claim' });
    assert.equal(app.jobQueue.getJob(jobId)?.status, 'processing');
    assert.equal(app.jobQueue.getJob(jobId)?.claimToken, replacement.claimToken);
    results.push({ phase: 'stale-claim', startReason: reason, result: stale });
  }
  const ownedHandler = createDirectStartJobHandler(raw, async () => ({ started: false, reason: 'awaiting_dependencies' }), app.sessionManager);
  measuring = true;
  const owned = await ownedHandler(replacement);
  measuring = false;
  assert.deepEqual(owned, { started: false, reason: 'awaiting_dependencies', parked: 'awaiting_dependencies' });
  const stored = app.jobQueue.getJob(jobId);
  assert.equal(stored?.status, 'pending'); assert.equal(stored.retryCount, 0);
  assert.equal(stored.payload.__parkCount, undefined);
  const request = raw.prepare('SELECT request_json FROM direct_task_start_requests WHERE attempt_id = ?').get(attempt.id) as { request_json: string };
  assert.equal(JSON.parse(request.request_json).note, note);
  results.push({ phase: 'owned-wait', result: owned, stored, noteBytes: Buffer.byteLength(note) });
  assert.deepEqual(mainSql, [], 'Direct-start parking and waiting SQL must leave the daemon main connection');
  console.log('ok: registered direct-start job parks; capacity/dependency result fixtures wait without retries; stale park/wait claims cannot change the replacement');
} finally {
  measuring = false; await app.cleanup(); globalThis.fetch = originalFetch;
  writeFileSync(join(run, 'evidence/direct-start-requeue-writer.json'), JSON.stringify({ mode, mainSql, results }, null, 2));
}
