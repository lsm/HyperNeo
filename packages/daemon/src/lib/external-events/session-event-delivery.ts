import superpipe, { type PipelineAPI } from 'superpipe';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { SessionEventSubscription } from '../../storage/repositories/session-event-subscription-repository.ts';
import { renderAddress } from '../mailbox/address.ts';
import type { MailboxDeliveryMode } from '../mailbox/entry.ts';
import { handoffPromptToMailbox, type MailboxHandoffOutcome } from '../mailbox/handoff.ts';
import { externalEventTopicSuffix } from './event-tiers.ts';
import type { ExternalEventPublishedPayload } from './external-event-service.ts';
import { buildImmediateEventMessageUuid } from './immediate-delivery-pipeline.ts';
import { SESSION_EVENT_SCOPE } from './session-external-event-store.ts';
import { segmentMatches } from './topic-trie.ts';
import type { ExternalEvent, ExternalEventRecord } from './types.ts';

export const SESSION_EVENT_ORIGIN = 'external_event';

export type SessionEventSkip =
  | 'not_session_scope'
  | 'event_missing'
  | 'not_feedback'
  | 'no_subscribers';

export interface SessionEventDelivery {
  sessionId: string;
  messageUuid: string;
  text: string;
  mode: MailboxDeliveryMode;
}

export interface SessionEventDeliveryDeps {
  readEvent(eventId: string): ExternalEventRecord | null;
  listSubscriptions(): SessionEventSubscription[];
  isSessionBusy(sessionId: string): boolean;
  deliver(delivery: SessionEventDelivery): Promise<void>;
}

type Gate<T> = { value: T } | { reason: SessionEventSkip };
type FeedbackEvent = { event: ExternalEvent; urgent: boolean };

const SESSION_FEEDBACK_ACTION = /^(review_|comment_)/;

function payloadText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function topicMatchesPattern(pattern: string, topic: string): boolean {
  const want = pattern.toLowerCase().split('/');
  const have = topic.toLowerCase().split('/');
  return (
    want.length === have.length && want.every((segment, i) => segmentMatches(segment, have[i]))
  );
}

export function sessionEventHeadline(event: ExternalEvent): string {
  const action = externalEventTopicSuffix(event.topic)
    .replace(/_polled$/, '')
    .replaceAll('_', ' ');
  const prNumber = event.payload.prNumber;
  const title =
    payloadText(event.payload, 'title') ||
    (typeof prNumber === 'number' ? `PR #${prNumber} ${action}` : event.summary);
  const url = payloadText(event.payload, 'prUrl') || event.externalUrl || '';
  const actor = payloadText(event.payload, 'actor') || 'unknown';
  return [title, url, `by ${actor}`].filter(Boolean).join(' — ');
}

export function sessionEventText(event: ExternalEvent): string {
  const headline = sessionEventHeadline(event);
  return event.render ? `${headline}\n${event.render}` : headline;
}

export function requireSessionScopedEvent(
  payload: ExternalEventPublishedPayload
): Gate<ExternalEventPublishedPayload> {
  return payload.spaceId === SESSION_EVENT_SCOPE
    ? { value: payload }
    : { reason: 'not_session_scope' };
}

export function requireStoredSessionEvent(found: {
  record: ExternalEventRecord | null;
}): Gate<ExternalEvent> {
  return found.record ? { value: found.record.event } : { reason: 'event_missing' };
}

export function requireSessionFeedbackEvent(event: ExternalEvent): Gate<FeedbackEvent> {
  if (event.urgency === 'immediate') return { value: { event, urgent: true } };
  return SESSION_FEEDBACK_ACTION.test(externalEventTopicSuffix(event.topic))
    ? { value: { event, urgent: false } }
    : { reason: 'not_feedback' };
}

export function planSessionEventDeliveries(
  feedback: FeedbackEvent,
  subscribed: { subscriptions: readonly SessionEventSubscription[] },
  isSessionBusy: (sessionId: string) => boolean
): Gate<SessionEventDelivery[]> {
  const { event, urgent } = feedback;
  const sessionIds = [
    ...new Set(
      subscribed.subscriptions
        .filter((subscription) => topicMatchesPattern(subscription.topic, event.topic))
        .map((subscription) => subscription.sessionId)
    ),
  ];
  if (sessionIds.length === 0) return { reason: 'no_subscribers' };
  const text = sessionEventText(event);
  return {
    value: sessionIds.map((sessionId) => ({
      sessionId,
      messageUuid: buildImmediateEventMessageUuid(event.id, `session:${sessionId}`),
      text,
      mode: urgent || !isSessionBusy(sessionId) ? 'immediate' : 'defer',
    })),
  };
}

export const deliverSessionExternalEvent = (
  superpipe({})('deliver-session-external-event') as PipelineAPI
)
  .input(['deps', 'payload'])
  .pipe(requireSessionScopedEvent, 'payload', 'result:delivery')
  .pipe(
    (deps: SessionEventDeliveryDeps, payload: ExternalEventPublishedPayload) => ({
      record: deps.readEvent(payload.eventId),
    }),
    ['deps', 'payload'],
    'found'
  )
  .pipe(requireStoredSessionEvent, 'found', 'result:delivery')
  .pipe(requireSessionFeedbackEvent, 'delivery', 'result:delivery')
  .pipe(
    (deps: SessionEventDeliveryDeps) => ({ subscriptions: deps.listSubscriptions() }),
    'deps',
    'subscribed'
  )
  .pipe(
    (deps: SessionEventDeliveryDeps, feedback: FeedbackEvent, subscribed) =>
      planSessionEventDeliveries(feedback, subscribed, (id) => deps.isSessionBusy(id)),
    ['deps', 'delivery', 'subscribed'],
    'result:delivery'
  )
  .pipe(
    async (deps: SessionEventDeliveryDeps, deliveries: SessionEventDelivery[]) => {
      await Promise.all(deliveries.map((delivery) => deps.deliver(delivery)));
    },
    ['deps', 'delivery']
  )
  .endAsync('delivery') as (
  deps: SessionEventDeliveryDeps,
  payload: ExternalEventPublishedPayload
) => Promise<SessionEventDelivery[] | SessionEventSkip>;

export function mailSessionEvent(
  jobQueue: JobQueueRepository,
  delivery: SessionEventDelivery
): Promise<MailboxHandoffOutcome> {
  return handoffPromptToMailbox({
    to: renderAddress({ kind: 'session', sessionId: delivery.sessionId }),
    origin: SESSION_EVENT_ORIGIN,
    messageUuid: delivery.messageUuid,
    deliveryMode: delivery.mode,
    message: {
      type: 'user',
      message: { role: 'user', content: delivery.text },
      parent_tool_use_id: null,
      inputKind: 'system',
    },
    jobQueue,
  });
}
