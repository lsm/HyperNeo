import type { MessageOrigin } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { ContextClearBoundaryOwner } from '../../../lib/agent/message-delivery.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../../storage/repositories/sdk-message-repository.ts';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import { handoffPromptToMailbox } from './prompt-mailbox-handoff.ts';

export type InjectionDeliveryStatus = 'enqueued' | 'deferred' | 'failed';

export interface InjectionDeliveryRowDeps {
  publishStatusChanged(
    sessionId: string,
    dbId: string,
    status: InjectionDeliveryStatus
  ): Promise<void>;
  saveUserMessage(
    sessionId: string,
    message: SDKUserMessage,
    sendStatus: 'enqueued' | 'deferred',
    origin?: MessageOrigin
  ): string;
  reopenDeliveryByUuid(sessionId: string, uuid: string): string | null;
  markDeliveryDeferredByUuid(sessionId: string, uuid: string): string | null;
}

export async function reopenFailedDeliveryRow(
  deps: InjectionDeliveryRowDeps,
  sessionId: string,
  messageId: string
): Promise<void> {
  const reopenedDbId = deps.reopenDeliveryByUuid(sessionId, messageId);
  if (reopenedDbId) {
    await deps.publishStatusChanged(sessionId, reopenedDbId, 'enqueued');
  }
}

export async function flipDeliveryRowToDeferred(
  deps: InjectionDeliveryRowDeps,
  sessionId: string,
  messageId: string
): Promise<string | null> {
  const flippedDbId = deps.markDeliveryDeferredByUuid(sessionId, messageId);
  if (flippedDbId) {
    await deps.publishStatusChanged(sessionId, flippedDbId, 'deferred');
  }
  return flippedDbId;
}

export interface SettleDeliveryRowStatusArgs {
  sessionId: string;
  message: SDKUserMessage;
  messageId: string;
  rowExists: boolean;
  status: 'enqueued' | 'deferred';
  origin?: MessageOrigin;
}

export async function settleDeliveryRowStatus(
  deps: InjectionDeliveryRowDeps,
  args: SettleDeliveryRowStatusArgs
): Promise<string> {
  const dbId = args.rowExists
    ? args.messageId
    : deps.saveUserMessage(args.sessionId, args.message, args.status, args.origin);
  await deps.publishStatusChanged(args.sessionId, dbId, args.status);
  return dbId;
}

export interface InjectionDeliveryTargetSession {
  stateManager?: {
    setQueuedIfIdle(messageId: string): Promise<boolean>;
  };
}

export interface InjectDeliveryBranchDeps extends InjectionDeliveryRowDeps {
  db: BunDatabase;
  sdkMessageRepo: SDKMessageRepository;
  jobQueue: JobQueueRepository;
}

export interface DeliverInjectedMessageArgs {
  session: InjectionDeliveryTargetSession;
  sessionId: string;
  messageId: string;
  sdkUserMessage: SDKUserMessage;
  origin?: MessageOrigin;
  boundaryOwner?: ContextClearBoundaryOwner;
}

export async function deliverInjectedMessage(
  deps: InjectDeliveryBranchDeps,
  args: DeliverInjectedMessageArgs
): Promise<string> {
  try {
    const outcome = await handoffPromptToMailbox({
      deps: {
        db: deps.db,
        sdkMessageRepo: deps.sdkMessageRepo,
        jobQueue: deps.jobQueue,
      },
      target: {
        sessionId: args.sessionId,
        messageId: args.messageId,
        message: args.sdkUserMessage,
        origin: 'space_inject',
        messageOrigin: args.origin,
      },
      stateManager: args.session.stateManager,
      publishStatusChanged: deps.publishStatusChanged,
    });
    if (outcome.state === 'stale') {
      throw new Error('prompt handoff went stale before reaching the mailbox');
    }
    return outcome.dbId;
  } finally {
    args.boundaryOwner?.release();
  }
}
