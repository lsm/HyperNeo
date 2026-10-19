import type { NeoAskRepository } from '../../storage/repositories/neo-ask-repository.ts';
import { isNeoAskSettled } from './done-check.ts';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { isPooledNeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import type { Settle, NeoOutcomeCard, NeoAskSettleFacts } from './ask-inputs.ts';
import type { z } from 'zod';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { isNeoAnswerItem } from './answer-outcome.ts';

export const isFinal = isNeoAskSettled;

const ACTIVE_ASK_LIMIT = 50;

export const activeNeoAskItems = (ask: Pick<NeoAsk, 'doneItems'>) =>
  (ask.doneItems ?? []).filter((item) => !item.removed);

export function projectNeoSnapshotAsks(
  asks: readonly NeoAsk[],
  settledLimit: number,
  now: number,
  stalled: ReadonlySet<string> = new Set()
): NeoAsk[] {
  const active = asks.filter((ask) => !isFinal(ask)).slice(0, ACTIVE_ASK_LIMIT);
  return [...active, ...asks.filter(isFinal).slice(0, settledLimit)].map((ask) => ({
    ...ask,
    pooled: isPooledNeoAsk(ask),
    approvalSpent: null,
    ...(ask.workIds.some((id) => stalled.has(id))
      ? { stalledWorkIds: ask.workIds.filter((id) => stalled.has(id)) }
      : {}),
  }));
}

export function neoItemDependentCards<T extends NeoOutcomeCard>(
  item: Pick<NeoAskItem, 'deliveredBy'>,
  cards: readonly T[]
): T[] {
  return item.deliveredBy ? cards.filter((card) => card.id === item.deliveredBy) : [];
}

const NEO_TERMINAL_CARD = new Set<NeoWork['status']>(['reported', 'failed', 'cancelled']);

export function neoAskLiveOutcomeCards(
  ask: Pick<NeoAsk, 'doneItems'>,
  cards: readonly NeoOutcomeCard[]
): string[] {
  return activeNeoAskItems(ask).flatMap((item) =>
    neoItemDependentCards(item, cards)
      .filter((card) => !NEO_TERMINAL_CARD.has(card.status))
      .map(
        (card) => `${item.id} is delivered by card ${card.id.slice(0, 8)}, which is ${card.status}`
      )
  );
}

export function neoAskHasHumanAction(ask: NeoAsk, facts: NeoAskSettleFacts, _now: number): boolean {
  return (
    facts.offered ||
    facts.stalled ||
    facts.failed ||
    (ask.doneItems ?? []).some(
      (item) =>
        !item.removed &&
        (item.state === 'needs_you' || (item.state === 'reported' && !isNeoAnswerItem(item)))
    )
  );
}

export function planNeoAskTickStatus(
  ask: NeoAsk,
  settle: { cardLive: boolean; outcome?: string; changes: { metAt: number; removedAt: number } }
):
  | { status: 'achieved'; outcome: string; evidence: string }
  | { status: 'waiting'; outcome: string; item: string }
  | { status: 'open' }
  | { status: 'unchanged' } {
  if (isFinal(ask)) return { status: 'unchanged' };
  const items = activeNeoAskItems(ask);
  const held = ask.status === 'waiting' && !ask.waitingItem;
  if (
    settle.changes.metAt > settle.changes.removedAt &&
    !held &&
    !settle.cardLive &&
    items.length &&
    items.every((item) => item.state === 'met')
  ) {
    const evidence = [...new Set(items.map((item) => item.evidence ?? item.text))].join('; ');
    return { status: 'achieved', outcome: settle.outcome ?? evidence, evidence };
  }
  const asked =
    items.find((item) => item.state === 'needs_you') ??
    (items.some((item) => item.state === 'pending')
      ? undefined
      : items.find((item) => item.state === 'reported' && !isNeoAnswerItem(item)));
  if (asked)
    return ask.status === 'waiting' && ask.waitingItem === asked.id
      ? { status: 'unchanged' }
      : {
          status: 'waiting',
          outcome: asked.state === 'reported' ? `Confirm: ${asked.text}` : asked.text,
          item: asked.id,
        };
  return ask.status === 'waiting' && ask.waitingItem ? { status: 'open' } : { status: 'unchanged' };
}

export function planNeoAskWorkStops(
  works: readonly Pick<NeoWork, 'id' | 'status'>[],
  outcome: z.infer<typeof Settle>['outcome']
): { id: string; close: 'done' | 'cancelled' }[] {
  if (outcome === 'blocked' || outcome === 'waiting') return [];
  return works.flatMap((work) =>
    work.status === 'queued'
      ? [
          {
            id: work.id,
            close: outcome === 'achieved' ? ('done' as const) : ('cancelled' as const),
          },
        ]
      : work.status === 'proposed'
        ? [{ id: work.id, close: 'cancelled' as const }]
        : []
  );
}

export function writeNeoAskTickStatus(
  records: Pick<NeoAskRepository, 'settle' | 'reopen'>,
  ask: NeoAsk,
  plan: ReturnType<typeof planNeoAskTickStatus>
): NeoAsk | null {
  return plan.status === 'achieved'
    ? records.settle(ask, 'achieved', plan.outcome, plan.evidence)
    : plan.status === 'waiting'
      ? records.settle(ask, 'waiting', plan.outcome, plan.outcome, plan.item)
      : plan.status === 'open'
        ? records.reopen(ask)
        : ask;
}
