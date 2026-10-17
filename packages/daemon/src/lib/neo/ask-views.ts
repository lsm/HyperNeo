import {
  type NeoAsk,
  type NeoAskHumanAction,
  type NeoAskItem,
  type NeoAskTodo,
  type NeoAskSessionView,
  type NeoAskStatus,
  type NeoAskView,
  type NeoCardGroup,
  type NeoCardView,
  type NeoWorkPrReceipt,
} from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { projectNeoAskTodos, type NeoAskTodoParts } from './ask-todo-views.ts';
import { neoQuestionStartTargets, neoStartQuestionTitle } from './start-question.ts';

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

export const NEO_ASK_IDLE_LABEL = 'Not started · Neo is trying another way';

export function neoAskIdleLabel(
  _refusedCount: number | undefined,
  _idleReason: string | undefined
): { label: string; stuck: boolean } {
  return { label: NEO_ASK_IDLE_LABEL, stuck: false };
}

export function neoAskIdleReason(refused: string | null | undefined): string | undefined {
  const reason =
    refused
      ?.replace(/\s+/g, ' ')
      .trim()
      .match(/^.+?[.!?](?=\s|$)/)?.[0] ?? refused;
  return reason?.trim() ? `Couldn't start: ${reason.trim().replace(/[.!?]$/, '')}` : undefined;
}

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
  if (ask.status !== 'achieved' && ask.status !== 'abandoned') return null;
  const outcome = ask.outcome?.trim() || null;
  if (!outcome || outcome.length <= NEO_ASK_SUMMARY_LIMIT) return outcome;
  const numbers = [...new Set(live.flatMap((card) => merged.get(card.workId) ?? []))];
  if (ask.status === 'achieved' && numbers.length > 0) return `Merged in ${numbers.join(', ')}.`;
  const sentence = outcome.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? outcome;
  return sentence.length <= NEO_ASK_SUMMARY_LIMIT
    ? sentence
    : `${sentence.slice(0, NEO_ASK_SUMMARY_LIMIT - 1).trimEnd()}…`;
}

export function neoAskItemAction(item: NeoAskItem): NeoAskHumanAction | null {
  if (item.removed || item.state !== 'needs_you') return null;
  if (
    !item.decision &&
    !item.question &&
    item.kind !== 'decision' &&
    item.kind !== 'action' &&
    !item.options?.length
  )
    return null;
  const titles = item.decides?.split('\n') ?? [];
  const steps = neoQuestionStartTargets(item).flatMap((step, index) => {
    const title = step.title ?? titles[index];
    return title ? [{ id: step.workId, title }] : [];
  });
  return {
    kind: 'question',
    itemId: item.id,
    question: steps.length ? neoStartQuestionTitle(steps) : (item.question ?? item.text),
    ...(steps.length ? { steps } : {}),
    options: item.options ?? [],
  };
}

export function deriveNeoAskHumanActions(ask: NeoAsk): NeoAskHumanAction[] {
  if (ask.status === 'achieved' || ask.status === 'abandoned') return [];
  return (ask.doneItems ?? []).flatMap((item) => neoAskItemAction(item) ?? []);
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
  const humanActions = deriveNeoAskHumanActions(ask);
  const needsYou =
    !settled && (humanActions.length > 0 || sessions.some((session) => session.kind !== null));
  const doneWorkIds = live
    .filter((card) => card.phase === 'merged' && !card.pr?.setback)
    .map((card) => card.workId);
  const counted = (ask.doneItems ?? []).filter((item) => !item.removed);
  const idle =
    ask.status === 'open' &&
    !needsYou &&
    !index.busy.has(ask.id) &&
    !sessions.some((session) => session.status === 'queued' || session.status === 'running') &&
    !humanActions.length &&
    !live.some(isNeoCardInPlay) &&
    !(counted.length && counted.every((item) => item.state === 'met'));
  const idleReason = idle ? neoAskIdleReason(ask.refused) : undefined;
  const idleView = neoAskIdleLabel(ask.refusedCount, idleReason);
  return {
    askId: ask.id,
    group: needsYou || idle ? 'attention' : truth.group,
    label: needsYou ? 'Needs you' : idle ? idleView.label : truth.label,
    settled,
    needsYou: needsYou || (idle && idleView.stuck),
    ...(idle ? { idle: true as const } : {}),
    ...(idleReason ? { idleReason } : {}),
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
    humanActions,
  };
}

export function describeNeoAskViews(asks: readonly NeoAsk[], index: AskViewIndex): NeoAskView[] {
  return asks.map((ask) => describeNeoAskView(ask, index));
}

export function neoAskTodoScene(
  ask: NeoAsk,
  todos: readonly NeoAskTodo[],
  humanActions: readonly NeoAskHumanAction[]
): Pick<NeoAskView, 'group' | 'label' | 'needsYou' | 'done' | 'total' | 'doneWorkIds'> {
  const active = todos.filter((todo) => todo.state !== 'cancelled');
  const abandoned = ask.status === 'abandoned';
  const achieved = ask.status === 'achieved';
  const needsYou = !abandoned && !achieved && humanActions.length > 0;
  const running = active.some((todo) => todo.state === 'running');
  const done = active.filter((todo) => todo.state === 'done');
  const finished = active.length ? done.length === active.length : ask.status === 'achieved';
  const failed = active.some((todo) => todo.state === 'failed');
  return {
    label: abandoned
      ? '放弃了'
      : achieved
        ? '做完'
        : needsYou
          ? '等你'
          : running
            ? '在做'
            : finished
              ? '做完'
              : failed
                ? '没做成'
                : '没开始',
    group:
      abandoned || achieved
        ? 'outcomes'
        : needsYou
          ? 'attention'
          : finished || (failed && !running)
            ? 'outcomes'
            : 'running',
    needsYou,
    done: done.length,
    total: active.length,
    doneWorkIds: done.flatMap((todo) => todo.workId ?? []),
  };
}

function withNeoAskTodos(
  views: NeoAskView[],
  asks: readonly NeoAsk[],
  cards: readonly NeoCardView[],
  prs: readonly NeoWorkPrReceipt[],
  parts?: NeoAskTodoParts
): NeoAskView[] {
  if (!parts) return views;
  return views.map((view, index) => {
    const todos = projectNeoAskTodos(asks[index], cards, prs, parts);
    return {
      ...view,
      todos,
      ...neoAskTodoScene(asks[index], todos, view.humanActions ?? []),
    };
  });
}

export const projectNeoAskViews = (superpipe({})('neo-ask-views') as PipelineAPI)
  .input(['asks', 'cards', 'prs', 'sessions', 'busy', 'parts'])
  .pipe(indexNeoAskViewParts, ['cards', 'prs', 'sessions', 'busy'], 'index')
  .pipe(describeNeoAskViews, ['asks', 'index'], 'askViews')
  .pipe(withNeoAskTodos, ['askViews', 'asks', 'cards', 'prs', 'parts'], 'askViews')
  .end('askViews') as (
  asks: readonly NeoAsk[],
  cards: readonly NeoCardView[],
  prs: readonly NeoWorkPrReceipt[],
  sessions?: ReadonlyMap<string, readonly NeoAskSessionView[]>,
  busy?: ReadonlySet<string>,
  parts?: NeoAskTodoParts
) => NeoAskView[];
