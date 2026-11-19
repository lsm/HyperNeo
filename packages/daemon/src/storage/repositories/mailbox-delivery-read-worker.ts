import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';

class MailboxDeliveryReads {
  constructor(private readonly db: Database) {}

  admissionRowid(jobId: string): number | undefined {
    const row = this.db.prepare('SELECT rowid AS rid FROM job_queue WHERE id = ?').get(jobId) as
      | { rid: number }
      | undefined;
    return row?.rid;
  }
}

export const mailboxDeliveryReads = defineRepositoryOp(
  'mailbox.deliveryReads',
  'read',
  MailboxDeliveryReads,
  ['admissionRowid']
);
