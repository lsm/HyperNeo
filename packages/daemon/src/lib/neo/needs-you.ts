import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { isNeoAskSettled } from './done-check.ts';

type NeoAskResume = { ask: NeoAsk; items: string[]; reopen: boolean };

export function planNeoAskResume(ask: NeoAsk | null): NeoAskResume | null {
  if (!ask || isNeoAskSettled(ask)) return null;
  const items = (ask.doneItems ?? [])
    .filter((item) => !item.removed && item.state === 'needs_you')
    .map((item) => item.id);
  const reopen = ask.status === 'waiting' || ask.status === 'blocked';
  return items.length || reopen ? { ask, items, reopen } : null;
}

export function planNeoNeedsYou(
  state: { needsYou: boolean; since: number } | null,
  noted: number | null,
  ask: NeoAsk | null
): { notify: number | null; record: number | null | undefined; resume: NeoAskResume | null } {
  const none = { notify: null, record: undefined, resume: null };
  if (!state) return none;
  if (state.needsYou)
    return noted === null ? { notify: state.since, record: state.since, resume: null } : none;
  return noted === null ? none : { notify: null, record: null, resume: planNeoAskResume(ask) };
}
