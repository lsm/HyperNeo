import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type {
  NeoAsk,
  NeoAskAnswer,
  NeoAskHumanAction,
  NeoAskItem,
  NeoAskSessionView,
  NeoAskView as NeoAskSnapshotView,
  NeoCardView,
} from '@hyperneo/shared/types/neo-snapshot';
import type { NeoScene, NeoSceneCards, NeoSceneGroup, NeoSceneGroups } from './neo-scenes.ts';

export type NeoAskView = {
  readonly ask: NeoAsk;
  readonly group: NeoSceneGroup;
  readonly label: string;
  readonly settled: boolean;
  readonly done: number;
  readonly doneIds: ReadonlySet<string>;
  readonly total: number;
  readonly scenes: readonly NeoScene[];
  readonly summary: string | null;
  readonly items: readonly NeoAskItem[];
  readonly sessions: readonly NeoAskSessionView[];
  readonly answer: NeoAskAnswer | null;
  readonly humanActions: readonly NeoAskHumanAction[];
};

export type NeoAskOpenTarget = {
  readonly work: NeoWork;
  readonly card: NeoCardView | undefined;
  readonly link: string | null;
};

export type NeoAskGroups = {
  readonly asks: Readonly<Record<NeoSceneGroup, readonly NeoAskView[]>>;
  readonly loose: Readonly<Record<NeoSceneGroup, readonly NeoScene[]>>;
  readonly settledWork: ReadonlySet<string>;
};

export type NeoAskOutcome = 'achieved' | 'abandoned';

export const NEO_ASK_NEEDS_YOU_LABEL = 'Needs you';

function replaced(scene: NeoScene, cards: NeoSceneCards): boolean {
  return (
    scene.receipt.kind === 'work' &&
    scene.receipt.status === 'failed' &&
    !!cards.get(scene.ref.id)?.superseded
  );
}

export function neoAskItems(ask: NeoAsk): readonly NeoAskItem[] {
  return ask.doneItems ?? [];
}

export function describeNeoAskFromView(
  ask: NeoAsk,
  scenes: readonly NeoScene[],
  published: NeoAskSnapshotView
): NeoAskView {
  const liveIds = new Set(published.workIds);
  const live = scenes.filter((scene) => liveIds.has(scene.ref.id));
  const needsYou =
    !published.settled && (published.needsYou || live.some((scene) => scene.group === 'attention'));
  return {
    ask,
    group: needsYou ? 'attention' : published.group,
    label: needsYou ? NEO_ASK_NEEDS_YOU_LABEL : published.label,
    settled: published.settled,
    done: published.done,
    doneIds: new Set(published.doneWorkIds),
    total: published.total,
    scenes: live,
    summary: published.summary,
    items: neoAskItems(ask),
    sessions: published.sessions ?? [],
    answer: published.answer ?? null,
    humanActions: published.settled ? [] : (published.humanActions ?? []),
  };
}

export function groupNeoAsks(
  asks: readonly NeoAsk[] | undefined,
  groups: NeoSceneGroups | null,
  askViews: readonly NeoAskSnapshotView[] | undefined,
  cards: NeoSceneCards = new Map()
): NeoAskGroups {
  const published = new Map((askViews ?? []).map((view) => [view.askId, view]));
  const all = groups ? [...groups.attention, ...groups.running, ...groups.outcomes] : [];
  const byWork = new Map(
    all.filter((scene) => scene.ref.kind === 'work').map((scene) => [scene.ref.id, scene])
  );
  const owned = new Set<string>();
  const settledWork = new Set<string>();
  const views = (asks ?? []).flatMap((ask) => {
    const snapshotView = published.get(ask.id);
    if (!snapshotView) return [];
    const scenes = ask.workIds.flatMap((id) => {
      const scene = byWork.get(id);
      if (!scene) return [];
      owned.add(id);
      return [scene];
    });
    const view = describeNeoAskFromView(ask, scenes, snapshotView);
    if (view.settled) for (const scene of scenes) settledWork.add(scene.ref.id);
    return [view];
  });
  const pick = (group: NeoSceneGroup) => views.filter((view) => view.group === group);
  const loose = (group: NeoSceneGroup) =>
    (groups?.[group] ?? []).filter((scene) => !owned.has(scene.ref.id) && !replaced(scene, cards));
  return {
    asks: { attention: pick('attention'), running: pick('running'), outcomes: pick('outcomes') },
    loose: {
      attention: loose('attention'),
      running: loose('running'),
      outcomes: loose('outcomes'),
    },
    settledWork,
  };
}

export function neoAskOpenTarget(
  view: NeoAskView,
  cards: NeoSceneCards = new Map()
): NeoAskOpenTarget | null {
  const reachable = view.scenes.flatMap((scene): NeoAskOpenTarget[] => {
    const work = scene.receipt;
    if (work.kind !== 'work') return [];
    const card = cards.get(work.id);
    const link = work.sessionId ? null : (card?.open.link ?? null);
    return work.sessionId || link ? [{ work, card, link }] : [];
  });
  return (
    reachable.findLast((target) => target.work.status === 'queued') ?? reachable.at(-1) ?? null
  );
}

export function neoAskApproval(
  ask: Pick<NeoAsk, 'approvedAt' | 'approvedContinues' | 'approvedContinueLimit'>,
  actions: readonly NeoAskHumanAction[]
): { line: string; spent: boolean } | null {
  if (!ask.approvedAt) return null;
  const used = ask.approvedContinues ?? 0;
  const limit = ask.approvedContinueLimit;
  const spent = actions.some((action) => action.kind === 'approve');
  const count =
    limit !== undefined ? `${used} of ${limit} continues used` : `${used} continues used`;
  return { line: spent ? `${count} · approval ran out` : count, spent };
}

export type NeoAskApprovalBadge = { label: string; title: string };

export function neoAskApprovalBadge(
  ask: Pick<NeoAsk, 'approvedAt'>,
  actions: readonly NeoAskHumanAction[]
): NeoAskApprovalBadge | null {
  const approve = actions.find((action) => action.kind === 'approve');
  if (approve?.reason === 'expired')
    return { label: 'Approval expired', title: 'The approval ran out. Approve again to continue.' };
  if (approve?.reason === 'stalled')
    return { label: 'Stalled', title: 'A step stalled. Approve again to continue.' };
  if (!ask.approvedAt) return null;
  return {
    label: 'Approved',
    title: 'You approved this ask: Neo starts its steps without asking again.',
  };
}

export function isNeoAskQuestionItem(
  item: Pick<NeoAskItem, 'kind' | 'question' | 'options' | 'decision'>
): boolean {
  return (
    item.decision === true ||
    item.kind !== undefined ||
    item.question !== undefined ||
    !!item.options?.length
  );
}

export function neoAskOutcomeCount(
  items: readonly NeoAskItem[]
): { verified: number; total: number } | null {
  const outcomes = items.filter((item) => !item.removed && !isNeoAskQuestionItem(item));
  if (!outcomes.length) return null;
  return {
    verified: outcomes.filter((item) => item.state === 'met' && item.metBy !== 'neo').length,
    total: outcomes.length,
  };
}

export type NeoAskItemAction = Extract<NeoAskHumanAction, { kind: 'answer' | 'confirm' }>;

export function neoAskItemActions(view: Pick<NeoAskView, 'humanActions'>): NeoAskItemAction[] {
  return view.humanActions.filter(
    (action): action is NeoAskItemAction => action.kind === 'answer' || action.kind === 'confirm'
  );
}
