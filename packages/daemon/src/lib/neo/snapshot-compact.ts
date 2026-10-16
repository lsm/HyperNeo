import type {
  NeoAsk,
  NeoCardPhase,
  NeoCardView,
  NeoSnapshot,
  NeoSnapshotWork,
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

export const NEO_SNAPSHOT_SETTLED_ASKS = 10;
const SUMMARY_TEXT_LIMIT = 300;
const LIVE_WORK: ReadonlySet<NeoSnapshotWork['status']> = new Set(['proposed', 'queued']);

function clip(text: string): string {
  const cut = text.slice(0, SUMMARY_TEXT_LIMIT);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function summarizeWork(item: NeoSnapshotWork, askId: string | undefined): NeoSnapshotWork {
  return {
    ...item,
    instruction: '',
    report: item.report === null ? null : clip(item.report),
    summarized: true,
    ...(askId ? { askId } : {}),
  };
}

export function summarizeNeoSnapshot<T extends NeoSnapshot>(
  snapshot: T,
  asks: readonly NeoAsk[]
): T {
  const brief = new Set(asks.filter(isNeoAskSettled).map((ask) => ask.id));
  const askOf = new Map(asks.flatMap((ask) => ask.workIds.map((id) => [id, ask.id] as const)));
  const work = snapshot.work.map((item): NeoSnapshotWork => {
    const askId = askOf.get(item.id);
    if (LIVE_WORK.has(item.status) || (askId && !brief.has(askId))) return item;
    return summarizeWork(item, askId);
  });
  const briefWork = new Set(work.flatMap((item) => (item.askId ? [item.id] : [])));
  return {
    ...snapshot,
    asks: snapshot.asks?.map((ask) =>
      brief.has(ask.id)
        ? {
            ...ask,
            ask: '',
            doneWhen: '',
            doneItems: [],
            evidence: null,
            outcome: ask.outcome === null ? null : clip(ask.outcome),
            summarized: true as const,
          }
        : ask
    ),
    work,
    cards: snapshot.cards.map((card) =>
      briefWork.has(card.workId) && FINISHED_PHASES.has(card.phase)
        ? { ...card, goal: null, doneWhen: null, continuedMessage: null }
        : card
    ),
    consultations: snapshot.consultations.map((item) =>
      item.status === 'pending'
        ? item
        : {
            ...item,
            question: clip(item.question),
            answer: item.answer === null ? null : clip(item.answer),
            summarized: true as const,
          }
    ),
  };
}

export function neoSnapshotOmitted<T extends NeoSnapshot>(fitted: T, built: NeoSnapshot): T {
  const { omitted: _omitted, ...rest } = fitted;
  const work = (built.omitted?.work ?? 0) + built.work.length - fitted.work.length;
  const asks = (built.omitted?.asks ?? 0) + (built.asks?.length ?? 0) - (fitted.asks?.length ?? 0);
  return (
    work || asks
      ? { ...rest, omitted: { ...(work ? { work } : {}), ...(asks ? { asks } : {}) } }
      : rest
  ) as T;
}

export const NEO_MCP_SNAPSHOT_BUDGET = 40_000;
const TRIMMED_TEXT_LIMIT = 300;
const TRIMMED_NOTE_RESERVE = 512;
const NEO_SNAPSHOT_TRIMMED =
  'This snapshot was trimmed to fit: settled asks and finished cards outside open asks are left out, and long text is cut. Call neo.snapshot {askId} for one ask in more detail.';

export function neoSnapshotTrimmedNote(droppedOpen: number): string {
  return droppedOpen > 0
    ? `${NEO_SNAPSHOT_TRIMMED} ${droppedOpen} older open ${droppedOpen === 1 ? 'ask is' : 'asks are'} also left out; this is not every open ask.`
    : NEO_SNAPSHOT_TRIMMED;
}

const size = (snapshot: NeoSnapshot) => Buffer.byteLength(JSON.stringify(snapshot), 'utf8');

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
    working: [],
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
      doneItems: ask.doneItems?.map((item) => ({
        ...item,
        text: item.text.slice(0, TRIMMED_TEXT_LIMIT),
        evidence: item.evidence?.slice(0, TRIMMED_TEXT_LIMIT) ?? null,
      })),
    })),
    projects: snapshot.projects.map((project) => ({
      ...project,
      summary: project.summary.slice(0, TRIMMED_TEXT_LIMIT),
      context: project.context.slice(0, TRIMMED_TEXT_LIMIT),
    })),
    cards: snapshot.cards.map((card) => ({
      ...card,
      goal: card.goal?.slice(0, TRIMMED_TEXT_LIMIT) ?? null,
      doneWhen: card.doneWhen?.slice(0, TRIMMED_TEXT_LIMIT) ?? null,
      continuedMessage: card.continuedMessage?.slice(0, TRIMMED_TEXT_LIMIT) ?? null,
    })),
    consultations: snapshot.consultations?.map((item) => ({
      ...item,
      question: item.question.slice(0, TRIMMED_TEXT_LIMIT),
      answer: item.answer?.slice(0, TRIMMED_TEXT_LIMIT) ?? null,
    })),
    consultationWaiters: snapshot.consultationWaiters?.map((item) => ({
      ...item,
      question: item.question.slice(0, TRIMMED_TEXT_LIMIT),
    })),
    askViews: snapshot.askViews.map((view) => ({
      ...view,
      ...(view.sessions ? { sessions: view.sessions.slice(0, 3) } : {}),
    })),
  };
}

