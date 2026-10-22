import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { JobQueueRepository } from '../../../packages/daemon/src/storage/repositories/job-queue-repository.ts';
import { SessionEventWriter } from '../../../packages/daemon/src/lib/external-events/session-event-writer.ts';
import { SDKBunWorkerBridge } from '../../../packages/daemon/tests/helpers/sdk-bun-worker-bridge.ts';

await import('./claude-feed-purge-worker.ts');
const proof = JSON.parse(
  readFileSync(join(resolve(process.argv[2]), 'evidence/purge.json'), 'utf8')
);
assert.equal(proof.maxConcurrent, 5);
assert(proof.metrics.some((event: { metadata: { operation?: string; outcome?: string } }) =>
  event.metadata.operation === 'job-queue-dequeue' && event.metadata.outcome === 'ok'
));
assert(!proof.mainTransactions.some((transaction: { stack: string }) =>
  transaction.stack.includes('JobQueueRepository.dequeue')
));

const dbPath = join(resolve(process.argv[2]), 'data/daemon.db');
const db = new Database(dbPath);
const queue = new JobQueueRepository(db);
const createWorker = process.env.VERIFY_WRITER_IPC === '1'
  ? () => new SDKBunWorkerBridge(new URL('../../../packages/daemon/src/lib/external-events/session-event-writer-worker.ts', import.meta.url).href) as unknown as Worker
  : undefined;
const writers = [new SessionEventWriter(dbPath, createWorker), new SessionEventWriter(dbPath, createWorker)];
const claims: Record<string, unknown> = {};
try {
  const body = 'Full synthetic claim payload 🦊\n'.repeat(1000);
  const seeded = Array.from({ length: 20 }, () => queue.enqueue({ queue: 'synthetic-claim', payload: { body } }));
  const batches = await Promise.all(writers.map(writer => writer.claimJobs({ method: 'dequeue', args: ['synthetic-claim', 10] })));
  const jobs = batches.flat();
  assert.equal(jobs.length, 20);
  assert.equal(new Set(jobs.map(job => job.id)).size, 20);
  assert.equal(new Set(jobs.map(job => job.claimToken)).size, 20);
  assert.deepEqual(jobs.map(job => job.id).sort(), seeded.map(job => job.id).sort());
  for (const job of jobs) {
    assert.equal(job.payload.body, body);
    assert(job.claimToken);
    assert.equal(queue.complete(job.id, {}, 'wrong-claim'), null);
    assert.equal(queue.complete(job.id, { body }, job.claimToken)?.status, 'completed');
    assert.equal(queue.getJob(job.id)?.result?.body, body);
  }
  claims.competingWriters = { count: jobs.length, uniqueClaims: 20, completed: 20, fullPayload: true };
  const fifo = ['a', 'a', 'b'].map(sessionId => queue.enqueue({ queue: 'synthetic-fifo', payload: { sessionId, body } }));
  const heads = (await Promise.all(writers.map(writer => writer.claimJobs({ method: 'dequeueSessionFifo', args: ['synthetic-fifo', 5] })))).flat();
  assert.deepEqual(heads.map(job => job.id).sort(), [fifo[0].id, fifo[2].id].sort());
  for (const job of heads) assert(queue.complete(job.id, {}, job.claimToken));
  const tail = await writers[0].claimJobs({ method: 'dequeueSessionFifo', args: ['synthetic-fifo', 5] });
  assert.deepEqual(tail.map(job => job.id), [fifo[1].id]);
  assert(queue.complete(tail[0].id, {}, tail[0].claimToken));
  claims.fifo = { uniqueHeads: heads.length, tail: tail.length };
  const exempt = ['excluded', 'admitted'].map(sessionId => queue.enqueue({ queue: 'synthetic-exempt', payload: { sessionId, kind: 'exempt', body } }));
  const selected = await writers[0].claimJobs({ method: 'dequeueExempt', args: ['synthetic-exempt', { path: '$.kind', equals: 'exempt' }, 5, [], ['excluded']] });
  assert.deepEqual(selected.map(job => job.id), [exempt[1].id]);
  assert.equal(queue.getJob(exempt[0].id)?.status, 'pending');
  assert(queue.complete(selected[0].id, {}, selected[0].claimToken));
  claims.exempt = { admitted: selected.length, excludedRetained: true };
} finally {
  await Promise.all(writers.map(writer => writer.close()));
  db.close();
  writeFileSync(join(resolve(process.argv[2]), 'evidence/dequeue.json'), JSON.stringify(claims, null, 2));
}
