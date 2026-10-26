import { MAILBOX_EXPIRE_FIRE } from '../../lib/job-queue-constants.ts';
import { MAILBOX_LANE } from '../../lib/mailbox/enqueue.ts';
import { mailboxEntryExpired, parseMailboxEntry } from '../../lib/mailbox/entry.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { JobQueueRepository, type Job } from './job-queue-repository.ts';

export const MAILBOX_SCAN_PAGE_SIZE = 1000;
type Cursor = { createdAt: number; id: string };

function expiredMailboxJob(job: Job, now: number): boolean {
  const entry = parseMailboxEntry(job.payload);
  return entry !== null && mailboxEntryExpired(entry, now);
}

class MailboxExpiryRepository extends JobQueueRepository {
  candidates(now: number, after?: Cursor) {
    const page = this.listJobs({
      queue: MAILBOX_LANE,
      status: ['pending', 'processing'],
      limit: MAILBOX_SCAN_PAGE_SIZE,
      oldestFirst: true,
      after,
    });
    const last = page[page.length - 1];
    return {
      scanned: page.length,
      after: last ? { createdAt: last.createdAt, id: last.id } : undefined,
      candidates: page.filter((job) => expiredMailboxJob(job, now)).map((job) => job.id),
    };
  }

  expire(jobId: string, now: number): Job | null {
    const job = this.getJob(jobId);
    if (
      !job ||
      job.queue !== MAILBOX_LANE ||
      (job.status !== 'pending' && job.status !== 'processing') ||
      !expiredMailboxJob(job, now)
    )
      return null;
    return this.markDeadIfActive(jobId, 'mailbox: entry expired (ttl)');
  }

  schedule(runAt: number): void {
    this.enqueueUniquePending({
      queue: MAILBOX_EXPIRE_FIRE,
      payload: {},
      runAt,
      matchPayload: {},
      activeStatuses: ['pending'],
    });
  }
}

export const mailboxExpiryReads = defineRepositoryOp(
  'mailbox.expiry.read',
  'read',
  MailboxExpiryRepository,
  ['candidates']
);

export const mailboxExpiryWrites = defineRepositoryOp(
  'mailbox.expiry.write',
  'write',
  MailboxExpiryRepository,
  ['expire', 'schedule']
);
