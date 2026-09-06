import type { MessageOrigin } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { Database } from '../../storage/database.ts';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { materializeMailboxFailure, type MailboxFailureDeps } from './failure.ts';

export interface MailboxCancelMaterializerDeps {
  db: Database;
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  settleSkipped?: (sessionId: string, messageUuid: string) => Promise<void> | void;
  preserveDeferred?: boolean;
}

function jobQueueSupportsMailboxCancel(
  jobQueue: JobQueueRepository | null | undefined
): jobQueue is JobQueueRepository & {
  listMailboxJobsForSession(sessionId: string): Array<{ id: string; payload: string }>;
  cancelMailboxForSession(sessionId: string, opts?: { excludeDeferred?: boolean }): string[];
} {
  return (
    jobQueue != null &&
    typeof jobQueue.listMailboxJobsForSession === 'function' &&
    typeof jobQueue.cancelMailboxForSession === 'function'
  );
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
    saveFailed: (sid: string, message: SDKUserMessage, origin?: MessageOrigin) =>
      deps.db.saveUserMessage(sid, message, 'failed', origin),
    publishFailed: async (sid: string, dbMessageId: string) => {
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
  for (const row of jobQueue.listMailboxJobsForSession(sessionId)) {
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      if (deps.preserveDeferred === true && payload.deliveryMode === 'defer') continue;
      materializeMailboxFailure(
        {
          id: row.id,
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
        } as Job,
        failureDeps
      );
    } catch {}
  }
  return jobQueue.cancelMailboxForSession(
    sessionId,
    deps.preserveDeferred === true ? { excludeDeferred: true } : undefined
  );
}
