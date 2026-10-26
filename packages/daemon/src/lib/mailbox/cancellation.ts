import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { sdkDeliveryTeardown } from '../../storage/repositories/sdk-message-transactions.ts';
import { ChangeRecorder } from '../../storage/db-gateway/db-op.ts';
import { sdkMessageWrites } from '../../storage/repositories/sdk-message-writes.ts';
import type { MessageOrigin } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../storage/repositories/sdk-message-repository.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import {
  createMailboxSenderNotifier,
  type MailboxFailureDeps,
  persistMailboxFailure,
  notifyFailureObserversStage,
  notifyFailureSenderStage,
  type MailboxFailureState,
} from './failure.ts';

export interface MailboxCancelMaterializerDeps {
  db: Database;
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  settleSkipped?: (sessionId: string, messageUuid: string) => Promise<void> | void;
  preserveDeferred?: boolean;
  deliveries?: { failEnqueued: boolean; failDeferred: boolean };
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
  deleted: Array<{ id: string; payload: string; failure?: MailboxFailureState }>;
  failedDbIds: string[];
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

export function persistSessionDeliveryTeardown(
  sessionId: string,
  jobQueue: JobQueueRepository,
  messages: SDKMessageRepository,
  getRows: Database['getUserMessageIdsByStatus'] | undefined,
  options: Pick<MailboxCancelMaterializerDeps, 'preserveDeferred' | 'deliveries'> = {},
  saveFailed?: Parameters<typeof persistMailboxFailure>[2],
  strict = false
): Pick<MailboxCancelCtx, 'deleted' | 'failedDbIds'> {
  const deleted = jobQueue
    .cancelMailboxForSession(
      sessionId,
      options.preserveDeferred === true ? { excludeDeferred: true } : undefined
    )
    .map((row) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        return row;
      }
      try {
        return {
          ...row,
          failure: persistMailboxFailure(
            deletedRowAsJob(row.id, payload),
            messages,
            saveFailed,
            strict
          ),
        };
      } catch (error) {
        if (strict) throw error;
        return row;
      }
    });
  const failedDbIds: string[] = [];
  const fail = (uuids: Array<string | undefined>) => {
    for (const uuid of uuids) {
      if (!uuid) continue;
      const id = messages.markDeliveryFailedByUuid(sessionId, uuid);
      if (id) failedDbIds.push(id);
    }
  };
  if (options.deliveries) {
    const uuids = jobQueue.cancelForSessionWithMessages(sessionId);
    fail(uuids);
    const cancelled = new Set(uuids);
    if (options.deliveries.failEnqueued)
      fail(
        (getRows?.(sessionId, 'enqueued') ?? [])
          .filter((row) => !row.uuid || !cancelled.has(row.uuid))
          .map((row) => row.uuid)
      );
    if (options.deliveries.failDeferred)
      fail((getRows?.(sessionId, 'deferred') ?? []).map((row) => row.uuid));
  }
  return { deleted, failedDbIds };
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

type MailboxPersistenceContext = Pick<
  MailboxCancelCtx,
  'sessionId' | 'jobQueue' | 'sdkMessageRepo'
> & {
  deps: Pick<MailboxCancelMaterializerDeps, 'preserveDeferred' | 'deliveries'> & {
    db: Pick<Database, 'getDatabase' | 'getUserMessageIdsByStatus' | 'notifyChange'>;
  };
};

export function cancelMailboxJobsStage<T extends MailboxPersistenceContext>(
  ctx: T,
  strict = false
) {
  if (ctx.jobQueue === null || ctx.sdkMessageRepo === null) return ctx;
  return {
    ...ctx,
    ...persistSessionDeliveryTeardown(
      ctx.sessionId,
      ctx.jobQueue,
      ctx.sdkMessageRepo,
      ctx.deps.db.getUserMessageIdsByStatus?.bind(ctx.deps.db),
      ctx.deps,
      (sessionId, message, origin) => {
        const changes = new ChangeRecorder();
        const id = sdkMessageWrites.run(
          ctx.deps.db.getDatabase(),
          {
            method: 'saveUserMessage',
            args: [sessionId, message, 'failed', origin],
          },
          changes
        ) as string;
        for (const change of changes.changes)
          ctx.deps.db.notifyChange?.(change.table, change.scope);
        return id;
      },
      strict
    ),
  };
}

async function routeMailboxTeardown(ctx: MailboxCancelCtx): Promise<MailboxCancelCtx> {
  const { preserveDeferred, deliveries } = ctx.deps;
  const result = await gatewayFor(ctx.deps.db.getDatabase()).run(sdkDeliveryTeardown, {
    sessionId: ctx.sessionId,
    options: { preserveDeferred, deliveries },
  });
  return { ...ctx, ...result };
}

export async function materializeCancelledEntriesStage(
  ctx: MailboxCancelCtx
): Promise<MailboxCancelCtx> {
  const jobQueue = ctx.jobQueue;
  const sdkMessageRepo = ctx.sdkMessageRepo;
  if (jobQueue === null || sdkMessageRepo === null) return ctx;
  const failureDeps: MailboxFailureDeps = {
    sdkMessageRepo,
    notifySender: createMailboxSenderNotifier(jobQueue),
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
      if (!row.failure) continue;
      const failure = { ...row.failure, deps: failureDeps };
      notifyFailureObserversStage(failure);
      notifyFailureSenderStage(failure);
      if (failure.target) cancelled.push(failure.target.messageUuid);
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
  .pipe(routeMailboxTeardown, 'ctx', 'ctx')
  .pipe(materializeCancelledEntriesStage, 'ctx', 'ctx')
  .endAsync('ctx') as (ctx: MailboxCancelCtx) => Promise<MailboxCancelCtx>;

export async function materializeMailboxFailuresForSession(
  sessionId: string,
  deps: MailboxCancelMaterializerDeps
): Promise<string[]> {
  const ctx = await runCancelMailboxForSession({
    sessionId,
    deps,
    jobQueue: null,
    sdkMessageRepo: null,
    deleted: [],
    failedDbIds: [],
    cancelled: [],
  });
  return ctx.cancelled;
}

export async function teardownSessionDeliveries(
  sessionId: string,
  deps: MailboxCancelMaterializerDeps,
  deliveries = { failEnqueued: false, failDeferred: true }
): Promise<string[]> {
  const ctx = await runCancelMailboxForSession({
    sessionId,
    deps: { ...deps, deliveries },
    jobQueue: null,
    sdkMessageRepo: null,
    deleted: [],
    failedDbIds: [],
    cancelled: [],
  });
  return ctx.failedDbIds;
}
