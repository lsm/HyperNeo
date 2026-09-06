import type { MessageOrigin } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { Database } from '../../storage/database.ts';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { type MailboxFailureDeps, materializeMailboxFailure } from './failure.ts';

export interface MailboxCancelMaterializerDeps {
  db: Database;
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  settleSkipped?: (sessionId: string, messageUuid: string) => Promise<void> | void;
  preserveDeferred?: boolean;
}

function jobQueueSupportsMailboxCancel(
  jobQueue: JobQueueRepository | null | undefined
): jobQueue is JobQueueRepository & {
  cancelMailboxForSession(
    sessionId: string,
    opts?: { excludeDeferred?: boolean }
  ): Array<{ id: string; payload: string }>;
} {
  return jobQueue != null && typeof jobQueue.cancelMailboxForSession === 'function';
}

function deletedRowAsJob(id: string, payload: Record<string, unknown>): Job {
  return {
    id,
    queue: 'mailbox',
    status: 'dead',
    payload,
    result: null,
    error: 'cancelled by session abort',
    priority: 0,
    maxRetries: 0,
    retryCount: 0,
    runAt: 0,
    createdAt: 0,
    startedAt: null,
    heartbeatAt: null,
    completedAt: null,
    claimToken: null,
  } as Job;
}

export function materializeMailboxFailuresForSession(
  sessionId: string,
  deps: MailboxCancelMaterializerDeps
): string[] {
  const jobQueue = deps.db.getJobQueueRepo?.();
  if (!jobQueueSupportsMailboxCancel(jobQueue)) return [];
  const sdkMessageRepo = deps.db.getSDKMessageRepo?.();
  if (!sdkMessageRepo) return [];
  const failureDeps: MailboxFailureDeps = {
    sdkMessageRepo,
    saveFailed: (sid, message: SDKUserMessage, origin?: MessageOrigin) =>
      deps.db.saveUserMessage(sid, message, 'failed', origin),
    publishFailed: async (sid, dbMessageId: string) => {
      await deps.internalEventBus
        .publish('messages.statusChanged', {
          sessionId: sid,
          messageIds: [dbMessageId],
          status: 'failed',
        })
        .catch(() => {});
    },
    ...(deps.settleSkipped
      ? {
          settleSkipped: (sid: string, uuid: string) =>
            Promise.resolve(deps.settleSkipped?.(sid, uuid)),
        }
      : {}),
  };
  const cancelled: string[] = [];
  const deleted = jobQueue.cancelMailboxForSession(
    sessionId,
    deps.preserveDeferred === true ? { excludeDeferred: true } : undefined
  );
  for (const row of deleted) {
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      materializeMailboxFailure(deletedRowAsJob(row.id, payload), failureDeps);
      if (typeof payload.messageUuid === 'string') cancelled.push(payload.messageUuid);
    } catch {}
  }
  return cancelled;
}
