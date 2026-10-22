import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { externalEventTopicSuffix } from '../../../external-events/event-tiers.ts';
import { requireClosedPrEvent } from '../../../external-events/session-subscription-close.ts';
import { topicMatchesPattern } from '../../../external-events/topic-trie.ts';
import type { ExternalEvent } from '../../../external-events/types.ts';
import { pullRequestUrlOfTopic } from '../../../github/parse-pr-url.ts';
import type { NeoCardEventSubscription, NeoPackEventRoute } from '../../pack-contract.ts';

function isNeoCardPrEventCurrent(
  read: { pr: NeoWorkPr; readAt: number } | null,
  event: ExternalEvent
): boolean {
  if (!read) return true;
  const head = event.payload.headSha ?? event.payload.commitId;
  return (
    read.pr.state === 'OPEN' &&
    (typeof head !== 'string' ||
      !read.pr.head ||
      read.readAt < event.occurredAt ||
      head === read.pr.head)
  );
}

export function routeNeoCardPrEvent(
  event: ExternalEvent,
  subscriptions: readonly NeoCardEventSubscription[],
  prOf: (url: string) => { pr: NeoWorkPr; readAt: number } | null
): NeoPackEventRoute | null {
  const matched = subscriptions.filter(
    (row) => row.topic.startsWith('github/') && topicMatchesPattern(row.topic, event.topic)
  );
  if (!matched.length) return null;
  if (
    /^(review_|comment_)/.test(externalEventTopicSuffix(event.topic)) &&
    typeof event.payload.body === 'string' &&
    /(?:^|\n)_🤖 Addressed by \[(?:Claude Code|Codex)\]\(https:\/\/(?:claude\.com\/claude-code|(?:chatgpt\.com|openai\.com)\/codex)\)_\s*$/.test(
      event.payload.body
    )
  )
    return null;
  const closed =
    'value' in
    requireClosedPrEvent({ record: { event, state: 'published', createdAt: 0, updatedAt: 0 } });
  if (!closed && !isNeoCardPrActionable(externalEventTopicSuffix(event.topic))) return null;
  if (!closed && !isNeoCardPrEventCurrent(prOf(pullRequestUrlOfTopic(event.topic) ?? ''), event))
    return null;
  return {
    workIds: [...new Set(matched.map((row) => row.workId))],
    ending: closed ? matched : [],
  };
}

const NEO_CARD_PR_ACTIONABLE =
  /^(review_|comment_|reaction_)|^(check|suite)_failed$|^status_(failure|error)$|^merge_conflict$/;

export function isNeoCardPrActionable(action: string): boolean {
  return NEO_CARD_PR_ACTIONABLE.test(action);
}
