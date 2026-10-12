import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { isNeoAskSettled } from './done-check.ts';

export function neoAskAnswerNote(
  ask: Pick<NeoAsk, 'id' | 'title'>,
  item: Pick<NeoAskItem, 'id' | 'text'>,
  choice: string
): string {
  return [
    `The human answered a decision on ask ${ask.id} ("${ask.title}"), item ${item.id}: "${item.text}".`,
    `Their answer: ${choice}`,
    'The daemon ticked that item met with their answer. Act on it now: continue or propose the work it calls for under this ask, or settle the ask if nothing is left. Tell the human only what they need to know.',
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

const NEO_DAEMON_SUBJECT =
  /#\d+|\b(PRs?|pull requests?|merges?|merged|merging|CI|checks?|builds?|deploy\w*|cards?|standing rules?)\b/i;
const NEO_WAIT_WORD =
  /\b(after|once|until|wait(s|ing|ed)? (for|on|until)|pending)\b(?!\s+(you|the human|they)\b)/i;
const NEO_CHECK_WORD = /\b(verify|confirm|check|make sure|ensure|read back)\w*\b/i;
const NEO_DAEMON_FACT =
  /\b(merged|merge[sd]? (to|into)|PRs?|pull requests?|CI|checks? (pass|green)\w*|standing rules?|cards?)\b|\blaptop\b[^.;]*\bdeploy|\bdeploy\w*\b[^.;]*\blaptop\b/i;
const NEO_REMOTE_FACT = /\b(iMac|tts|remote|other machine|phone|device)\b/i;
const NEO_APPROVAL =
  /\bapprov\w*\b[^.;]*\bcontinu\w*|\bcontinu\w*\b[^.;]*\b(exhaust\w*|limit|spent|used up)\b/i;

export function neoDaemonReadsItem(
  state: 'needs_you' | 'reported',
  text: string,
  context = ''
): 'approval' | 'wait' | 'fact' | null {
  if (state === 'needs_you' && NEO_APPROVAL.test(text)) return 'approval';
  if (NEO_REMOTE_FACT.test(`${text}\n${context}`) || !NEO_DAEMON_SUBJECT.test(text)) return null;
  if (NEO_WAIT_WORD.test(text)) return 'wait';
  if (state !== 'reported') return null;
  return NEO_CHECK_WORD.test(text) || NEO_DAEMON_FACT.test(text) ? 'fact' : null;
}

export type NeoAskCardWait = { status: string; needsYou: boolean };

const NEO_START_WORK = /\bstart work\b[^.;]*\bcard\b/i;

function cardWaitsOnHuman(card: NeoAskCardWait | undefined): boolean {
  return card?.status === 'proposed' || (card?.status === 'queued' && card.needsYou);
}

export function planNeoNeedsYouCleared(
  ask: NeoAsk,
  cards: ReadonlyMap<string, NeoAskCardWait>
): { id: string; why: string }[] {
  const startable =
    ask.workIds.length > 0 && !ask.workIds.some((id) => cards.get(id)?.status === 'proposed');
  return (ask.doneItems ?? []).flatMap((item) => {
    if (item.removed || item.state !== 'needs_you' || item.decision) return [];
    if (item.waitCard && !cardWaitsOnHuman(cards.get(item.waitCard)))
      return [{ id: item.id, why: `card ${item.waitCard} no longer waits on the human` }];
    if (startable && NEO_START_WORK.test(item.text))
      return [{ id: item.id, why: 'no card under this ask waits for Start work' }];
    return [];
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
    'Check each one now: tick it met if it is done, needs_you again if the human still has to answer it, keep the work moving if not, or remove it if it no longer applies.',
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
