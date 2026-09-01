import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { MAILBOX_LANE } from './enqueue.ts';
import { parseMailboxEntry } from './entry.ts';
import { decodeUlidTimestamp } from './ulid.ts';

const MAILBOX_SCAN_LIMIT = 1000;

export async function expireMailboxEntries(deps: {
  jobQueue: JobQueueRepository;
  now?: number;
}): Promise<number> {
  const now = deps.now ?? Date.now();
  const jobs = deps.jobQueue.listJobs({
    queue: MAILBOX_LANE,
    status: ['pending', 'processing'],
    limit: MAILBOX_SCAN_LIMIT,
  });
  let expired = 0;
  for (const job of jobs) {
    const entry = parseMailboxEntry(job.payload);
    if (entry === null) continue;
    if (now - decodeUlidTimestamp(entry.id) > entry.policy.ttlMs) {
      if (deps.jobQueue.markDead(job.id, 'mailbox: entry expired (ttl)') !== null) {
        expired += 1;
      }
    }
  }
  return expired;
}
