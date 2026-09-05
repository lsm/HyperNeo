import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { MAILBOX_LANE } from './enqueue.ts';
import { parseMailboxEntry } from './entry.ts';
import { decodeUlidTimestamp } from './ulid.ts';

export const MAILBOX_SCAN_PAGE_SIZE = 1000;

export async function expireMailboxEntries(deps: {
  jobQueue: JobQueueRepository;
  now?: number;
}): Promise<number> {
  const now = deps.now ?? Date.now();
  let expired = 0;
  let cursor: { createdAt: number; id: string } | undefined;
  for (;;) {
    const page = deps.jobQueue.listJobs({
      queue: MAILBOX_LANE,
      status: ['pending', 'processing'],
      limit: MAILBOX_SCAN_PAGE_SIZE,
      oldestFirst: true,
      after: cursor,
    });
    if (page.length === 0) return expired;
    const last = page[page.length - 1];
    cursor = { createdAt: last.createdAt, id: last.id };
    for (const job of page) {
      const entry = parseMailboxEntry(job.payload);
      if (entry === null) continue;
      if (now - decodeUlidTimestamp(entry.id) > entry.policy.ttlMs) {
        if (deps.jobQueue.markDeadIfActive(job.id, 'mailbox: entry expired (ttl)') !== null) {
          expired += 1;
        }
      }
    }
    if (page.length < MAILBOX_SCAN_PAGE_SIZE) return expired;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
