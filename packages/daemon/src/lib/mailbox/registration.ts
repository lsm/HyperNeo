import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import type { JobQueueProcessor } from '../../storage/job-queue-processor.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { createMailboxExpireHandler } from '../job-handlers/mailbox-expire.handler.ts';
import { MAILBOX_EXPIRE_FIRE } from '../job-queue-constants.ts';
import type { SessionManager } from '../session-manager.ts';
import {
  createMailboxDeferredReplayScheduler,
  type MailboxDeferredReplayScheduler,
  type MailboxDeferredReplaySchedulerDeps,
} from './deferred-replay-scheduler.ts';
import { createMailboxDeliveryHandler, type MailboxDeliveryDeps } from './delivery.ts';
import { MAILBOX_LANE } from './enqueue.ts';
import {
  createMailboxDeadHandler,
  materializeMailboxFailure,
  type MailboxFailureDeps,
} from './failure.ts';

interface MailboxRegistrationDeps {
  jobQueue: JobQueueRepository;
  jobProcessor: Pick<JobQueueProcessor, 'register'>;
  mailboxExpireProcessor: Pick<JobQueueProcessor, 'register'>;
  db: Pick<Database, 'getDatabase' | 'getSDKMessageRepo' | 'saveUserMessage'>;
  internalEventBus: MailboxDeferredReplaySchedulerDeps['internalEventBus'];
  sessionManager: Pick<
    SessionManager,
    'getCachedSession' | 'setMailboxDeferredReplaySuppressor'
  > | null;
  isSessionHeldByTaskLimit: (sessionId: string) => boolean;
  getSession: MailboxDeliveryDeps['getSession'];
  isSessionArchived: MailboxDeliveryDeps['isSessionArchived'];
  logError: (message: string) => void;
}

function createReplayScheduler(deps: MailboxRegistrationDeps): MailboxDeferredReplayScheduler {
  return createMailboxDeferredReplayScheduler({
    internalEventBus: deps.internalEventBus,
    sessionManager: deps.sessionManager,
    isSessionHeldByTaskLimit: deps.isSessionHeldByTaskLimit,
  });
}

function attachReplaySuppressor(
  deps: MailboxRegistrationDeps,
  scheduler: MailboxDeferredReplayScheduler
): void {
  deps.sessionManager?.setMailboxDeferredReplaySuppressor((sessionId) =>
    scheduler.cancel(sessionId)
  );
}

function createFailureDeps(deps: MailboxRegistrationDeps): MailboxFailureDeps {
  return {
    sdkMessageRepo: deps.db.getSDKMessageRepo(),
    saveFailed: (sessionId, message, origin) =>
      deps.db.saveUserMessage(sessionId, message, 'failed', origin),
    publishFailed: async (sessionId, dbMessageId) => {
      await deps.internalEventBus
        .publish('messages.statusChanged', {
          sessionId,
          messageIds: [dbMessageId],
          status: 'failed',
        })
        .catch(() => {});
    },
    settleSkipped: (sessionId, messageUuid) =>
      deps.sessionManager?.getCachedSession(sessionId)?.settleSkippedDelivery(messageUuid) ??
      Promise.resolve(),
  };
}

function registerExpiration(deps: MailboxRegistrationDeps, failure: MailboxFailureDeps): void {
  deps.mailboxExpireProcessor.register(
    MAILBOX_EXPIRE_FIRE,
    createMailboxExpireHandler(deps.jobQueue, (job) => materializeMailboxFailure(job, failure))
  );
}

function registerDelivery(
  deps: MailboxRegistrationDeps,
  scheduler: MailboxDeferredReplayScheduler,
  failure: MailboxFailureDeps
): void {
  deps.jobProcessor.register(
    MAILBOX_LANE,
    createMailboxDeliveryHandler({
      jobQueue: deps.jobQueue,
      db: deps.db.getDatabase(),
      sdkMessageRepo: deps.db.getSDKMessageRepo(),
      getSession: deps.getSession,
      isSessionArchived: deps.isSessionArchived,
      publishStatusChanged: (sessionId, dbId, status) => {
        void deps.internalEventBus
          .publish('messages.statusChanged', { sessionId, messageIds: [dbId], status })
          .catch(() => {});
      },
      scheduleDeferredReplay: (sessionId) => {
        scheduler.schedule(sessionId);
      },
      publishDeferredStatus: async (sessionId, dbMessageId) => {
        await deps.internalEventBus
          .publish('messages.statusChanged', {
            sessionId,
            messageIds: [dbMessageId],
            status: 'deferred',
          })
          .catch(() => {});
      },
      publishFailed: failure.publishFailed,
    }),
    {
      dequeueMode: { kind: 'session-fifo', sessionIdPath: '$.to.sessionId' },
      onDead: createMailboxDeadHandler(deps.logError, failure),
    }
  );
}

const runRegisterMailboxJobs = (superpipe()('register-mailbox-jobs') as PipelineAPI)
  .input(['deps'])
  .pipe(createReplayScheduler, 'deps', 'scheduler')
  .pipe(attachReplaySuppressor, ['deps', 'scheduler'])
  .pipe(createFailureDeps, 'deps', 'failure')
  .pipe(registerExpiration, ['deps', 'failure'])
  .pipe(registerDelivery, ['deps', 'scheduler', 'failure'])
  .end('scheduler') as (deps: MailboxRegistrationDeps) => MailboxDeferredReplayScheduler;

export function registerMailboxJobs(deps: MailboxRegistrationDeps): MailboxDeferredReplayScheduler {
  return runRegisterMailboxJobs(deps);
}
