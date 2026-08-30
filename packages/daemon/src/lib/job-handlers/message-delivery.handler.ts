import { DeadLetterImmediatelyError, type JobHandler } from '../../storage/job-queue-processor.ts';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { routeDriveTurnOutcome } from '../agent/handler-outcome-routing.ts';
import {
  asMessageDeliveryPayload,
  type DeliveryLoadResult,
  type MessageDeliverySession,
} from '../agent/message-delivery.ts';
import { type DeliveryMetrics, deliveryMetrics } from '../agent/message-delivery-metrics.ts';
import { Logger } from '../logger.ts';

export interface MessageDeliveryHandlerDeps {
  jobQueue: JobQueueRepository;
  getSession(sessionId: string): Promise<MessageDeliverySession | null>;
  getSessionCooldownRetryAt?(sessionId: string): number | null;
  getMessageContent(sessionId: string, messageUuid: string): DeliveryLoadResult | null;
  isSessionArchived?(sessionId: string): boolean;
  markDeliveryFailed?(sessionId: string, messageUuid: string): string | null;
  publishStatusChanged?(sessionId: string, messageIds: string[]): Promise<unknown>;
  metrics?: DeliveryMetrics;
}

export function createMessageDeliveryHandler(deps: MessageDeliveryHandlerDeps): JobHandler {
  const log = new Logger('message-delivery.handler');
  const metrics: DeliveryMetrics = deps.metrics ?? deliveryMetrics;

  return async (job: Job, context): Promise<Record<string, unknown>> => {
    const signal = context?.signal;
    const reportStage = context?.reportStage;
    const payload = asMessageDeliveryPayload(job.payload);
    if (!payload) {
      throw new Error(`message_delivery: invalid payload ${JSON.stringify(job.payload)}`);
    }

    const claimCurrent = () => deps.jobQueue.isClaimCurrent(job.id, job.claimToken);
    if (!claimCurrent()) return { outcome: 'stale_attempt' };

    if (deps.isSessionArchived?.(payload.sessionId)) {
      const flippedIds: string[] = [];
      const failedDbId = deps.markDeliveryFailed?.(payload.sessionId, payload.messageUuid) ?? null;
      if (failedDbId) flippedIds.push(failedDbId);
      if (flippedIds.length > 0 && deps.publishStatusChanged) {
        void deps.publishStatusChanged(payload.sessionId, flippedIds).catch(() => {});
      }
      await (await deps.getSession(payload.sessionId))?.settleSkippedDelivery?.(
        payload.messageUuid
      );
      return { outcome: 'archived' };
    }

    const session = await deps.getSession(payload.sessionId);
    if (!session) {
      throw new Error(`message_delivery: session ${payload.sessionId} not found`);
    }
    const cooldownRetryAt = deps.getSessionCooldownRetryAt?.(payload.sessionId) ?? null;
    if (cooldownRetryAt !== null) {
      if (!claimCurrent()) return { outcome: 'stale_attempt' };
      deps.jobQueue.requeueParked(job.id, cooldownRetryAt, job.claimToken);
      return { parked: 'rate_limit_cooldown', retryAt: cooldownRetryAt };
    }
    const loaded = deps.getMessageContent(payload.sessionId, payload.messageUuid);
    if (loaded === null) {
      log.warn(`message_delivery: content for ${payload.messageUuid} not found; completing.`);
      metrics.recordReclaimSkip('noContent');
      await session.settleSkippedDelivery?.(payload.messageUuid);
      return { outcome: 'no_content' };
    }

    const { content, sendStatus } = loaded;

    if (sendStatus === 'consumed') {
      return { outcome: 'completed' };
    }
    if (sendStatus === 'deferred' || sendStatus === 'failed') {
      await session.settleSkippedDelivery?.(payload.messageUuid);
      return { outcome: 'skipped', sendStatus };
    }

    if (!claimCurrent()) return { outcome: 'stale_attempt' };
    const result = await session.driveDeliveryTurn(
      payload.messageUuid,
      content,
      payload.parentToolUseId,
      false,
      claimCurrent,
      signal,
      reportStage ? { reportStage } : undefined
    );
    const route = routeDriveTurnOutcome(result);
    if ('deadLetter' in route) {
      throw new DeadLetterImmediatelyError(route.deadLetter);
    }
    if (route.settleSkipped) {
      await session.settleSkippedDelivery?.(payload.messageUuid);
    }
    if (route.mutation === 'requeue' && route.retryAt !== undefined) {
      deps.jobQueue.requeue(job.id, route.retryAt, job.claimToken);
    }
    return route.result;
  };
}
