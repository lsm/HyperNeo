import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type {
  NeoAsk,
  NeoAskView,
  NeoCardView,
  NeoSnapshot,
} from '@hyperneo/shared/types/neo-snapshot';

const byStatus: Record<
  NeoWork['status'],
  Pick<NeoCardView, 'phase' | 'group' | 'tone' | 'label' | 'actions'>
> = {
  proposed: {
    phase: 'proposed',
    group: 'attention',
    tone: 'accent',
    label: 'Your call',
    actions: ['start', 'cancel'],
  },
  queued: {
    phase: 'handed',
    group: 'running',
    tone: 'accent',
    label: 'Handed to HyperNeo',
    actions: ['done', 'close'],
  },
  reported: {
    phase: 'reported',
    group: 'outcomes',
    tone: 'success',
    label: 'Response ready',
    actions: [],
  },
  failed: {
    phase: 'failed',
    group: 'outcomes',
    tone: 'warning',
    label: 'Failed',
    actions: ['done', 'close'],
  },
  cancelled: {
    phase: 'cancelled',
    group: 'outcomes',
    tone: 'warning',
    label: 'Stopped',
    actions: [],
  },
};

export function testCard(
  work: Pick<NeoWork, 'id' | 'status' | 'sessionId'> & Partial<NeoWork>,
  extra: Partial<NeoCardView> = {}
): NeoCardView {
  return {
    workId: work.id,
    ...byStatus[work.status],
    hidden: work.status === 'cancelled' && !work.sessionId,
    primary:
      work.status === 'proposed'
        ? { kind: 'start', label: 'Start work', link: null }
        : work.sessionId
          ? { kind: 'chat', label: 'Open chat', link: null }
          : { kind: 'none', label: null, link: null },
    adapter: null,
    open: { link: null, remoteLink: null, sessionId: work.sessionId, daemon: null },
    pr: null,
    goal: null,
    doneWhen: null,
    continued: 0,
    continuedMessage: null,
    pooled: false,
    superseded: false,
    uncheckedSince: null,
    unconfirmed: false,
    abandoned: false,
    retryable: false,
    ...extra,
  };
}

const askLabels: Record<NeoAsk['status'], Pick<NeoAskView, 'group' | 'label'>> = {
  open: { group: 'running', label: 'Working on it' },
  waiting: { group: 'attention', label: 'Waiting on you' },
  blocked: { group: 'attention', label: 'Blocked · needs you' },
  achieved: { group: 'outcomes', label: 'Done' },
  abandoned: { group: 'outcomes', label: 'Dropped' },
};

export function testAskView(ask: NeoAsk, extra: Partial<NeoAskView> = {}): NeoAskView {
  const settled = ask.status === 'achieved' || ask.status === 'abandoned';
  return {
    askId: ask.id,
    ...askLabels[ask.status],
    settled,
    needsYou: false,
    done: 0,
    total: ask.workIds.length,
    workIds: ask.workIds,
    doneWorkIds: [],
    summary: ask.outcome,
    ...extra,
  };
}

export function withTestViews<T extends Omit<NeoSnapshot, 'cards' | 'askViews'>>(
  snapshot: T,
  cards: Record<string, Partial<NeoCardView>> = {}
): T & Pick<NeoSnapshot, 'cards' | 'askViews'> {
  return {
    ...snapshot,
    cards: snapshot.work.map((work) => testCard(work, cards[work.id])),
    askViews: (snapshot.asks ?? []).map((ask) => testAskView(ask)),
  };
}

const filled = new WeakMap<object, NeoSnapshot>();

export function withNeoViews<T extends { snapshot: unknown }>(model: T): T {
  const snapshot = model.snapshot as NeoSnapshot | null;
  if (!snapshot || (snapshot.cards?.length && snapshot.askViews)) return model;
  let views = filled.get(snapshot);
  if (!views) {
    views = withTestViews(snapshot);
    filled.set(snapshot, views);
  }
  return { ...model, snapshot: views };
}
