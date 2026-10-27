import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { jobQueueWrites } from '../../../packages/daemon/src/storage/repositories/job-queue-repository.ts';

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
const mainSql: string[] = [], terminalJobs: unknown[] = [];
let measuring = false;
const raw = app.db.getDatabase(), prepare = raw.prepare.bind(raw);
raw.prepare = ((sql: string) => { if (measuring && /UPDATE job_queue[\s\S]*SET status = 'pending'/.test(sql)) mainSql.push(sql); return prepare(sql); }) as typeof raw.prepare;
try {
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const body = 'Retry keeps the full payload 甲乙🙂'.repeat(4000);
  const target = app.jobQueue.enqueue({ queue: 'verify.requeue.target', payload: { body } });
  const first = app.jobQueue.dequeue('verify.requeue.target')[0];
  assert.equal(first.id, target.id); assert(first.claimToken);
  app.jobProcessor.register('verify.requeue.control', async () => {
    const gateway = app.db.gateway;
    assert.equal(await gateway.call(jobQueueWrites, 'requeueParked', target.id, 0, 'stale-claim'), null);
    const parked = await gateway.call(jobQueueWrites, 'requeueParked', target.id, 0, first.claimToken);
    assert.equal(parked?.status, 'pending');
    assert.equal(parked.payload.__parkCount, 1);
    assert.equal(typeof parked.payload.__parkedSince, 'number');
    assert.equal(parked.startedAt, null); assert.equal(parked.heartbeatAt, null);
    const second = (await gateway.call(jobQueueWrites, 'dequeue', 'verify.requeue.target'))[0];
    assert(second.claimToken); assert.notEqual(second.claimToken, first.claimToken);
    assert.equal(await gateway.call(jobQueueWrites, 'requeueWaiting', target.id, 0, first.claimToken), null);
    const waiting = await gateway.call(jobQueueWrites, 'requeueWaiting', target.id, 0, second.claimToken);
    assert.equal(waiting?.status, 'pending');
    assert.equal(waiting.payload.__parkCount, undefined);
    assert.equal(waiting.payload.__parkedSince, undefined);
    const third = (await gateway.call(jobQueueWrites, 'dequeue', 'verify.requeue.target'))[0];
    assert(third.claimToken); assert.notEqual(third.claimToken, second.claimToken);
    assert.equal(await gateway.call(jobQueueWrites, 'requeue', target.id, 0, second.claimToken), null);
    const requeued = await gateway.call(jobQueueWrites, 'requeue', target.id, Date.now() + 60000, third.claimToken);
    assert.equal(requeued?.status, 'pending'); assert.equal(requeued.payload.body, body);
    return { parked: true, waiting: true, requeued: true, staleClaimsRefused: 3, payloadBytes: Buffer.byteLength(body) };
  });
  const control = app.jobQueue.enqueue({ queue: 'verify.requeue.control', payload: {}, maxRetries: 0, priority: 100 });
  measuring = true;
  await app.jobProcessor.start();
  let terminal: ReturnType<typeof app.jobQueue.getJob>;
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const current = app.jobQueue.getJob(control.id);
      if (current && ['completed', 'dead', 'failed'].includes(current.status)) { terminal = current; break; }
      await new Promise(done => setTimeout(done, 20));
    }
  } finally { await app.jobProcessor.stop(); measuring = false; }
  terminalJobs.push(terminal);
  assert.equal(terminal?.status, 'completed', `Fenced requeue job must complete: ${terminal?.error}`);
  assert.equal(terminal.result?.staleClaimsRefused, 3);
  const stored = app.jobQueue.getJob(target.id);
  assert.equal(stored?.status, 'pending'); assert.equal(stored.payload.body, body);
  assert.equal(stored.retryCount, 0);
  assert.equal(stored.payload.__parkCount, undefined);
  assert.deepEqual(mainSql, [], 'Job requeue writes must be absent on the daemon main connection');
  console.log('ok: real job parks, waits and requeues through the writer; all three stale claims are refused; full payload survives');
} finally {
  measuring = false; await app.cleanup(); globalThis.fetch = originalFetch;
  writeFileSync(join(run, 'evidence/job-requeue-writer.json'), JSON.stringify({ mode, mainSql, terminalJobs }, null, 2));
}
