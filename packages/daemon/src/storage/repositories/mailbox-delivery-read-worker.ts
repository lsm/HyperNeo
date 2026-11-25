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

  admissionPayload(rowid: number): Record<string, unknown> | null {
    const row = this.db
      .prepare("SELECT payload FROM job_queue WHERE rowid = ? AND queue = 'mailbox'")
      .get(rowid) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
}

export const mailboxDeliveryReads = defineRepositoryOp(
  'mailbox.deliveryReads',
  'read',
  MailboxDeliveryReads,
  ['admissionRowid', 'admissionPayload']
);
