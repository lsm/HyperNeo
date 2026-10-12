import type { NeoAsk, NeoCardPhase, NeoCardView } from '@hyperneo/shared/types/neo-snapshot';
import { isNeoAskSettled } from './done-check.ts';

const SETTLED_OUTCOME_LIMIT = 300;
const OPEN_EVIDENCE_LIMIT = 2000;
const CONTINUED_MESSAGE_LIMIT = 1000;
const FINISHED_PHASES: ReadonlySet<NeoCardPhase> = new Set(['merged', 'reported', 'cancelled']);

export function compactNeoSnapshotAsks(asks: readonly NeoAsk[]): NeoAsk[] {
  return asks.map((ask) =>
    isNeoAskSettled(ask)
      ? {
          ...ask,
          ask: '',
          doneWhen: '',
          evidence: null,
          doneItems: [],
          outcome: ask.outcome?.slice(0, SETTLED_OUTCOME_LIMIT) ?? null,
        }
      : { ...ask, evidence: ask.evidence?.slice(0, OPEN_EVIDENCE_LIMIT) ?? null }
  );
}

export function compactNeoSnapshotCards(cards: readonly NeoCardView[]): NeoCardView[] {
  return cards.map((card) =>
    FINISHED_PHASES.has(card.phase)
      ? { ...card, goal: null, doneWhen: null, continuedMessage: null }
      : {
          ...card,
          continuedMessage: card.continuedMessage?.slice(0, CONTINUED_MESSAGE_LIMIT) ?? null,
        }
  );
}
