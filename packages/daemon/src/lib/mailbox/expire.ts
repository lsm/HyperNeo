import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import {
  MAILBOX_SCAN_PAGE_SIZE,
  mailboxExpiryReads,
  mailboxExpiryWrites,
} from '../../storage/repositories/mailbox-expiry-commands.ts';

export { MAILBOX_SCAN_PAGE_SIZE };

export async function expireMailboxEntries(deps: {
  jobQueue: JobQueueRepository;
  onExpired?: (job: Job) => void;
  now?: number;
}): Promise<number> {
  const now = deps.now ?? Date.now();
  const db = gatewayFor(deps.jobQueue.db);
  let expired = 0;
  let cursor: { createdAt: number; id: string } | undefined;
  for (;;) {
    const page = await db.call(mailboxExpiryReads, 'candidates', now, cursor);
    if (page.scanned === 0) return expired;
    cursor = page.after;
    for (const jobId of page.candidates) {
      const dead = await db.call(mailboxExpiryWrites, 'expire', jobId, now);
      if (dead !== null) {
        expired += 1;
        deps.onExpired?.(dead);
      }
    }
    if (page.scanned < MAILBOX_SCAN_PAGE_SIZE) return expired;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
