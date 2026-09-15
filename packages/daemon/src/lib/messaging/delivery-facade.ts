import type { ActorResolver, RouteMessageResult } from '../../../../messaging/src/contracts.ts';
import type { ActorRef, DeliveryRecord, MessageRecord } from '../../../../messaging/src/types.ts';

export interface SpaceDeliveryFacadeConfig {
  resolver: ActorResolver;
  deliverToSession?: (
    actor: ActorRef,
    message: MessageRecord
  ) => Promise<string | null | undefined>;
  queueForActivation?: (
    actor: ActorRef,
    message: MessageRecord
  ) => Promise<string | null | undefined>;
}

export class SpaceDeliveryFacade {
  constructor(private readonly config: SpaceDeliveryFacadeConfig) {}

  async routeMessage(message: MessageRecord): Promise<RouteMessageResult> {
    const result = await this.config.resolver.resolveTargets(message);
    const deliveries: DeliveryRecord[] = [];

    for (const target of result.resolved) {
      const delivery = createDeliveryFromActor(message, target.targetRef, target.actor);
      if (target.actor.status === 'active' && this.config.deliverToSession) {
        try {
          const deliveredSessionId = await this.config.deliverToSession(target.actor, message);
          if (deliveredSessionId) {
            delivery.state = 'delivered';
            delivery.deliveredAt = Date.now();
            delivery.deliveredSessionId = deliveredSessionId;
          } else {
            delivery.state = 'failed';
            delivery.attemptCount += 1;
            delivery.lastError = 'Session delivery returned no delivered session';
          }
        } catch (error) {
          delivery.state = 'failed';
          delivery.attemptCount += 1;
          delivery.lastError = error instanceof Error ? error.message : String(error);
        }
      } else if (target.actor.status === 'inactive' && this.config.queueForActivation) {
        try {
          const deliveredSessionId = await this.config.queueForActivation(target.actor, message);
          if (deliveredSessionId) {
            delivery.state = 'delivered';
            delivery.deliveredAt = Date.now();
            delivery.deliveredSessionId = deliveredSessionId;
          } else {
            delivery.state = 'failed';
            delivery.attemptCount += 1;
            delivery.lastError = 'Activation delivery returned no delivered session';
          }
        } catch (error) {
          delivery.state = 'failed';
          delivery.attemptCount += 1;
          delivery.lastError = error instanceof Error ? error.message : String(error);
        }
      }
      deliveries.push(delivery);
    }

    const failedCounts = new Map<string, number>();
    for (const target of result.unresolved) {
      const occurrence = failedCounts.get(target.targetRef) ?? 0;
      failedCounts.set(target.targetRef, occurrence + 1);
      deliveries.push(createFailedDelivery(message, target.targetRef, target.reason, occurrence));
    }

    return { message, deliveries };
  }
}

function createDeliveryFromActor(
  message: MessageRecord,
  targetRef: string,
  actor: ActorRef
): DeliveryRecord {
  return {
    deliveryId: `delivery_${message.messageId}_${encodeURIComponent(targetRef)}_${encodeURIComponent(actor.actorId)}`,
    messageId: message.messageId,
    targetActorId: actor.actorId,
    targetRef,
    state: 'queued',
    attemptCount: 0,
    maxAttempts: 5,
    createdAt: Date.now(),
  };
}

function createFailedDelivery(
  message: MessageRecord,
  targetRef: string,
  lastError: string,
  occurrence = 0
): DeliveryRecord {
  const suffix = occurrence === 0 ? '' : `_${occurrence}`;
  return {
    deliveryId: `delivery_${message.messageId}_${encodeURIComponent(targetRef)}_failed${suffix}`,
    messageId: message.messageId,
    targetRef,
    state: 'failed',
    attemptCount: 0,
    maxAttempts: 0,
    createdAt: Date.now(),
    lastError,
  };
}
