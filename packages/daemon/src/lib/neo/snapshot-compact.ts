import type {
  NeoAsk,
  NeoCardPhase,
  NeoCardView,
  NeoSnapshot,
} from '@hyperneo/shared/types/neo-snapshot';
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

export const NEO_MCP_SNAPSHOT_BUDGET = 40_000;
const TRIMMED_TEXT_LIMIT = 300;
const NEO_SNAPSHOT_TRIMMED =
  'This snapshot was trimmed to fit: settled asks and finished cards outside open asks are left out, and long text is cut. Call neo.snapshot {askId} for one ask in full.';

const size = (snapshot: NeoSnapshot) => JSON.stringify(snapshot).length;

function keepWork(snapshot: NeoSnapshot, keep: ReadonlySet<string>): NeoSnapshot {
  return {
    ...snapshot,
    work: snapshot.work.filter((item) => keep.has(item.id)),
    cards: snapshot.cards.filter((card) => keep.has(card.workId)),
    workResources: snapshot.workResources?.filter((row) => keep.has(row.workId)),
    askOrigins: snapshot.askOrigins?.filter((row) => row.kind !== 'work' || keep.has(row.id)),
  };
}

function withoutSettled(snapshot: NeoSnapshot): NeoSnapshot {
  const open = (snapshot.asks ?? []).filter((ask) => !isNeoAskSettled(ask));
  const openIds = new Set(open.map((ask) => ask.id));
  const owned = new Set(open.flatMap((ask) => ask.workIds));
  const finished = new Set(
    snapshot.cards.filter((card) => FINISHED_PHASES.has(card.phase)).map((card) => card.workId)
  );
  const keep = new Set(
    snapshot.work.map((item) => item.id).filter((id) => owned.has(id) || !finished.has(id))
  );
  return {
    ...keepWork(snapshot, keep),
    asks: open,
    askViews: snapshot.askViews.filter((view) => openIds.has(view.askId)),
  };
}

function withShortText(snapshot: NeoSnapshot): NeoSnapshot {
  return {
    ...snapshot,
    sessionLoad: [],
    sessionNoticeGroups: snapshot.sessionNoticeGroups?.slice(0, 1),
    work: snapshot.work.map((item) => ({
      ...item,
      instruction: item.instruction.slice(0, TRIMMED_TEXT_LIMIT),
      report: item.report?.slice(0, TRIMMED_TEXT_LIMIT) ?? null,
    })),
    asks: snapshot.asks?.map((ask) => ({
      ...ask,
      ask: ask.ask.slice(0, TRIMMED_TEXT_LIMIT),
      evidence: ask.evidence?.slice(0, TRIMMED_TEXT_LIMIT) ?? null,
      outcome: ask.outcome?.slice(0, TRIMMED_TEXT_LIMIT) ?? null,
    })),
  };
}

function withNewestAsks(snapshot: NeoSnapshot, count: number): NeoSnapshot {
  const asks = (snapshot.asks ?? []).slice(0, count);
  const ids = new Set(asks.map((ask) => ask.id));
  const owned = new Set(asks.flatMap((ask) => ask.workIds));
  const loose = new Set(
    (snapshot.asks ?? []).filter((ask) => !ids.has(ask.id)).flatMap((ask) => ask.workIds)
  );
  return {
    ...keepWork(
      snapshot,
      new Set(snapshot.work.map((item) => item.id).filter((id) => owned.has(id) || !loose.has(id)))
    ),
    asks,
    askViews: snapshot.askViews.filter((view) => ids.has(view.askId)),
  };
}

export function fitNeoSnapshotBudget<T extends NeoSnapshot>(snapshot: T, budget: number): T {
  if (size(snapshot) <= budget) return snapshot;
  let fitted = withoutSettled(snapshot);
  if (size(fitted) > budget) fitted = withShortText(fitted);
  for (let count = fitted.asks?.length ?? 0; size(fitted) > budget && count > 1; )
    fitted = withNewestAsks(fitted, (count = Math.floor(count / 2)));
  return { ...snapshot, ...fitted, trimmed: NEO_SNAPSHOT_TRIMMED };
}
