import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { sessionEventText } from '../../../external-events/session-event-delivery.ts';
import { requireClosedPrEvent } from '../../../external-events/session-subscription-close.ts';
import { topicMatchesPattern } from '../../../external-events/topic-trie.ts';
import type { ExternalEvent } from '../../../external-events/types.ts';
import {
  buildPrEventTopicPattern,
  parseGitHubTopic,
  parsePrUrl,
} from '../../../github/parse-pr-url.ts';
import type {
  NeoCardPrSubscription,
  NeoCardPrSubscriptionRepository,
} from './neo-card-pr-subscription-repository.ts';
import type { NeoWorkPrRepository } from './neo-work-pr-repository.ts';

export interface NeoCardPrEventDeps {
  workPrs: Pick<NeoWorkPrRepository, 'get'>;
  subscriptions: NeoCardPrSubscriptionRepository;
  watchRepo(owner: string, repo: string): Promise<void>;
  sendToCard(workId: string, key: string, text: string): Promise<unknown>;
  warn(message: string, error: unknown): void;
}

export interface NeoCardPrEventRoute {
  workIds: string[];
  text: string;
  ending: NeoCardPrSubscription[];
}

export function neoCardPrTopics(prs: readonly NeoWorkPr[]): string[] {
  return prs.flatMap((pr) => {
    const parsed = pr.state === 'OPEN' ? parsePrUrl(pr.url) : null;
    if (!parsed || parsed.host.toLowerCase() !== 'github.com') return [];
    return [
      buildPrEventTopicPattern({
        ...parsed,
        owner: parsed.owner.toLowerCase(),
        repo: parsed.repo.toLowerCase(),
      }),
    ];
  });
}

export function planNeoCardPrEvent(
  event: ExternalEvent,
  subscriptions: readonly NeoCardPrSubscription[]
): { value: NeoCardPrEventRoute } | { reason: 'not_subscribed' } {
  const matched = subscriptions.filter((row) => topicMatchesPattern(row.topic, event.topic));
  if (!matched.length) return { reason: 'not_subscribed' };
  const closed = requireClosedPrEvent({
    record: { event, state: 'published', createdAt: 0, updatedAt: 0 },
  });
  return {
    value: {
      workIds: [...new Set(matched.map((row) => row.workId))],
      text: sessionEventText(event),
      ending: 'value' in closed ? matched : [],
    },
  };
}

export function subscribeNeoCardPrs(deps: NeoCardPrEventDeps, workId: string, now: number): void {
  for (const topic of neoCardPrTopics(deps.workPrs.get(workId)?.prs ?? [])) {
    if (!deps.subscriptions.subscribe(workId, topic, now)) continue;
    const repo = parseGitHubTopic(topic);
    if (repo)
      void deps
        .watchRepo(repo.owner, repo.repo)
        .catch((error) => deps.warn('Card pull request repository watch pending', error));
  }
}

export const routeNeoCardPrEvent = (superpipe({})('neo-card-pr-event') as PipelineAPI)
  .input(['deps', 'event'])
  .pipe(
    (deps: NeoCardPrEventDeps, event: ExternalEvent) =>
      planNeoCardPrEvent(event, deps.subscriptions.listActive()),
    ['deps', 'event'],
    'result:route'
  )
  .pipe(
    async (deps: NeoCardPrEventDeps, event: ExternalEvent, route: NeoCardPrEventRoute) => {
      for (const workId of route.workIds)
        await deps
          .sendToCard(workId, `neo-card-pr-event:${workId}:${event.id}`, route.text)
          .catch((error) => deps.warn('Card pull request event not delivered', error));
    },
    ['deps', 'event', 'route']
  )
  .pipe(
    (deps: NeoCardPrEventDeps, route: NeoCardPrEventRoute) => {
      for (const row of route.ending) deps.subscriptions.end(row.workId, row.topic, Date.now());
    },
    ['deps', 'route']
  )
  .endAsync('route') as (
  deps: NeoCardPrEventDeps,
  event: ExternalEvent
) => Promise<NeoCardPrEventRoute | 'not_subscribed'>;
