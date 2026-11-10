import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { DeadLetterImmediatelyError, type JobHandler } from '../../storage/job-queue-processor.ts';
import { parkDeliveryJob } from '../../storage/repositories/job-delivery-parking.ts';
import {
  type Job,
  type JobQueueRepository,
  jobQueueWrites,
} from '../../storage/repositories/job-queue-repository.ts';
import { routeDriveTurnOutcome } from '../agent/handler-outcome-routing.ts';
import type { HumanSendRoute } from '../agent/human-send-recovery.ts';
import {
  asMessageDeliveryPayload,
  type DeliveryLoadResult,
  type DeliveryOutcome,
  MESSAGE_DELIVERY_PARK_MS,
  type MessageDeliverySession,
  MessageDeliveryTerminalTurnError,
} from '../agent/message-delivery.ts';
import { type DeliveryMetrics, deliveryMetrics } from '../agent/message-delivery-metrics.ts';
import { Logger } from '../logger.ts';
import {
  decideParkAdmission,
  MESSAGE_DELIVERY_PARK_BUDGET,
  parkAdmissionInput,
} from './park-budget.ts';

export interface MessageDeliveryHandlerDeps {
  jobQueue: JobQueueRepository;
  getSession(sessionId: string): Promise<MessageDeliverySession | null>;
  getSessionCooldownRetryAt?(sessionId: string): number | null;
  getMessageContent(sessionId: string, messageUuid: string): DeliveryLoadResult | null;
  prepareContent?(loaded: DeliveryLoadResult, job: Job): Promise<DeliveryLoadResult>;
  isSessionArchived?(sessionId: string): boolean;
  markDeliveryFailed?(sessionId: string, messageUuid: string): Promise<string | null>;
  publishStatusChanged?(sessionId: string, messageIds: string[]): Promise<unknown>;
  prepareHumanSend?(sessionId: string): Promise<HumanSendRoute>;
  watchHumanSend?(sessionId: string, messageUuid: string): void;
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
    const park = async (runAt: number): Promise<boolean> => {
      const admission = decideParkAdmission(
        parkAdmissionInput(job, MESSAGE_DELIVERY_PARK_BUDGET, Date.now())
      );
      if ('reason' in admission) {
        throw new MessageDeliveryTerminalTurnError(
          `message_delivery park budget exhausted for ${payload.messageUuid}: ${admission.reason}`,
          'delivery_parked'
        );
      }
      return gatewayFor(deps.jobQueue.db).call(
        parkDeliveryJob,
        'park',
        job.id,
        runAt,
        job.claimToken
      );
    };

    const claimCurrent = () => deps.jobQueue.isClaimCurrent(job.id, job.claimToken);
    if (!claimCurrent()) return { outcome: 'stale_attempt' };

    if (deps.isSessionArchived?.(payload.sessionId)) {
      const flippedIds: string[] = [];
      const failedDbId =
        (await deps.markDeliveryFailed?.(payload.sessionId, payload.messageUuid)) ?? null;
      if (failedDbId) flippedIds.push(failedDbId);
      if (flippedIds.length > 0 && deps.publishStatusChanged) {
        void deps.publishStatusChanged(payload.sessionId, flippedIds).catch(() => {});
      }
      await (await deps.getSession(payload.sessionId))?.settleSkippedDelivery?.(
        payload.messageUuid
      );
      return { outcome: 'archived' };
    }

    const loaded = deps.getMessageContent(payload.sessionId, payload.messageUuid);
    const human =
      loaded?.inputKind === 'human' &&
      (loaded.sendStatus === 'enqueued' || loaded.sendStatus === 'submitted');
    const humanRoute = human ? await deps.prepareHumanSend?.(payload.sessionId) : undefined;
    if (humanRoute === 'wait') {
      if (!claimCurrent()) return { outcome: 'stale_attempt' };
      const retryAt = Date.now() + MESSAGE_DELIVERY_PARK_MS;
      const parked = await gatewayFor(deps.jobQueue.db).call(
        jobQueueWrites,
        'requeueWaiting',
        job.id,
        retryAt,
        job.claimToken as string
      );
      if (!parked) return { outcome: 'stale_attempt' };
      return { parked: 'no_network', retryAt };
    }
    const session = await deps.getSession(payload.sessionId);
    if (!session) {
      throw new Error(`message_delivery: session ${payload.sessionId} not found`);
    }
    const cooldownRetryAt = human
      ? null
      : (deps.getSessionCooldownRetryAt?.(payload.sessionId) ?? null);
    if (cooldownRetryAt !== null) {
      if (!claimCurrent()) return { outcome: 'stale_attempt' };
      const parked = await park(cooldownRetryAt);
      if (!parked) return { outcome: 'stale_attempt' };
      return { parked: 'rate_limit_cooldown', retryAt: cooldownRetryAt };
    }
    if (loaded === null) {
      log.warn(`message_delivery: content for ${payload.messageUuid} not found; completing.`);
      metrics.recordReclaimSkip('noContent');
      await session.settleSkippedDelivery?.(payload.messageUuid);
      return { outcome: 'no_content' };
    }

    const { sendStatus } = loaded;

    if (sendStatus === 'consumed') {
      if (loaded.inputKind === 'human')
        deps.watchHumanSend?.(payload.sessionId, payload.messageUuid);
      return { outcome: 'completed' };
    }
    if (sendStatus === 'deferred' || sendStatus === 'failed') {
      await session.settleSkippedDelivery?.(payload.messageUuid);
      return { outcome: 'skipped', sendStatus };
    }

    if (!claimCurrent()) return { outcome: 'stale_attempt' };
    const { content } = deps.prepareContent ? await deps.prepareContent(loaded, job) : loaded;
    let result: DeliveryOutcome;
    try {
      result = await session.driveDeliveryTurn(
        payload.messageUuid,
        content,
        payload.parentToolUseId,
        false,
        claimCurrent,
        signal,
        reportStage ? { reportStage } : undefined
      );
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Interrupted by user') throw error;
      if (!claimCurrent()) return { outcome: 'stale_attempt' };
      const retryAt = Date.now() + MESSAGE_DELIVERY_PARK_MS;
      const parked = await park(retryAt);
      if (!parked) return { outcome: 'stale_attempt' };
      return { parked: 'user_interrupt', retryAt };
    }
    const route = routeDriveTurnOutcome(result);
    if ('deadLetter' in route) {
      throw new DeadLetterImmediatelyError(route.deadLetter);
    }
    if (route.settleSkipped) {
      await session.settleSkippedDelivery?.(payload.messageUuid);
    }
    if (route.mutation === 'requeue' && route.retryAt !== undefined) {
      const parked =
        'parked' in route.result && route.result.parked === 'no_provider'
          ? await gatewayFor(deps.jobQueue.db).call(
              jobQueueWrites,
              'requeueWaiting',
              job.id,
              route.retryAt,
              job.claimToken as string
            )
          : await park(route.retryAt);
      if (!parked) return { outcome: 'stale_attempt' };
    }
    if (human && 'outcome' in route.result && route.result.outcome === 'completed')
      deps.watchHumanSend?.(payload.sessionId, payload.messageUuid);
    return route.result;
  };
}
