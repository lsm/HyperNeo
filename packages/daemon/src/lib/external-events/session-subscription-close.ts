import superpipe, { type PipelineAPI } from 'superpipe';
import type { SessionEventSubscription } from '../../storage/repositories/session-event-subscription-repository.ts';
import { externalEventTopicSuffix } from './event-tiers.ts';
import type { ExternalEventPublishedPayload } from './external-event-service.ts';
import { requireSessionScopedEvent, type SessionEventSkip } from './session-event-delivery.ts';
import type { ExternalEvent, ExternalEventRecord } from './types.ts';

export type ClosedPrSkip = SessionEventSkip | 'pr_not_closed' | 'no_pr_subscriptions';

export interface ClosedPr {
  owner: string;
  repo: string;
  prNumber: string;
}

export interface SessionSubscriptionCloseDeps {
  readEvent(eventId: string): ExternalEventRecord | null;
  listSubscriptions(): SessionEventSubscription[];
  removeSubscription(sessionId: string, topic: string): void;
}

type Gate<T> = { value: T } | { reason: ClosedPrSkip };

export function requireClosedPrEvent(found: {
  record: ExternalEventRecord | null;
}): Gate<ClosedPr> {
  const event: ExternalEvent | undefined = found.record?.event;
  if (!event) return { reason: 'event_missing' };
  const [source, owner, repo, resource, entity] = event.topic.split('/');
  const action = externalEventTopicSuffix(event.topic);
  const closed = action === 'closed' || (action === 'polled' && event.payload.state === 'closed');
  if (source !== 'github' || resource !== 'pull_request' || !closed || !owner || !repo)
    return { reason: 'pr_not_closed' };
  return { value: { owner, repo, prNumber: entity.split('.')[0] } };
}

export function isPrSubscription(pattern: string, pr: ClosedPr): boolean {
  const [source, owner, repo, resource, entity = ''] = pattern.split('/');
  return (
    source === 'github' &&
    owner?.toLowerCase() === pr.owner.toLowerCase() &&
    repo?.toLowerCase() === pr.repo.toLowerCase() &&
    resource === 'pull_request' &&
    entity.split('.')[0] === pr.prNumber
  );
}

export function planClosedPrUnsubscribes(
  pr: ClosedPr,
  subscribed: { subscriptions: readonly SessionEventSubscription[] }
): Gate<SessionEventSubscription[]> {
  const ending = subscribed.subscriptions.filter((subscription) =>
    isPrSubscription(subscription.topic, pr)
  );
  return ending.length > 0 ? { value: ending } : { reason: 'no_pr_subscriptions' };
}

export const endClosedPrSubscriptions = (
  superpipe({})('end-closed-pr-session-subscriptions') as PipelineAPI
)
  .input(['deps', 'payload'])
  .pipe(requireSessionScopedEvent, 'payload', 'result:ended')
  .pipe(
    (deps: SessionSubscriptionCloseDeps, payload: ExternalEventPublishedPayload) => ({
      record: deps.readEvent(payload.eventId),
    }),
    ['deps', 'payload'],
    'found'
  )
  .pipe(requireClosedPrEvent, 'found', 'result:ended')
  .pipe(
    (deps: SessionSubscriptionCloseDeps) => ({ subscriptions: deps.listSubscriptions() }),
    'deps',
    'subscribed'
  )
  .pipe(planClosedPrUnsubscribes, ['ended', 'subscribed'], 'result:ended')
  .pipe(
    (deps: SessionSubscriptionCloseDeps, ending: SessionEventSubscription[]) => {
      for (const subscription of ending)
        deps.removeSubscription(subscription.sessionId, subscription.topic);
    },
    ['deps', 'ended']
  )
  .endAsync('ended') as (
  deps: SessionSubscriptionCloseDeps,
  payload: ExternalEventPublishedPayload
) => Promise<SessionEventSubscription[] | ClosedPrSkip>;
