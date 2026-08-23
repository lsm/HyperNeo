import type { MessageContent, MessageOrigin } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import {
  awaitDeliveryConsumption,
  deliverAndMarkQueued,
  deliveryConsumptionTimeoutMs,
} from '../../../lib/agent/message-delivery';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository';

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
  markDeliveryFailedByUuid(sessionId: string, uuid: string): string | null;
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

export function failDeliveryRowInBackground(
  deps: InjectionDeliveryRowDeps,
  sessionId: string,
  messageId: string
): void {
  const failedDbId = deps.markDeliveryFailedByUuid(sessionId, messageId);
  if (failedDbId) {
    void deps.publishStatusChanged(sessionId, failedDbId, 'failed').catch(() => {});
  }
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
  ensureQueryStarted(): Promise<unknown>;
  messageQueue: {
    enqueueWithId(messageId: string, content: string | MessageContent[]): Promise<void>;
  };
}

export interface InjectDeliveryBranchDeps extends InjectionDeliveryRowDeps {
  jobQueue: JobQueueRepository;
}

export interface DeliverInjectedMessageArgs {
  session: InjectionDeliveryTargetSession;
  sessionId: string;
  messageId: string;
  sdkUserMessage: SDKUserMessage;
  enqueuePayload: string | MessageContent[];
  deliveryV2Enabled: boolean;
  rowExists: boolean;
  origin?: MessageOrigin;
}

export async function deliverInjectedMessage(
  deps: InjectDeliveryBranchDeps,
  args: DeliverInjectedMessageArgs
): Promise<string> {
  if (args.deliveryV2Enabled) {
    const dbId = await settleDeliveryRowStatus(deps, {
      sessionId: args.sessionId,
      message: args.sdkUserMessage,
      messageId: args.messageId,
      rowExists: args.rowExists,
      status: 'enqueued',
      origin: args.origin,
    });
    await awaitDeliveryConsumption({
      sessionId: args.sessionId,
      messageUuid: args.messageId,
      timeoutMs: deliveryConsumptionTimeoutMs(args.session.getSessionData?.().config?.provider),
      deliver: () =>
        deliverAndMarkQueued({
          jobQueue: deps.jobQueue,
          stateManager: args.session.stateManager,
          sessionId: args.sessionId,
          messageUuid: args.messageId,
          origin: 'space_inject',
          onEnqueueFailure: () => {
            failDeliveryRowInBackground(deps, args.sessionId, args.messageId);
          },
        }),
      ...(!args.rowExists
        ? {
            terminalizeOnTimeout: () => {
              failDeliveryRowInBackground(deps, args.sessionId, args.messageId);
            },
          }
        : {}),
    });
    return dbId;
  }
  await args.session.ensureQueryStarted();
  const dbId = await settleDeliveryRowStatus(deps, {
    sessionId: args.sessionId,
    message: args.sdkUserMessage,
    messageId: args.messageId,
    rowExists: false,
    status: 'enqueued',
    origin: args.origin,
  });
  await args.session.messageQueue.enqueueWithId(args.messageId, args.enqueuePayload);
  return dbId;
}
