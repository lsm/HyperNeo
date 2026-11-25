import type { MessageOrigin } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { NeoConversationAskInput } from '@hyperneo/shared/types/neo-conversation-ask';
import {
  ensurePromptInTransaction,
  activatePromptsInTransaction,
  retryPromptInTransaction,
  type PersistPromptArgs,
  type ActivatePromptsArgs,
  type RetryPromptArgs,
  type PromptHold,
} from '../../lib/agent/message-delivery-outbox.ts';
import {
  cancelMailboxJobsStage,
  type MailboxCancelMaterializerDeps,
} from '../../lib/mailbox/cancellation.ts';
import { persistMailboxFailure } from '../../lib/mailbox/failure.ts';
import { defineDbOp, type ChangeRecorder } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { applySdkBodyWriteMode } from '../sdk-message-body-admission.ts';
import { backfillSdkMessageColumnsChunk } from '../schema/m413-sdk-message-columns.ts';
import { SDKMessageRepository } from './sdk-message-repository.ts';
import { JobQueueRepository, type Job } from './job-queue-repository.ts';
import {
  NeoConversationAskRepository,
  persistNeoIntakeTransaction,
} from './neo-conversation-ask-repository.ts';
import { sdkMessageChanges, sdkMessageWrites } from './sdk-message-writes.ts';
import { NeoWakeQueueRepository } from './neo-wake-queue-repository.ts';
import type { MailboxEntry } from '../../lib/mailbox/entry.ts';

