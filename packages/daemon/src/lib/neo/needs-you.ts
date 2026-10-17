import { type NeoAsk, type NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { isNeoAskSettled } from './done-check.ts';

const NEO_ASK_ANSWER_LINE = 'Their answer: ';

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export function neoAskAnswerNote(
  ask: Pick<NeoAsk, 'id' | 'title'>,
  item: Pick<NeoAskItem, 'id' | 'text'>,
  choice: string,
  met = true
): string {
  return [
    `The human answered ${met ? 'a decision' : 'how a step went'} on ask ${ask.id} ("${oneLine(ask.title)}"), item ${item.id}: "${oneLine(item.text)}".`,
    `${NEO_ASK_ANSWER_LINE}${oneLine(choice)}`,
    met
      ? 'The daemon ticked that item met with their answer.'
      : 'The item stays open: it did not work, or the result is not what they wanted.',
  ].join('\n');
}

type NeoAskResume = { ask: NeoAsk; items: string[]; reopen: boolean };

export function planNeoAskResume(
  ask: NeoAsk | null,
  siblingsWaiting: boolean,
  cardId: string | null = null
): NeoAskResume | null {
  if (!ask || isNeoAskSettled(ask) || siblingsWaiting) return null;
  const decided = (item: NeoAskItem) =>
    item.decision === true || (!!item.waitCard && !!cardId && item.waitCard !== cardId);
  const open = (ask.doneItems ?? []).filter((item) => !item.removed && item.state === 'needs_you');
  const items = open.filter((item) => !decided(item)).map((item) => item.id);
  const confirming = (ask.doneItems ?? []).some(
    (item) => item.id === ask.waitingItem && !item.removed && item.state === 'reported'
  );
  const reopen =
    (ask.status === 'waiting' || ask.status === 'blocked') && !open.some(decided) && !confirming;
  return items.length || reopen ? { ask, items, reopen } : null;
}

export function planNeoNeedsYou(
  state: { needsYou: boolean; since: number } | null,
  noted: number | null,
  ask: NeoAsk | null,
  siblingsWaiting = false,
  cardId: string | null = null
): { notify: number | null; record: number | null | undefined; resume: NeoAskResume | null } {
  const none = { notify: null, record: undefined, resume: null };
  if (!state) return none;
  if (state.needsYou)
    return noted === null ? { notify: state.since, record: state.since, resume: null } : none;
  return noted === null
    ? none
    : { notify: null, record: null, resume: planNeoAskResume(ask, siblingsWaiting, cardId) };
}

export type NeoDaemonTickPath = 'check' | 'watch';

export function neoDaemonTickPath(
  item: Pick<NeoAskItem, 'check' | 'watch'>
): NeoDaemonTickPath | null {
  return item.check ? 'check' : item.watch?.length ? 'watch' : null;
}

export type NeoAskCardWait = {
  status: string;
  needsYou: boolean;
  stalled: boolean;
  targetReady?: boolean;
};

function cardWaitsOnHuman(card: NeoAskCardWait | undefined): boolean {
  return card?.status === 'proposed' || (card?.status === 'queued' && card.needsYou);
}

function neoUnkindedItemCleared(
  ask: NeoAsk,
  cards: readonly NeoAskCardWait[],
  _now: number
): string | null {
  if (!cards.length || cards.some((card) => card.status === 'queued' && card.needsYou)) return null;
  if (!cards.some((card) => card.status === 'proposed'))
    return 'no card under this ask is proposed or waits on the human';
  const approved = ask.approvedAt != null;
  return approved && !cards.some((card) => card.stalled)
    ? "the ask's approval is active and none of its cards has stalled"
    : null;
}

export function planNeoNeedsYouCleared(
  ask: NeoAsk,
  cards: ReadonlyMap<string, NeoAskCardWait>,
  now: number
): { id: string; why: string }[] {
  const own = ask.workIds.flatMap((id) => cards.get(id) ?? []);
  return (ask.doneItems ?? []).flatMap((item) => {
    if (item.removed || item.state !== 'needs_you' || item.decision) return [];
    if (item.waitCard)
      return cardWaitsOnHuman(cards.get(item.waitCard))
        ? []
        : [{ id: item.id, why: `card ${item.waitCard} no longer waits on the human` }];
    if (item.kind || item.options?.length) return [];
    const why = neoUnkindedItemCleared(ask, own, now);
    return why ? [{ id: item.id, why }] : [];
  });
}

function questionReasonGone(
  because: NonNullable<NeoAskItem['because']>,
  card: NeoAskCardWait | undefined
): string | null {
  if (!card) return null;
  if (because.reason === 'target_unavailable')
    return card.targetReady ? `card ${because.card} can reach its target again` : null;
  if (because.reason === 'card_waits')
    return cardWaitsOnHuman(card) ? null : `card ${because.card} no longer waits on the human`;
  return card.status === 'failed' ? null : `card ${because.card} is ${card.status}, not failed`;
}

export function planNeoQuestionsWithdrawn(
  ask: Pick<NeoAsk, 'doneItems'>,
  cards: ReadonlyMap<string, NeoAskCardWait>
): { id: string; why: string }[] {
  return (ask.doneItems ?? []).flatMap((item) => {
    if (item.removed || item.state !== 'needs_you' || !item.because) return [];
    const why = questionReasonGone(item.because, cards.get(item.because.card));
    return why ? [{ id: item.id, why }] : [];
  });
}

export function neoNeedsYouClearedNote(
  ask: Pick<NeoAsk, 'id' | 'title'>,
  cleared: readonly { id: string; why: string }[],
  items: readonly Pick<NeoAskItem, 'id' | 'text'>[]
): string {
  return [
    `The daemon moved needs_you items on ask ${ask.id} ("${ask.title}") back to pending because their reason went away:`,
    ...cleared.map(
      (entry) =>
        `- ${entry.id} "${items.find((item) => item.id === entry.id)?.text ?? ''}": ${entry.why}.`
    ),
  ].join('\n');
}

export function neoAskReopensAfterClear(ask: NeoAsk): boolean {
  return (
    ask.status === 'blocked' &&
    !(ask.doneItems ?? []).some((item) => !item.removed && item.state === 'needs_you')
  );
}

export function neoResumeWhy(
  item: Pick<NeoAskItem, 'waitCard'> | undefined,
  cardId: string
): string {
  return item?.waitCard === cardId
    ? `card ${cardId}, which it cites, no longer waits on the human`
    : `it cites no card, and card ${cardId} under this ask stopped waiting on the human, so it may be answered there`;
}

export function neoHumanTickWakes(
  state: NeoAskItem['state'],
  source: string,
  before: Pick<NeoAskItem, 'state'>
): boolean {
  return source !== 'mcp' && state === 'met' && before.state !== 'met';
}

export function neoAskTickedNote(
  ask: Pick<NeoAsk, 'id' | 'title' | 'doneItems'>,
  item: Pick<NeoAskItem, 'id' | 'text'>
): string {
  const open = (ask.doneItems ?? []).filter((entry) => !entry.removed && entry.state !== 'met');
  return [
    `The human marked item ${item.id} met on ask ${ask.id} ("${ask.title}"): "${item.text}".`,
    open.length
      ? `Still open: ${open.map((entry) => `${entry.id} "${entry.text}" (${entry.state})`).join('; ')}.`
      : 'Every item is met.',
  ].join('\n');
}
