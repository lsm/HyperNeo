import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import {
  awaitDeliveryConsumptionTolerant,
  deliverAndMarkQueued,
  deliveryConsumptionTimeoutMs,
  type MessageDeliveryOrigin,
  withSessionResetCoordination,
} from '../../agent/message-delivery.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';

export type SpaceAgentInjectionOutcome = { delivered: boolean; messageId: string };

export interface SpaceAgentDeliveryDeps {
  sdkMessageRepo: {
    getDeliveryContent(
      sessionId: string,
      uuid: string
    ): { content: string | Array<{ type: string }>; sendStatus: string } | null;
    reopenDeliveryByUuid(sessionId: string, uuid: string): string | null;
    markDeliveryFailedByUuid(sessionId: string, uuid: string): string | null;
  };
  saveUserMessage(sessionId: string, message: SDKUserMessage, status: 'enqueued'): string;
  publishStatusChanged(
    sessionId: string,
    dbId: string,
    status: 'enqueued' | 'failed'
  ): Promise<void>;
  jobQueue: JobQueueRepository;
  stateManager?: {
    setQueuedIfIdle(messageId: string): Promise<boolean>;
    getState(): { status: string };
  };
}

export interface SpaceAgentDeliveryArgs {
  sessionId: string;
  messageId: string;
  sdkUserMessage: SDKUserMessage;
  provider?: string;
  origin?: MessageDeliveryOrigin;
}

export async function deliverSpaceAgentMessage(
  deps: SpaceAgentDeliveryDeps,
  args: SpaceAgentDeliveryArgs
): Promise<SpaceAgentInjectionOutcome> {
  const { sessionId, messageId } = args;
  const existing = deps.sdkMessageRepo.getDeliveryContent(sessionId, messageId);
  if (existing?.sendStatus === 'consumed') {
    return { delivered: true, messageId };
  }
  if (!existing) {
    const dbId = deps.saveUserMessage(sessionId, args.sdkUserMessage, 'enqueued');
    await deps.publishStatusChanged(sessionId, dbId, 'enqueued');
  } else if (existing.sendStatus === 'failed') {
    const reopenedDbId = deps.sdkMessageRepo.reopenDeliveryByUuid(sessionId, messageId);
    if (reopenedDbId) {
      await deps.publishStatusChanged(sessionId, reopenedDbId, 'enqueued');
    }
  }

  const failDelivery = (): void => {
    const failedDbId = deps.sdkMessageRepo.markDeliveryFailedByUuid(sessionId, messageId);
    if (failedDbId) {
      void deps.publishStatusChanged(sessionId, failedDbId, 'failed').catch(() => {});
    }
  };

  const outcome = await awaitDeliveryConsumptionTolerant({
    sessionId,
    messageUuid: messageId,
    timeoutMs: deliveryConsumptionTimeoutMs(args.provider),
    deliver: () =>
      withSessionResetCoordination(sessionId, async () =>
        deliverAndMarkQueued({
          jobQueue: deps.jobQueue,
          stateManager: deps.stateManager,
          sessionId,
          messageUuid: messageId,
          origin: args.origin ?? 'space_agent',
          onEnqueueFailure: failDelivery,
        })
      ),
  });
  return { delivered: outcome.consumed, messageId };
}
