import type { SessionEventSubscription } from '../../storage/repositories/session-event-subscription-repository.ts';
import { parseGitHubTopic } from '../github/parse-pr-url.ts';
import type { SessionEventSkip } from './session-event-delivery.ts';
import type { ExternalEvent, ExternalEventRecord } from './types.ts';

export type ClosedPrSkip = SessionEventSkip | 'pr_not_closed' | 'no_pr_subscriptions';

export interface ClosedPr {
  owner: string;
  repo: string;
  prNumber: string;
}

type Gate<T> = { value: T } | { reason: ClosedPrSkip };

export function requireClosedPrEvent(found: {
  record: ExternalEventRecord | null;
}): Gate<ClosedPr> {
  const event: ExternalEvent | undefined = found.record?.event;
  if (!event) return { reason: 'event_missing' };
  const topic = parseGitHubTopic(event.topic);
  const action = topic?.action;
  const closed =
    action === 'closed' ||
    ((action === 'polled' || event.payload.eventType === 'pull_request') &&
      event.payload.state === 'closed');
  if (!topic || topic.resource !== 'pull_request' || !closed) return { reason: 'pr_not_closed' };
  return { value: { owner: topic.owner, repo: topic.repo, prNumber: topic.entity } };
}

export function isPrSubscription(pattern: string, pr: ClosedPr): boolean {
  const topic = parseGitHubTopic(pattern);
  return (
    !!topic &&
    topic.owner.toLowerCase() === pr.owner.toLowerCase() &&
    topic.repo.toLowerCase() === pr.repo.toLowerCase() &&
    topic.resource === 'pull_request' &&
    topic.entity === pr.prNumber
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
