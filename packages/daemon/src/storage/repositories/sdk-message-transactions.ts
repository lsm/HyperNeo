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
function sdkOp<A, R>(name: string, run: (args: A, deps: Dependencies) => R) {
  return defineDbOp({
    name: `sdk_messages.${name}`,
    mode: 'write',
    run: (db: Database, args: A, changes: ChangeRecorder) => {
      applySdkBodyWriteMode(db, args);
      return run(args, {
        db,
        changes,
        sdkMessageRepo: new SDKMessageRepository(db, sdkMessageChanges(db, changes, false)),
        jobQueue: new JobQueueRepository(db),
        saveFailed: (sessionId, message, origin) =>
          sdkMessageWrites.run(
            db,
            {
              method: 'saveUserMessage',
              args: [sessionId, message, 'failed', origin],
            },
            changes
          ) as string,
      });
    },
  });
}
export const sdkPromptEnsure = sdkOp('ensurePrompt', (args: Input<PersistPromptArgs>, deps) =>
  ensurePromptInTransaction({ ...sdkTransactionArgs(args), ...deps })
);
export const sdkPromptActivate = sdkOp(
  'activatePrompts',
  (args: Input<ActivatePromptsArgs>, deps) =>
    activatePromptsInTransaction({ ...sdkTransactionArgs(args), ...deps })
);
export const sdkPromptRetry = sdkOp('retryPrompt', (args: Input<RetryPromptArgs>, deps) =>
  retryPromptInTransaction({ ...sdkTransactionArgs(args), ...deps })
);
export const sdkNeoIntake = sdkOp(
  'neoIntake',
  (
    args: {
      ask: NeoConversationAskInput;
      message: Parameters<NeoConversationAskRepository['acceptPrompt']>[1];
      hold: PromptHold;
    },
    deps
  ) =>
    persistNeoIntakeTransaction(
      args.ask,
      args.message,
      args.hold,
      deps.db,
      new NeoConversationAskRepository(deps.db),
      deps.sdkMessageRepo,
      deps.jobQueue,
      (publish) => publish()
    )
);
export const sdkDeliveryTeardown = sdkOp(
  'teardown',
  (
    args: {
      sessionId: string;
      options?: Pick<MailboxCancelMaterializerDeps, 'preserveDeferred' | 'deliveries'>;
    },
    deps
  ) => {
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
  }
);
export const sdkMailboxFailure = sdkOp('mailboxFailure', (args: { job: Job }, deps) =>
  persistMailboxFailure(args.job, deps.sdkMessageRepo, deps.saveFailed, true)
);
export const sdkColumnBackfillChunk = sdkOp(
  'backfillColumns',
  (args: Parameters<typeof backfillSdkMessageColumnsChunk>[1], deps) =>
    backfillSdkMessageColumnsChunk(deps.db, args)
);
export const sdkColumnBackfillComplete = sdkOp('finishBackfill', (_args: undefined, { db }) => {
  db.prepare('INSERT OR IGNORE INTO migration_markers(key,applied_at) VALUES (?,?)').run(
    'sdk_message_columns_backfilled_v2',
    Date.now()
  );
  db.exec("DELETE FROM migration_markers WHERE key GLOB 'sdk_message_columns_backfill_v2:*'");
});
export const sdkDeliveryFencedStatus = sdkOp(
  'deliveryFencedStatus',
  (args: Parameters<JobQueueRepository['transitionDeliverySendStatusFenced']>[0], deps) =>
    deps.jobQueue.transitionDeliverySendStatusFenced(args)
);
export const SDK_MESSAGE_TRANSACTIONS = [
  sdkPromptEnsure,
  sdkPromptActivate,
  sdkPromptRetry,
  sdkNeoIntake,
  sdkDeliveryTeardown,
  sdkMailboxFailure,
  sdkColumnBackfillChunk,
  sdkColumnBackfillComplete,
  sdkDeliveryFencedStatus,
] as const;
