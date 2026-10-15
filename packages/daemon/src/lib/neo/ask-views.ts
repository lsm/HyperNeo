import {
  type NeoAsk,
  type NeoAskAnswer,
  type NeoAskHumanAction,
  type NeoAskItem,
  type NeoAskSessionView,
  type NeoAskStatus,
  type NeoAskView,
  type NeoCardGroup,
  type NeoCardView,
  type NeoWorkPrReceipt,
} from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { isNeoAnswerItem } from './answer-outcome.ts';

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

export const NEO_ASK_IDLE_LABEL = 'Nothing running · Neo will propose again, or drop it';

export function isNeoCardInPlay(card: Pick<NeoCardView, 'group' | 'phase'>): boolean {
  return card.group !== 'outcomes' && card.phase !== 'abandoned';
}

type AskViewIndex = {
  cards: Map<string, NeoCardView>;
  merged: Map<string, string[]>;
  sessions: ReadonlyMap<string, readonly NeoAskSessionView[]>;
  busy: ReadonlySet<string>;
};

export function indexNeoAskViewParts(
  cards: readonly NeoCardView[],
  prs: readonly NeoWorkPrReceipt[],
  sessions: ReadonlyMap<string, readonly NeoAskSessionView[]> = new Map(),
  busy: ReadonlySet<string> = new Set()
): AskViewIndex {
  return {
    sessions,
    busy,
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

export function isNeoAskOutcomeItem(
  item: Pick<NeoAskItem, 'state' | 'kind' | 'options' | 'removed' | 'waitCard'>
): boolean {
  return (
    !item.removed &&
    item.state === 'needs_you' &&
    item.kind === 'action' &&
    !item.waitCard &&
    !!item.options?.length
  );
}

export function neoAskItemAction(item: NeoAskItem): NeoAskHumanAction | null {
  if (item.removed) return null;
  if (item.state === 'reported')
    return isNeoAnswerItem(item) ? null : { kind: 'confirm', itemId: item.id, step: item.text };
  if (isNeoAskOutcomeItem(item))
    return {
      kind: 'answer',
      itemId: item.id,
      step: item.text === item.question ? null : item.text,
      question: item.question ?? item.text,
      options: [...(item.options ?? [])],
    };
  if (item.state !== 'needs_you') return null;
  if (!item.options?.length && item.kind !== 'decision') return null;
  return {
    kind: 'answer',
    itemId: item.id,
    step: null,
    question: item.text,
    options: item.options ?? [],
  };
}

export function neoCardHumanAction(card: NeoCardView): NeoAskHumanAction | null {
  if (card.talk) return { kind: 'talk', workId: card.workId, what: card.talk };
  if (card.phase === 'proposed') return { kind: 'start', workId: card.workId };
  if (card.primary.kind === 'retry') return { kind: 'retry', workId: card.workId };
  if (card.primary.kind === 'close') return { kind: 'close', workId: card.workId };
  return null;
}

export function neoAskApproveAction(
  ask: Pick<NeoAsk, 'approvalSpent' | 'stalledWorkIds'>,
  live: readonly Pick<NeoCardView, 'workId'>[]
): NeoAskHumanAction[] {
  if (ask.approvalSpent === 'expired') return [{ kind: 'approve', reason: 'expired' }];
  const stalled = new Set(ask.stalledWorkIds ?? []);
  const workIds = live.map((card) => card.workId).filter((id) => stalled.has(id));
  return workIds.length ? [{ kind: 'approve', reason: 'stalled', workIds }] : [];
}

export function deriveNeoAskHumanActions(
  ask: NeoAsk,
  live: readonly NeoCardView[]
): NeoAskHumanAction[] {
  if (ask.status === 'achieved' || ask.status === 'abandoned') return [];
  return [
    ...live.flatMap((card) => neoCardHumanAction(card) ?? []),
    ...neoAskApproveAction(ask, live),
    ...(ask.doneItems ?? []).flatMap((item) => neoAskItemAction(item) ?? []),
  ];
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
    (live.some((card) => card.talk || card.group === 'attention') ||
      sessions.some((session) => session.kind !== null));
  const doneWorkIds = live
    .filter((card) => card.phase === 'merged' && !card.pr?.setback)
    .map((card) => card.workId);
  const counted = (ask.doneItems ?? []).filter((item) => !item.removed);
  const humanActions = deriveNeoAskHumanActions(ask, live);
  const idle =
    ask.status === 'open' &&
    ask.workIds.length > 0 &&
    !needsYou &&
    !index.busy.has(ask.id) &&
    !sessions.some((session) => session.status === 'queued' || session.status === 'running') &&
    !humanActions.length &&
    !live.some(isNeoCardInPlay) &&
    !(counted.length && counted.every((item) => item.state === 'met'));
  return {
    askId: ask.id,
    group: needsYou || idle ? 'attention' : truth.group,
    label: needsYou ? 'Needs you' : idle ? NEO_ASK_IDLE_LABEL : truth.label,
    settled,
    needsYou,
    ...(idle ? { idle: true as const } : {}),
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
    humanActions: idle ? [...humanActions, { kind: 'drop' }] : humanActions,
  };
}

export function describeNeoAskViews(asks: readonly NeoAsk[], index: AskViewIndex): NeoAskView[] {
  return asks.map((ask) => describeNeoAskView(ask, index));
}

export const projectNeoAskViews = (superpipe({})('neo-ask-views') as PipelineAPI)
  .input(['asks', 'cards', 'prs', 'sessions', 'busy'])
  .pipe(indexNeoAskViewParts, ['cards', 'prs', 'sessions', 'busy'], 'index')
  .pipe(describeNeoAskViews, ['asks', 'index'], 'askViews')
  .end('askViews') as (
  asks: readonly NeoAsk[],
  cards: readonly NeoCardView[],
  prs: readonly NeoWorkPrReceipt[],
  sessions?: ReadonlyMap<string, readonly NeoAskSessionView[]>,
  busy?: ReadonlySet<string>
) => NeoAskView[];
