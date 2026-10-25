import { sessionUnavailable } from '../../lib/session-resolution/session-lookup.ts';
import { SessionRepository } from './session-repository.ts';
import { SessionScheduleRepository } from './session-schedule-repository.ts';
import { SDKMessageRepository } from './sdk-message-repository.ts';
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

  enqueueScheduled(
    entry: MailboxEntry,
    metadata: { scheduleId: string; sourceKind: string; sourceId: string }
  ): 'target_gone' | 'duplicate' | 'enqueued' {
    if (entry.to.kind !== 'session' || !entry.messageUuid)
      throw new Error('Scheduled wake requires a session and message identity');
    const sessionId = entry.to.sessionId;
    const session = new SessionRepository(this.db).getSession(sessionId);
    if (!session || sessionUnavailable(session.status)) return 'target_gone';
    const queue = new JobQueueRepository(this.db);
    if (
      new SDKMessageRepository(this.db).findMessageIdByUuid(sessionId, entry.messageUuid) ||
      queue.listActiveByPayload('mailbox', {
        'to.sessionId': sessionId,
        messageUuid: entry.messageUuid,
      }).length
    )
      return 'duplicate';
    new SessionScheduleRepository(this.db).recordWake(
      sessionId,
      entry.messageUuid,
      metadata,
      Date.now()
    );
    const sent = this.enqueue(entry);
    if (sent.kind === 'rejected') throw new Error(sent.reason);
    return 'enqueued';
  }
}

export const enqueueMailboxAdmission = defineRepositoryOp(
  'mailbox.enqueue',
  'write',
  MailboxAdmissionRepository,
  ['enqueue', 'enqueueScheduled']
);
