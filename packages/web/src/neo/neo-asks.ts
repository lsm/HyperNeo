import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type {
  NeoAsk,
  NeoAskItem,
  NeoAskStatus,
  NeoWorkDriverReceipt,
} from '@hyperneo/shared/types/neo-snapshot';
import type {
  NeoScene,
  NeoSceneDrivers,
  NeoSceneGroup,
  NeoSceneGroups,
  NeoScenePrs,
} from './neo-scenes.ts';
import { neoWorkDriverLink } from './work-driver.ts';
import { neoWorkPrNumbers, neoWorkPrSetback } from './work-prs.ts';

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
};

export type NeoAskOpenTarget = {
  readonly work: NeoWork;
  readonly driver: NeoWorkDriverReceipt | undefined;
  readonly link: string | null;
};

export type NeoAskGroups = {
  readonly asks: Readonly<Record<NeoSceneGroup, readonly NeoAskView[]>>;
  readonly loose: Readonly<Record<NeoSceneGroup, readonly NeoScene[]>>;
  readonly settledWork: ReadonlySet<string>;
};

const NEO_ASK_SUMMARY_LIMIT = 160;

const askScenes: Record<NeoAskStatus, { group: NeoSceneGroup; label: string }> = {
  open: { group: 'running', label: 'Working on it' },
  waiting: { group: 'attention', label: 'Waiting on you' },
  blocked: { group: 'attention', label: 'Blocked · needs you' },
  achieved: { group: 'outcomes', label: 'Done' },
  abandoned: { group: 'outcomes', label: 'Dropped' },
};

export type NeoAskOutcome = 'achieved' | 'abandoned';

export const NEO_ASK_NEEDS_YOU_LABEL = 'Needs you';

export function neoSupersededAttempts(scenes: readonly NeoScene[]): ReadonlySet<string> {
  const works = scenes.flatMap((scene) => (scene.receipt.kind === 'work' ? [scene.receipt] : []));
  return new Set(
    works
      .filter(
        (work) =>
          work.status === 'failed' &&
          works.some(
            (later) =>
              later.id !== work.id &&
              later.createdAt > work.createdAt &&
              later.title.trim() === work.title.trim()
          )
      )
      .map((work) => work.id)
  );
}

function dropped(scene: NeoScene, superseded: ReadonlySet<string>): boolean {
  return (
    scene.receipt.kind === 'work' &&
    (scene.receipt.status === 'cancelled' || superseded.has(scene.ref.id))
  );
}

export function neoAskSummary(
  ask: NeoAsk,
  scenes: readonly NeoScene[],
  prs: NeoScenePrs = new Map()
): string | null {
  const outcome = ask.outcome?.trim() || null;
  if (!outcome || outcome.length <= NEO_ASK_SUMMARY_LIMIT) return outcome;
  const merged = [
    ...new Set(scenes.flatMap((scene) => neoWorkPrNumbers(prs.get(scene.ref.id), 'MERGED'))),
  ];
  if (ask.status === 'achieved' && merged.length > 0) return `Merged in ${merged.join(', ')}.`;
  const sentence = outcome.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? outcome;
  return sentence.length <= NEO_ASK_SUMMARY_LIMIT
    ? sentence
    : `${sentence.slice(0, NEO_ASK_SUMMARY_LIMIT - 1).trimEnd()}…`;
}

export function neoAskItems(ask: NeoAsk): readonly NeoAskItem[] {
  return ask.doneItems ?? [];
}

export function describeNeoAsk(
  ask: NeoAsk,
  scenes: readonly NeoScene[],
  prs: NeoScenePrs = new Map()
): NeoAskView {
  const truth = askScenes[ask.status];
  const settled = truth.group === 'outcomes';
  const superseded = neoSupersededAttempts(scenes);
  const live = scenes.filter((scene) => !dropped(scene, superseded));
  const needsYou = !settled && live.some((scene) => scene.group === 'attention');
  const doneIds = new Set(
    live
      .filter(
        (scene) =>
          scene.group === 'outcomes' &&
          scene.receipt.kind === 'work' &&
          scene.receipt.status === 'reported' &&
          !neoWorkPrSetback(prs.get(scene.ref.id))
      )
      .map((scene) => scene.ref.id)
  );
  const items = neoAskItems(ask);
  const counted = items.filter((item) => !item.removed);
  return {
    ask,
    group: needsYou ? 'attention' : truth.group,
    label: needsYou ? NEO_ASK_NEEDS_YOU_LABEL : truth.label,
    settled,
    done: counted.length > 0 ? counted.filter((item) => item.state === 'met').length : doneIds.size,
    doneIds,
    total:
      counted.length > 0
        ? counted.length
        : Math.max(ask.workIds.length, scenes.length) - (scenes.length - live.length),
    scenes: live,
    summary: neoAskSummary(ask, live, prs),
    items,
  };
}

export function groupNeoAsks(
  asks: readonly NeoAsk[] | undefined,
  groups: NeoSceneGroups | null,
  prs: NeoScenePrs = new Map()
): NeoAskGroups {
  const all = groups ? [...groups.attention, ...groups.running, ...groups.outcomes] : [];
  const byWork = new Map(
    all.filter((scene) => scene.ref.kind === 'work').map((scene) => [scene.ref.id, scene])
  );
  const owned = new Set<string>();
  const settledWork = new Set<string>();
  const superseded = neoSupersededAttempts(all);
  const views = (asks ?? []).map((ask) => {
    const scenes = ask.workIds.flatMap((id) => {
      const scene = byWork.get(id);
      if (!scene) return [];
      owned.add(id);
      return [scene];
    });
    const view = describeNeoAsk(ask, scenes, prs);
    if (view.settled) for (const scene of scenes) settledWork.add(scene.ref.id);
    return view;
  });
  const pick = (group: NeoSceneGroup) => views.filter((view) => view.group === group);
  const loose = (group: NeoSceneGroup) =>
    (groups?.[group] ?? []).filter(
      (scene) => !owned.has(scene.ref.id) && !superseded.has(scene.ref.id)
    );
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
  drivers: NeoSceneDrivers = new Map()
): NeoAskOpenTarget | null {
  const reachable = view.scenes.flatMap((scene): NeoAskOpenTarget[] => {
    const work = scene.receipt;
    if (work.kind !== 'work') return [];
    const driver = drivers.get(work.id);
    const link = work.sessionId ? null : neoWorkDriverLink(driver);
    return work.sessionId || link ? [{ work, driver, link }] : [];
  });
  return (
    reachable.findLast((target) => target.work.status === 'queued') ?? reachable.at(-1) ?? null
  );
}

export function neoAskApproval(
  ask: Pick<NeoAsk, 'approvedAt' | 'approvedContinues' | 'approvedContinueLimit' | 'approvedUntil'>,
  now: number
): { line: string; spent: boolean } | null {
  if (!ask.approvedAt) return null;
  const used = ask.approvedContinues ?? 0;
  const limit = ask.approvedContinueLimit;
  const spent =
    (limit !== undefined && used >= limit) ||
    (ask.approvedUntil !== undefined && now > ask.approvedUntil);
  const count =
    limit !== undefined ? `${used} of ${limit} continues used` : `${used} continues used`;
  return { line: spent ? `${count} · approval ran out` : count, spent };
}
