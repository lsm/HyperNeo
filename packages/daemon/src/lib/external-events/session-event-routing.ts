import superpipe, { type PipelineAPI } from 'superpipe';
import type { SessionEventSubscription } from '../../storage/repositories/session-event-subscription-repository.ts';
import type { ExternalEventPublishedPayload } from './external-event-service.ts';
import {
  planSessionEventDeliveries,
  requireSessionFeedbackEvent,
  requireSessionScopedEvent,
  type SessionEventDelivery,
  type SessionEventDeliveryDeps,
} from './session-event-delivery.ts';
import { planClosedPrUnsubscribes, requireClosedPrEvent } from './session-subscription-close.ts';
import type { ExternalEventRecord } from './types.ts';

export type SessionEventRouteSkip = 'not_session_scope' | 'event_missing' | 'nothing_to_route';

export interface SessionEventRouteDeps extends SessionEventDeliveryDeps {
  removeSubscription(sessionId: string, topic: string): void;
  isTopicCovered(sessionId: string, topic: string): boolean;
}

export interface SessionEventRoute {
  deliveries: SessionEventDelivery[];
  ending: SessionEventSubscription[];
}

function valueOr<T>(gate: { value: T } | { reason: unknown }, fallback: T): T {
  return 'value' in gate ? gate.value : fallback;
}

export function planSessionEventRoute(
  found: { record: ExternalEventRecord | null },
  subscribed: { subscriptions: readonly SessionEventSubscription[] },
  isSessionBusy: (sessionId: string) => boolean,
  isTopicCovered: (sessionId: string, topic: string) => boolean = () => false
): { value: SessionEventRoute } | { reason: Exclude<SessionEventRouteSkip, 'not_session_scope'> } {
  const event = found.record?.event;
  if (!event) return { reason: 'event_missing' };
  const closed = requireClosedPrEvent(found);
  const ending = (
    'value' in closed ? valueOr(planClosedPrUnsubscribes(closed.value, subscribed), []) : []
  ).filter((subscription) => !isTopicCovered(subscription.sessionId, event.topic));
  const feedback =
    'value' in closed ? { value: { event, urgent: true } } : requireSessionFeedbackEvent(event);
  const uncovered = {
    subscriptions: [
      ...subscribed.subscriptions.filter(
        (subscription) => !isTopicCovered(subscription.sessionId, event.topic)
      ),
      ...ending.map((subscription) => ({ ...subscription, topic: event.topic })),
    ],
  };
  const deliveries =
    'value' in feedback
      ? valueOr(planSessionEventDeliveries(feedback.value, uncovered, isSessionBusy), [])
      : [];
  return deliveries.length > 0 || ending.length > 0
    ? { value: { deliveries, ending } }
    : { reason: 'nothing_to_route' };
}

export const routeSessionExternalEvent = (
  superpipe({})('route-session-external-event') as PipelineAPI
)
  .input(['deps', 'payload'])
  .pipe(requireSessionScopedEvent, 'payload', 'result:routed')
  .pipe(
    (deps: SessionEventRouteDeps, payload: ExternalEventPublishedPayload) => ({
      record: deps.readEvent(payload.eventId),
    }),
    ['deps', 'payload'],
    'found'
  )
  .pipe(
    (deps: SessionEventRouteDeps) => ({ subscriptions: deps.listSubscriptions() }),
    'deps',
    'subscribed'
  )
  .pipe(
    (deps: SessionEventRouteDeps, found: { record: ExternalEventRecord | null }, subscribed) =>
      planSessionEventRoute(
        found,
        subscribed,
        (id) => deps.isSessionBusy(id),
        (id, topic) => deps.isTopicCovered(id, topic)
      ),
    ['deps', 'found', 'subscribed'],
    'result:routed'
  )
  .pipe(
    async (deps: SessionEventRouteDeps, route: SessionEventRoute) => {
      await Promise.all(route.deliveries.map((delivery) => deps.deliver(delivery)));
    },
    ['deps', 'routed']
  )
  .pipe(
    (deps: SessionEventRouteDeps, route: SessionEventRoute) => {
      for (const subscription of route.ending)
        deps.removeSubscription(subscription.sessionId, subscription.topic);
    },
    ['deps', 'routed']
  )
  .endAsync('routed') as (
  deps: SessionEventRouteDeps,
  payload: ExternalEventPublishedPayload
) => Promise<SessionEventRoute | SessionEventRouteSkip>;
