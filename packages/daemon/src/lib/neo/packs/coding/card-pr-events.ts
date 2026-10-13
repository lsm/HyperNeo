import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { externalEventTopicSuffix } from '../../../external-events/event-tiers.ts';
import { requireClosedPrEvent } from '../../../external-events/session-subscription-close.ts';
import { topicMatchesPattern } from '../../../external-events/topic-trie.ts';
import type { ExternalEvent } from '../../../external-events/types.ts';
import { buildPrEventTopicPattern, parsePrUrl } from '../../../github/parse-pr-url.ts';
import type { NeoCardEventSubscription, NeoPackEventRoute } from '../types.ts';

export function neoCardPrTopics(prs: readonly NeoWorkPr[]): string[] {
  return prs.flatMap((pr) => {
    const parsed = pr.state === 'OPEN' ? parsePrUrl(pr.url) : null;
    if (!parsed || parsed.host.toLowerCase() !== 'github.com') return [];
    return [buildPrEventTopicPattern(parsed)];
  });
}

export function routeNeoCardPrEvent(
  event: ExternalEvent,
  subscriptions: readonly NeoCardEventSubscription[]
): NeoPackEventRoute | null {
  const matched = subscriptions.filter(
    (row) => row.topic.startsWith('github/') && topicMatchesPattern(row.topic, event.topic)
  );
  if (!matched.length) return null;
  const closed =
    'value' in
    requireClosedPrEvent({ record: { event, state: 'published', createdAt: 0, updatedAt: 0 } });
  if (!closed && !isNeoCardPrActionable(externalEventTopicSuffix(event.topic))) return null;
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
