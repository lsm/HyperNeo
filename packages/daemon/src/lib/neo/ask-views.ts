import type {
  NeoAsk,
  NeoAskAnswer,
  NeoAskSessionView,
  NeoAskStatus,
  NeoAskView,
  NeoCardGroup,
  NeoCardView,
  NeoWorkPrReceipt,
} from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';

const NEO_ASK_SUMMARY_LIMIT = 160;

const askScenes: Record<NeoAskStatus, { group: NeoCardGroup; label: string }> = {
  open: { group: 'running', label: 'Working on it' },
  waiting: { group: 'attention', label: 'Waiting on you' },
  blocked: { group: 'attention', label: 'Blocked · needs you' },
  achieved: { group: 'outcomes', label: 'Done' },
  abandoned: { group: 'outcomes', label: 'Dropped' },
};

const dropped = (card: NeoCardView) =>
  card.phase === 'cancelled' || (card.phase === 'failed' && card.superseded);

type AskViewIndex = {
  cards: Map<string, NeoCardView>;
  merged: Map<string, string[]>;
  sessions: ReadonlyMap<string, readonly NeoAskSessionView[]>;
};

export function indexNeoAskViewParts(
  cards: readonly NeoCardView[],
  prs: readonly NeoWorkPrReceipt[],
  sessions: ReadonlyMap<string, readonly NeoAskSessionView[]> = new Map()
): AskViewIndex {
  return {
    sessions,
    cards: new Map(cards.map((card) => [card.workId, card])),
    merged: new Map(
      prs.map((receipt) => [
        receipt.workId,
        receipt.prs
          .filter((pr) => pr.state === 'MERGED')
          .map((pr) => `#${pr.url.split('/').pop() ?? pr.url}`),
      ])
    ),
  };
}

export function neoAskViewSummary(
  ask: NeoAsk,
  live: readonly NeoCardView[],
  merged: ReadonlyMap<string, string[]>
): string | null {
  const outcome = ask.outcome?.trim() || null;
  if (!outcome || outcome.length <= NEO_ASK_SUMMARY_LIMIT) return outcome;
  const numbers = [...new Set(live.flatMap((card) => merged.get(card.workId) ?? []))];
  if (ask.status === 'achieved' && numbers.length > 0) return `Merged in ${numbers.join(', ')}.`;
  const sentence = outcome.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? outcome;
  return sentence.length <= NEO_ASK_SUMMARY_LIMIT
    ? sentence
    : `${sentence.slice(0, NEO_ASK_SUMMARY_LIMIT - 1).trimEnd()}…`;
}

export function neoAskAnswer(ask: NeoAsk): NeoAskAnswer | null {
  if (ask.status === 'achieved' || ask.status === 'abandoned') return null;
  const items = (ask.doneItems ?? []).filter((item) => !item.removed && item.state === 'needs_you');
  const item = items.find((entry) => entry.id === ask.waitingItem) ?? items[0];
  return item
    ? {
        itemId: item.id,
        question: item.text,
        label: 'Answer in chat',
        options: item.options ?? [],
        ...(item.action ? { action: item.action } : {}),
        ...(item.kind ? { kind: item.kind } : {}),
      }
    : null;
}

export function describeNeoAskView(ask: NeoAsk, index: AskViewIndex): NeoAskView {
  const truth = askScenes[ask.status];
  const settled = truth.group === 'outcomes';
  const scenes = ask.workIds.flatMap((id) => {
    const card = index.cards.get(id);
    return card && !card.hidden ? [card] : [];
  });
  const live = scenes.filter((card) => !dropped(card));
  const sessions = settled ? [] : [...(index.sessions.get(ask.id) ?? [])];
  const needsYou =
    !settled &&
    (live.some((card) => card.group === 'attention') ||
      sessions.some((session) => session.kind !== null));
  const doneWorkIds = live
    .filter((card) => (card.phase === 'reported' || card.phase === 'merged') && !card.pr?.setback)
    .map((card) => card.workId);
  const counted = (ask.doneItems ?? []).filter((item) => !item.removed);
  return {
    askId: ask.id,
    group: needsYou ? 'attention' : truth.group,
    label: needsYou ? 'Needs you' : truth.label,
    settled,
    needsYou,
    done: counted.length
      ? counted.filter((item) => item.state === 'met').length
      : doneWorkIds.length,
    total: counted.length
      ? counted.length
      : Math.max(ask.workIds.length, scenes.length) - (scenes.length - live.length),
    workIds: live.map((card) => card.workId),
    doneWorkIds,
    summary: neoAskViewSummary(ask, live, index.merged),
    sessions,
    answer: neoAskAnswer(ask),
  };
}

export function describeNeoAskViews(asks: readonly NeoAsk[], index: AskViewIndex): NeoAskView[] {
  return asks.map((ask) => describeNeoAskView(ask, index));
}

export const projectNeoAskViews = (superpipe({})('neo-ask-views') as PipelineAPI)
  .input(['asks', 'cards', 'prs', 'sessions'])
  .pipe(indexNeoAskViewParts, ['cards', 'prs', 'sessions'], 'index')
  .pipe(describeNeoAskViews, ['asks', 'index'], 'askViews')
  .end('askViews') as (
  asks: readonly NeoAsk[],
  cards: readonly NeoCardView[],
  prs: readonly NeoWorkPrReceipt[],
  sessions?: ReadonlyMap<string, readonly NeoAskSessionView[]>
) => NeoAskView[];