function withBareText(snapshot: NeoSnapshot): NeoSnapshot {
  return {
    ...snapshot,
    sessionNoticeGroups: [],
    work: snapshot.work.map((item) => ({ ...item, instruction: '', report: null })),
    asks: snapshot.asks?.map((ask) => ({
      ...ask,
      ask: '',
      evidence: null,
      outcome: null,
      doneItems: ask.doneItems?.map((item) => ({
        ...item,
        text: item.text.slice(0, 80),
        evidence: null,
      })),
    })),
    projects: snapshot.projects.map((project) => ({ ...project, summary: '', context: '' })),
    cards: snapshot.cards.map((card) => ({
      ...card,
      goal: null,
      doneWhen: null,
      continuedMessage: null,
    })),
    consultations: snapshot.consultations?.map((item) => ({
      ...item,
      question: '',
      answer: null,
    })),
    consultationWaiters: snapshot.consultationWaiters?.map((item) => ({ ...item, question: '' })),
    askViews: snapshot.askViews.map((view) => ({ ...view, summary: null, sessions: [] })),
    waitingOnHuman: snapshot.waitingOnHuman && {
      ...snapshot.waitingOnHuman,
      asks: snapshot.waitingOnHuman.asks.map((ask) => ({
        ...ask,
        question: ask.question.slice(0, 80),
      })),
    },
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

const SKELETON_LIST_LIMIT = 20;
const NEO_SNAPSHOT_FOCUS_TRIMMED =
  'This ask is too large to return whole, so its long text is cut. Calling neo.snapshot {askId} again returns the same; read a card\u2019s full report with work.read.';
const NEO_SNAPSHOT_SKELETON =
  'This snapshot was too large even trimmed, so only ask and card identities are left. Call neo.snapshot {askId} for one ask.';

function withSkeleton(snapshot: NeoSnapshot): NeoSnapshot {
  return {
    ...snapshot,
    workResources: [],
    askOrigins: [],
    sessionNoticeGroups: [],
    consultations: [],
    consultationWaiters: [],
    projects: snapshot.projects.slice(0, SKELETON_LIST_LIMIT),
    asks: snapshot.asks?.map((ask) => ({
      ...ask,
      doneItems: ask.doneItems
        ?.filter((item) => !item.removed)
        .slice(0, SKELETON_LIST_LIMIT)
        .map(({ options: _options, ...item }) => ({
          ...item,
          text: item.text.slice(0, 80),
          evidence: null,
        })),
    })),
    askViews: snapshot.askViews.map(({ answer: _answer, humanActions: _actions, ...view }) => ({
      ...view,
      summary: null,
      sessions: [],
    })),
  };
}

function bareMinimum(snapshot: NeoSnapshot): NeoSnapshot {
  return {
    ok: true,
    sessionId: snapshot.sessionId,
    projects: [],
    consultations: [],
    work: snapshot.work.map((item) => ({ ...item, instruction: '', report: null })),
    asks: snapshot.asks?.map((ask) => ({
      ...ask,
      ask: '',
      doneItems: [],
      evidence: null,
      outcome: null,
    })),
    cards: snapshot.cards,
    askViews: snapshot.askViews.map((view) => ({ ...view, summary: null, sessions: [] })),
    standingRules: snapshot.standingRules,
    ...(snapshot.told ? { told: snapshot.told } : {}),
  };
}

export function fitNeoSnapshotBudget<T extends NeoSnapshot>(
  snapshot: T,
  budget: number,
  { focused = false }: { focused?: boolean } = {}
): T {
  if (size(snapshot) <= budget) return snapshot;
  const room = budget - TRIMMED_NOTE_RESERVE;
  let fitted: NeoSnapshot = focused ? snapshot : withoutSettled(snapshot);
  if (size(fitted) > room) fitted = withShortText(fitted);
  const openAsks = fitted.asks?.length ?? 0;
  if (!focused)
    for (let count = fitted.asks?.length ?? 0; size(fitted) > room && count > 1; )
      fitted = withNewestAsks(fitted, (count = Math.floor(count / 2)));
  if (size(fitted) > room) fitted = withBareText(fitted);
  if (size(fitted) <= room)
    return {
      ...fitted,
      trimmed: focused
        ? NEO_SNAPSHOT_FOCUS_TRIMMED
        : neoSnapshotTrimmedNote(openAsks - (fitted.asks?.length ?? 0)),
    } as T;
  fitted = withSkeleton(fitted);
  if (size(fitted) > room) fitted = bareMinimum(fitted);
  if (size(fitted) > room)
    fitted = {
      ok: true,
      sessionId: fitted.sessionId,
      projects: [],
      consultations: [],
      work: [],
      cards: [],
      askViews: [],
      ...(fitted.told ? { told: fitted.told } : {}),
    };
  return {
    ...fitted,
    trimmed: focused ? NEO_SNAPSHOT_FOCUS_TRIMMED : NEO_SNAPSHOT_SKELETON,
  } as T;
}
