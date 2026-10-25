import { createHash } from 'node:crypto';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { SessionEventSubscription } from '../../storage/repositories/session-event-subscription-repository.ts';
import { canonicalJson } from '../agent/prompt-comparison.ts';
import { enqueueMailboxEntry } from '../mailbox/enqueue.ts';
import { createMailboxEntry, type MailboxDeliveryMode } from '../mailbox/entry.ts';
import { crashHandler, type MailboxHandoffOutcome } from '../mailbox/handoff.ts';
import { externalEventTopicSuffix } from './event-tiers.ts';
import type { ExternalEventPublishedPayload } from './external-event-service.ts';
import { buildImmediateEventMessageUuid } from './immediate-delivery-pipeline.ts';
import { SESSION_EVENT_SCOPE } from './session-external-event-store.ts';
import { topicMatchesPattern } from './topic-trie.ts';
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

export async function mailSessionEvent(
  jobQueue: JobQueueRepository,
  delivery: SessionEventDelivery
): Promise<MailboxHandoffOutcome> {
  const args = {
    to: { kind: 'session' as const, sessionId: delivery.sessionId },
    origin: SESSION_EVENT_ORIGIN,
    messageUuid: delivery.messageUuid,
    deliveryMode: delivery.mode,
    message: {
      type: 'user' as const,
      message: { role: 'user' as const, content: delivery.text },
      parent_tool_use_id: null,
      inputKind: 'system' as const,
      neoWakeEvent: true,
    },
  };
  const digest = (value: unknown) =>
    createHash('sha256').update(canonicalJson(value)).digest('hex');
  const key = digest([SESSION_EVENT_ORIGIN, args.to, delivery.messageUuid]);
  const fingerprint = digest([args.to, args.origin, args.messageUuid, args.message]);
  try {
    return jobQueue.commitSubmissionReceipt(key, fingerprint, () => {
      const outcome = enqueueMailboxEntry(jobQueue, createMailboxEntry(args));
      if (outcome.kind === 'rejected') throw new Error(outcome.reason);
      return outcome;
    });
  } catch (error) {
    return crashHandler(error);
  }
}
