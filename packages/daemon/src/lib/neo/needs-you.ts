import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { isNeoAskSettled } from './done-check.ts';

type NeoAskResume = { ask: NeoAsk; items: string[]; reopen: boolean };

export function planNeoAskResume(
  ask: NeoAsk | null,
  siblingsWaiting: boolean
): NeoAskResume | null {
  if (!ask || isNeoAskSettled(ask) || siblingsWaiting) return null;
  const decided = (item: NeoAskItem) =>
    item.id === ask.waitingItem && ask.evidence != null && ask.evidence !== item.text;
  const open = (ask.doneItems ?? []).filter((item) => !item.removed && item.state === 'needs_you');
  const items = open.filter((item) => !decided(item)).map((item) => item.id);
  const reopen = (ask.status === 'waiting' || ask.status === 'blocked') && !open.some(decided);
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
