import type { MessageOrigin } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import {
  activatePrompts,
  ensurePrompt,
  retryPrompt,
} from '../../../lib/agent/message-delivery-outbox.ts';
import type {
  ContextClearBoundaryOwner,
  MessageDeliveryOrigin,
  MessageDeliveryRole,
} from '../../../lib/agent/message-delivery.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../../storage/repositories/sdk-message-repository.ts';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';

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
    getState(): { status: string };
  };
  getSessionData?: () => { config?: { provider?: string } };
}

export interface InjectDeliveryBranchDeps extends InjectionDeliveryRowDeps {
  db: BunDatabase;
  sdkMessageRepo: SDKMessageRepository;
  jobQueue: JobQueueRepository;
}

export interface MailboxHandoffArgs {
  db: BunDatabase;
  sdkMessageRepo: SDKMessageRepository;
  jobQueue: JobQueueRepository;
  sessionId: string;
  messageId: string;
  message: SDKUserMessage;
  origin: MessageDeliveryOrigin;
  existing?: { sendStatus: string } | null;
  publishEnqueued(sessionId: string, dbId: string): Promise<void>;
  setQueuedIfIdle?(messageId: string): Promise<boolean>;
}

export async function handoffPromptToMailbox(args: MailboxHandoffArgs): Promise<string> {
  const { db, sdkMessageRepo, jobQueue, sessionId, messageId, message, origin, existing } = args;
  let dbId: string;
  let role: MessageDeliveryRole | null;
  if (existing?.sendStatus === 'failed') {
    const retried = await retryPrompt({
      db,
      jobQueue,
      sdkMessageRepo,
      sessionId,
      messageUuid: messageId,
      origin,
    });
    if (retried === null) {
      throw new Error(`prompt handoff: no retryable failed row for ${sessionId}/${messageId}`);
    }
    dbId = retried.dbId;
    role = retried.role;
    await args.publishEnqueued(sessionId, dbId);
  } else if (existing?.sendStatus === 'deferred') {
    const { activated } = await activatePrompts({
      db,
      jobQueue,
      sessionId,
      messageUuids: [messageId],
      origin,
    });
    const entry = activated[0];
    if (!entry) {
      throw new Error(`prompt handoff: no activatable deferred row for ${sessionId}/${messageId}`);
    }
    dbId = entry.dbId;
    role = entry.role;
    await args.publishEnqueued(sessionId, dbId);
  } else {
    const ensured = ensurePrompt({
      db,
      sdkMessageRepo,
      jobQueue,
      sessionId,
      message,
      delivery: { origin },
    });
    dbId = ensured.dbMessageId;
    role = ensured.role;
    if (ensured.created) {
      await args.publishEnqueued(sessionId, dbId);
    }
  }
  if (role === 'turn') {
    try {
      await args.setQueuedIfIdle?.(messageId);
    } catch {}
  }
  return dbId;
}

export interface DeliverInjectedMessageArgs {
  session: InjectionDeliveryTargetSession;
  sessionId: string;
  messageId: string;
  sdkUserMessage: SDKUserMessage;
  existing?: { sendStatus: string } | null;
  origin?: MessageOrigin;
  boundaryOwner?: ContextClearBoundaryOwner;
}

export async function deliverInjectedMessage(
  deps: InjectDeliveryBranchDeps,
  args: DeliverInjectedMessageArgs
): Promise<string> {
  try {
    return await handoffPromptToMailbox({
      db: deps.db,
      sdkMessageRepo: deps.sdkMessageRepo,
      jobQueue: deps.jobQueue,
      sessionId: args.sessionId,
      messageId: args.messageId,
      message: args.sdkUserMessage,
      origin: 'space_inject',
      existing:
        args.existing ?? deps.sdkMessageRepo.getDeliveryContent(args.sessionId, args.messageId),
      publishEnqueued: (sessionId, dbId) => deps.publishStatusChanged(sessionId, dbId, 'enqueued'),
      setQueuedIfIdle: args.session.stateManager?.setQueuedIfIdle.bind(args.session.stateManager),
    });
  } finally {
    args.boundaryOwner?.release();
  }
}
