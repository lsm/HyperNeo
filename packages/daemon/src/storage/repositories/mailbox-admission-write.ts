import { enqueueMailboxEntry } from '../../lib/mailbox/enqueue.ts';
import type { MailboxEntry } from '../../lib/mailbox/entry.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { JobQueueRepository } from './job-queue-repository.ts';

class MailboxAdmissionRepository {
  constructor(private readonly db: Database) {}

  enqueue(entry: MailboxEntry) {
    return enqueueMailboxEntry(new JobQueueRepository(this.db), entry);
  }
}

export const enqueueMailboxAdmission = defineRepositoryOp(
  'mailbox.enqueue',
  'write',
  MailboxAdmissionRepository,
  ['enqueue']
);
