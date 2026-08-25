import { DeadLetterImmediatelyError, type JobHandler } from '../../storage/job-queue-processor.ts';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import {
  routeDriveTurnOutcome,
  routeFeedSteerOutcome,
  routeSteerPromoteFallback,
} from '../agent/handler-outcome-routing.ts';
import {
  asMessageDeliveryPayload,
  buildBatchedDeliveryContent,
  type DeliveryLoadResult,
  flattenDeliveryText,
  MAX_ACP_STEER_PARKS,
  MESSAGE_DELIVERY_PARK_MS,
  type MessageDeliverySession,
} from '../agent/message-delivery.ts';
import { type DeliveryMetrics, deliveryMetrics } from '../agent/message-delivery-metrics.ts';
import { Logger } from '../logger.ts';

export interface MessageDeliveryHandlerDeps {
  jobQueue: JobQueueRepository;
  getSession(sessionId: string): MessageDeliverySession | null;
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
      for (const uuid of new Set([payload.messageUuid, ...(payload.batchUuids ?? [])])) {
        const dbId = deps.markDeliveryFailed?.(payload.sessionId, uuid) ?? null;
        if (dbId) flippedIds.push(dbId);
      }
      if (flippedIds.length > 0 && deps.publishStatusChanged) {
        void deps.publishStatusChanged(payload.sessionId, flippedIds).catch(() => {});
      }
      await deps.getSession(payload.sessionId)?.settleSkippedDelivery?.(payload.messageUuid);
      return { outcome: 'archived' };
    }

    const session = deps.getSession(payload.sessionId);
    if (!session) {
      throw new Error(`message_delivery: session ${payload.sessionId} not found`);
    }
    const loaded = deps.getMessageContent(payload.sessionId, payload.messageUuid);
    if (loaded === null) {
      log.warn(`message_delivery: content for ${payload.messageUuid} not found; completing.`);
      metrics.recordReclaimSkip('noContent');
      await session.settleSkippedDelivery?.(payload.messageUuid);
      return { outcome: 'no_content' };
    }
    const { content, sendStatus } = loaded;

    if (sendStatus === 'consumed') metrics.recordReclaimSkip('alreadyConsumed');
    else if (sendStatus === 'submitted') metrics.recordReclaimSkip('alreadySubmitted');

    if (sendStatus === 'submitted' && payload.role === 'steer') {
      if (deps.jobQueue.getParkCount(job.id) >= MAX_ACP_STEER_PARKS) {
        throw new DeadLetterImmediatelyError(
          'ACP steer awaited acceptance past its budget — subprocess never accepted'
        );
      }
      const retryAt = Date.now() + MESSAGE_DELIVERY_PARK_MS;
      deps.jobQueue.requeueParked(job.id, retryAt, job.claimToken);
      return { parked: 'acp_awaiting_acceptance', retryAt };
    }
    if (sendStatus === 'deferred' || sendStatus === 'failed' || sendStatus === 'submitted') {
      await session.settleSkippedDelivery?.(payload.messageUuid);
      return { outcome: 'skipped', sendStatus };
    }
    const alreadyConsumed = sendStatus === 'consumed';

    let turnContent = content;
    if (payload.role === 'turn' && payload.batchUuids && payload.batchUuids.length > 1) {
      const texts: string[] = [];
      for (const uuid of payload.batchUuids) {
        const member =
          uuid === payload.messageUuid ? loaded : deps.getMessageContent(payload.sessionId, uuid);
        if (!member) continue;
        if (member.sendStatus === 'deferred' || member.sendStatus === 'failed') continue;
        const text = flattenDeliveryText(member.content);
        if (text === null) continue;
        texts.push(text);
      }
      if (texts.length > 1) {
        turnContent = buildBatchedDeliveryContent(texts);
      }
    }

    if (payload.role === 'turn') {
      if (!claimCurrent()) return { outcome: 'stale_attempt' };
      const turn = session.driveDeliveryTurn(
        payload.messageUuid,
        turnContent,
        payload.parentToolUseId,
        alreadyConsumed,
        claimCurrent,
        payload.batchUuids,
        signal,
        reportStage ? { reportStage } : undefined
      );
      const result = await turn;
      const route = routeDriveTurnOutcome(result);
      if ('deadLetter' in route) {
        throw new DeadLetterImmediatelyError(route.deadLetter);
      }
      if (route.reclaimSkip) {
        metrics.recordReclaimSkip(route.reclaimSkip);
      }
      if (route.settleSkipped) {
        await session.settleSkippedDelivery?.(payload.messageUuid);
      }
      if (route.mutation === 'requeue' && route.retryAt !== undefined) {
        deps.jobQueue.requeue(job.id, route.retryAt, job.claimToken);
      }
      return route.result;
    }

    if (alreadyConsumed) {
      return { outcome: 'already_consumed' };
    }

    if (!claimCurrent()) return { outcome: 'stale_attempt' };
    const result = await session.feedDeliverySteer(
      payload.messageUuid,
      content,
      payload.parentToolUseId,
      claimCurrent,
      signal,
      reportStage ? { reportStage } : undefined
    );
    const needsParkBudget = result.outcome === 'park' || result.outcome === 'awaiting_acceptance';
    const route = routeFeedSteerOutcome(result, {
      parkCount: needsParkBudget ? deps.jobQueue.getParkCount(job.id) : 0,
      waitingForInput: result.outcome === 'park' ? (session.isWaitingForInput?.() ?? false) : false,
      now: Date.now(),
    });
    if ('deadLetter' in route) {
      throw new DeadLetterImmediatelyError(route.deadLetter);
    }
    if (route.settleSkipped) {
      await session.settleSkippedDelivery?.(payload.messageUuid);
    }
    if (route.mutation === 'requeue' && route.retryAt !== undefined) {
      deps.jobQueue.requeue(job.id, route.retryAt, job.claimToken);
    } else if (route.mutation === 'requeueParked' && route.retryAt !== undefined) {
      deps.jobQueue.requeueParked(job.id, route.retryAt, job.claimToken);
    } else if (route.mutation === 'requeueAs') {
      try {
        deps.jobQueue.requeueAs(
          job.id,
          route.requeueRole ?? 'turn',
          route.retryAt ?? Date.now(),
          job.claimToken
        );
        return route.result;
      } catch (err) {
        const fallback = routeSteerPromoteFallback(err, { now: Date.now() });
        if (!fallback) throw err;
        if ('deadLetter' in fallback) {
          throw new DeadLetterImmediatelyError(fallback.deadLetter);
        }
        deps.jobQueue.requeueAs(
          job.id,
          fallback.requeueRole ?? 'steer',
          fallback.retryAt ?? Date.now(),
          job.claimToken
        );
        return fallback.result;
      }
    }
    return route.result;
  };
}
