import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