const MAIN_ONLY = {
  db: true,
  sdkMessageRepo: true,
  jobQueue: true,
  canDeliver: true,
  publishStatusChanged: true,
  deferPostSaveSideEffects: true,
};
type Input<T> = Omit<T, keyof typeof MAIN_ONLY>;
export function sdkTransactionArgs<T extends object>(args: T): Input<T> {
  return Object.fromEntries(
    Object.entries(args).filter(([key]) => !Object.hasOwn(MAIN_ONLY, key))
  ) as Input<T>;
}
type Dependencies = {
  db: Database;
  changes: ChangeRecorder;
  sdkMessageRepo: SDKMessageRepository;
  jobQueue: JobQueueRepository;
  saveFailed: (sessionId: string, message: SDKUserMessage, origin?: MessageOrigin) => string;
};
function sdkDependencies(db: Database, changes: ChangeRecorder): Dependencies {
  return {
    db,
    changes,
    sdkMessageRepo: new SDKMessageRepository(db, sdkMessageChanges(db, changes, false)),
    jobQueue: new JobQueueRepository(db),
    saveFailed: (sessionId, message, origin) =>
      sdkMessageWrites.run(
        db,
        { method: 'saveUserMessage', args: [sessionId, message, 'failed', origin] },
        changes
      ) as string,
  };
}
export const sdkPromptEnsure = defineDbOp({
  name: 'sdk_messages.ensurePrompt',
  mode: 'write',
  run: (db: Database, args: Input<PersistPromptArgs>, changes: ChangeRecorder) => {
    applySdkBodyWriteMode(db, args);
    const deps = sdkDependencies(db, changes);
    return ensurePromptInTransaction({ ...sdkTransactionArgs(args), ...deps });
  },
});
export const sdkPromptActivate = defineDbOp({
  name: 'sdk_messages.activatePrompts',
  mode: 'write',
  run: (db: Database, args: Input<ActivatePromptsArgs>, changes: ChangeRecorder) => {
    applySdkBodyWriteMode(db, args);
    const deps = sdkDependencies(db, changes);
    const result = activatePromptsInTransaction({ ...sdkTransactionArgs(args), ...deps });
    if (result.activated.length)
      deps.changes.notifyChange('sdk_messages', { sessionId: args.sessionId });
    return result;
  },
});
export const sdkPromptRetry = defineDbOp({
  name: 'sdk_messages.retryPrompt',
  mode: 'write',
  run: (db: Database, args: Input<RetryPromptArgs>, changes: ChangeRecorder) => {
    applySdkBodyWriteMode(db, args);
    const deps = sdkDependencies(db, changes);
    return retryPromptInTransaction({ ...sdkTransactionArgs(args), ...deps });
  },
});
export const sdkNeoIntake = defineDbOp({
  name: 'sdk_messages.neoIntake',
  mode: 'write',
  run: (
    db: Database,
    args: {
      ask: NeoConversationAskInput;
      message: Parameters<NeoConversationAskRepository['acceptPrompt']>[1];
      hold: PromptHold;
    },
    changes: ChangeRecorder
  ) => {
    applySdkBodyWriteMode(db, args);
    const deps = sdkDependencies(db, changes);
    return persistNeoIntakeTransaction(
      args.ask,
      args.message,
      args.hold,
      deps.db,
      new NeoConversationAskRepository(deps.db),
      deps.sdkMessageRepo,
      deps.jobQueue,
      (publish) => publish()
    );
  },
});
export const sdkNeoWakeQueue = defineDbOp({
  name: 'sdk_messages.neoWakeQueue',
  mode: 'write',
  run: (
    db: Database,
    args: { prepare: [MailboxEntry, string, boolean] } | { flush: number },
    changes: ChangeRecorder
  ) => {
    applySdkBodyWriteMode(db, args);
    const deps = sdkDependencies(db, changes);
    const queue = new NeoWakeQueueRepository(deps.db);
    const options = { ...deps, hold: 'immediate' as const };
    if ('prepare' in args) return queue.prepare(...args.prepare, options);
    queue.flushDue(args.flush, options);
    return null;
  },
});
export const sdkDeliveryTeardown = defineDbOp({
  name: 'sdk_messages.teardown',
  mode: 'write',
  run: (
    db: Database,
    args: {
      sessionId: string;
      options?: Pick<MailboxCancelMaterializerDeps, 'preserveDeferred' | 'deliveries'>;
    },
    changes: ChangeRecorder
  ) => {
    applySdkBodyWriteMode(db, args);
    const deps = sdkDependencies(db, changes);
    const result = cancelMailboxJobsStage(
      {
        sessionId: args.sessionId,
        jobQueue: deps.jobQueue,
        sdkMessageRepo: deps.sdkMessageRepo,
        deleted: [],
        failedDbIds: [],
        deps: {
          ...args.options,
          db: {
            getDatabase: () => deps.db,
            getUserMessageIdsByStatus: deps.sdkMessageRepo.getUserMessageIdsByStatus.bind(
              deps.sdkMessageRepo
            ),
            notifyChange: (table, scope) => deps.changes.notifyChange(table, scope),
          },
        },
      },
      true
    );
    return { deleted: result.deleted, failedDbIds: result.failedDbIds };
  },
});
export const sdkMailboxFailure = defineDbOp({
  name: 'sdk_messages.mailboxFailure',
  mode: 'write',
  run: (db: Database, args: { job: Job }, changes: ChangeRecorder) => {
    applySdkBodyWriteMode(db, args);
    const deps = sdkDependencies(db, changes);
    const checkpoint = deps.changes.changes.length;
    try {
      const { failedId, uuidOwned } = deps.db.transaction(() =>
        persistMailboxFailure(args.job, deps.sdkMessageRepo, deps.saveFailed, true)
      )();
      return { failedId, uuidOwned, failure: undefined };
    } catch (error) {
      deps.changes.changes.splice(checkpoint);
      return {
        uuidOwned: Boolean((error as { uuidOwned?: boolean }).uuidOwned),
        failure: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
export const sdkColumnBackfillChunk = defineDbOp({
  name: 'sdk_messages.backfillColumns',
  mode: 'write',
  run: (
    db: Database,
    args: Parameters<typeof backfillSdkMessageColumnsChunk>[1],
    changes: ChangeRecorder
  ) => {
    applySdkBodyWriteMode(db, args);
    const deps = sdkDependencies(db, changes);
    return backfillSdkMessageColumnsChunk(deps.db, args);
  },
});
export const sdkColumnBackfillComplete = defineDbOp({
  name: 'sdk_messages.finishBackfill',
  mode: 'write',
  run: (db: Database, _args: undefined, changes: ChangeRecorder) => {
    applySdkBodyWriteMode(db, _args);
    sdkDependencies(db, changes);
    db.prepare('INSERT OR IGNORE INTO migration_markers(key,applied_at) VALUES (?,?)').run(
      'sdk_message_columns_backfilled_v2',
      Date.now()
    );
    db.exec("DELETE FROM migration_markers WHERE key GLOB 'sdk_message_columns_backfill_v2:*'");
  },
});
export const sdkDeliveryFencedStatus = defineDbOp({
  name: 'sdk_messages.deliveryFencedStatus',
  mode: 'write',
  run: (
    db: Database,
    args: Parameters<JobQueueRepository['transitionDeliverySendStatusFenced']>[0],
    changes: ChangeRecorder
  ) => {
    applySdkBodyWriteMode(db, args);
    const deps = sdkDependencies(db, changes);
    const result = deps.jobQueue.transitionDeliverySendStatusFencedSync(args);
    if (result.length) deps.changes.notifyChange('sdk_messages', { sessionId: args.sessionId });
    return result;
  },
});
export const sdkPendingRemoval = defineDbOp({
  name: 'sdk_messages.pendingRemoval',
  mode: 'write',
  run: (
    db: Database,
    args: {
      sessionId: string;
      messageDbId: string;
      mode: 'remove' | 'defer';
      expectedStatus?: 'deferred';
      withdrawalJobId?: string;
    },
    changes: ChangeRecorder
  ) => {
    applySdkBodyWriteMode(db, args);
    const deps = sdkDependencies(db, changes);
    const { sessionId, messageDbId } = args;
    const removed =
      args.mode === 'remove'
        ? deps.sdkMessageRepo.deletePendingUserMessage(sessionId, messageDbId, args.expectedStatus)
        : deps.sdkMessageRepo.deferEnqueuedUserMessage(sessionId, messageDbId);
    if (removed?.uuid) {
      deps.changes.notifyChange('sdk_messages', { sessionId });
      if (
        args.withdrawalJobId &&
        !deps.jobQueue.markDeadIfActive(args.withdrawalJobId, 'driver_input_withdrawn', [
          'dead',
          'completed',
        ])
      )
        throw new Error('Input withdrawal was superseded.');
      deps.jobQueue.cancelDelivery(sessionId, removed.uuid);
      deps.changes.notifyChange('job_queue', { sessionId });
    }
    return removed;
  },
});
