import { enqueueMailboxEntry } from '../../lib/mailbox/enqueue.ts';
import { createMailboxEntry } from '../../lib/mailbox/entry.ts';
import type { MailboxHandoffOutcome } from '../../lib/mailbox/handoff.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { JobQueueRepository } from './job-queue-repository.ts';

class SessionEventSubmissionRepository {
  constructor(private readonly db: Database) {}

  submit(input: {
    key: string;
    fingerprint: string;
    entryArgs: Parameters<typeof createMailboxEntry>[0];
  }): MailboxHandoffOutcome {
    const jobs = new JobQueueRepository(this.db);
    const prior = jobs.submissionReceipt<MailboxHandoffOutcome>(input.key, input.fingerprint);
    if (prior !== null) return prior;
    const outcome = enqueueMailboxEntry(jobs, createMailboxEntry(input.entryArgs));
    if (outcome.kind === 'rejected') throw new Error(outcome.reason);
    jobs.recordSubmissionReceipt(input.key, input.fingerprint, outcome);
    return outcome;
  }
}

export const submitSessionEvent = defineRepositoryOp(
  'mailbox.submitSessionEvent',
  'write',
  SessionEventSubmissionRepository,
  ['submit']
);
