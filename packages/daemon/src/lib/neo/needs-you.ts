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
  siblingsWaiting: boolean
): NeoAskResume | null {
  if (!ask || isNeoAskSettled(ask) || siblingsWaiting) return null;
  const items = (ask.doneItems ?? [])
    .filter((item) => !item.removed && item.state === 'needs_you')
    .map((item) => item.id);
  const confirming = (ask.doneItems ?? []).some(
    (item) => item.id === ask.waitingItem && !item.removed && item.state === 'reported'
  );
  const reopen = (ask.status === 'waiting' || ask.status === 'blocked') && !confirming;
  return items.length || reopen ? { ask, items, reopen } : null;
}

export function planNeoNeedsYou(
  state: { needsYou: boolean; since: number } | null,
  noted: number | null,
  ask: NeoAsk | null,
  siblingsWaiting = false
): { notify: number | null; record: number | null | undefined; resume: NeoAskResume | null } {
  const none = { notify: null, record: undefined, resume: null };
  if (!state) return none;
  if (state.needsYou)
    return noted === null ? { notify: state.since, record: state.since, resume: null } : none;
  return noted === null
    ? none
    : { notify: null, record: null, resume: planNeoAskResume(ask, siblingsWaiting) };
}
