import { enqueueMailboxEntry } from '../../lib/mailbox/enqueue.ts';
import type { MailboxEntry } from '../../lib/mailbox/entry.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { JobQueueRepository } from './job-queue-repository.ts';

export const enqueueMailboxAdmission = defineDbOp({
  name: 'mailbox.enqueue',
  mode: 'write',
  run: (db: Database, entry: MailboxEntry) =>
    enqueueMailboxEntry(new JobQueueRepository(db), entry),
});
