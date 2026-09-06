import type { MessageOrigin } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../storage/repositories/sdk-message-repository.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { parseMailboxEntry } from './entry.ts';
import {
  type MailboxFailureDeps,
  materializeMailboxFailure,
  sessionFailureTarget,
} from './failure.ts';

export interface MailboxCancelMaterializerDeps {
  db: Database;
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  settleSkipped?: (sessionId: string, messageUuid: string) => Promise<void> | void;
  preserveDeferred?: boolean;
}

type MailboxCancellingJobQueue = JobQueueRepository & {
  cancelMailboxForSession(
    sessionId: string,
    opts?: { excludeDeferred?: boolean }
  ): Array<{ id: string; payload: string }>;
};

export interface MailboxCancelCtx {
  sessionId: string;
  deps: MailboxCancelMaterializerDeps;
  jobQueue: MailboxCancellingJobQueue | null;
  sdkMessageRepo: SDKMessageRepository | null;
  deleted: Array<{ id: string; payload: string }>;
  cancelled: string[];
}

function jobQueueSupportsMailboxCancel(
  jobQueue: JobQueueRepository | null | undefined
): jobQueue is MailboxCancellingJobQueue {
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

export function resolveCancelMailboxReposStage(ctx: MailboxCancelCtx): MailboxCancelCtx {
  const jobQueue = ctx.deps.db.getJobQueueRepo?.() ?? null;
  return {
    ...ctx,
    jobQueue: jobQueueSupportsMailboxCancel(jobQueue) ? jobQueue : null,
    sdkMessageRepo: ctx.deps.db.getSDKMessageRepo?.() ?? null,
  };
}

function cancelUnsupported(ctx: MailboxCancelCtx): boolean {
  return ctx.jobQueue === null || ctx.sdkMessageRepo === null;
}

export function cancelMailboxJobsStage(ctx: MailboxCancelCtx): MailboxCancelCtx {
  if (ctx.jobQueue === null) return ctx;
  return {
    ...ctx,
    deleted: ctx.jobQueue.cancelMailboxForSession(
      ctx.sessionId,
      ctx.deps.preserveDeferred === true ? { excludeDeferred: true } : undefined
    ),
  };
}

export function materializeCancelledEntriesStage(ctx: MailboxCancelCtx): MailboxCancelCtx {
  const jobQueue = ctx.jobQueue;
  const sdkMessageRepo = ctx.sdkMessageRepo;
  if (jobQueue === null || sdkMessageRepo === null) return ctx;
  const failureDeps: MailboxFailureDeps = {
    sdkMessageRepo,
    saveFailed: (sid, message: SDKUserMessage, origin?: MessageOrigin) =>
      ctx.deps.db.saveUserMessage(sid, message, 'failed', origin),
    publishFailed: async (sid, dbMessageId: string) => {
      await ctx.deps.internalEventBus
        .publish('messages.statusChanged', {
          sessionId: sid,
          messageIds: [dbMessageId],
          status: 'failed',
        })
        .catch(() => {});
    },
    ...(ctx.deps.settleSkipped
      ? {
          settleSkipped: (sid: string, uuid: string) =>
            Promise.resolve(ctx.deps.settleSkipped?.(sid, uuid)),
        }
      : {}),
  };
  const cancelled: string[] = [];
  for (const row of ctx.deleted) {
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const target = sessionFailureTarget(parseMailboxEntry(payload));
      materializeMailboxFailure(deletedRowAsJob(row.id, payload), failureDeps);
      if (target) cancelled.push(target.messageUuid);
    } catch {}
  }
  return { ...ctx, cancelled };
}

const runCancelMailboxForSession = (
  superpipe<{ cancelUnsupported: (ctx: MailboxCancelCtx) => boolean }>({
    cancelUnsupported,
  })('cancel-mailbox-for-session') as PipelineAPI
)
  .input(['ctx'])
  .pipe(resolveCancelMailboxReposStage, 'ctx', 'ctx')
  .pipe('!cancelUnsupported', 'ctx')
  .pipe(cancelMailboxJobsStage, 'ctx', 'ctx')
  .pipe(materializeCancelledEntriesStage, 'ctx', 'ctx')
  .end('ctx') as (ctx: MailboxCancelCtx) => MailboxCancelCtx;

export function materializeMailboxFailuresForSession(
  sessionId: string,
  deps: MailboxCancelMaterializerDeps
): string[] {
  return runCancelMailboxForSession({
    sessionId,
    deps,
    jobQueue: null,
    sdkMessageRepo: null,
    deleted: [],
    cancelled: [],
  }).cancelled;
}
