import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type {
  NeoAsk,
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
import { neoWorkPrSetback } from './work-prs.ts';

export type NeoAskView = {
  readonly ask: NeoAsk;
  readonly group: NeoSceneGroup;
  readonly label: string;
  readonly done: number;
  readonly doneIds: ReadonlySet<string>;
  readonly total: number;
  readonly scenes: readonly NeoScene[];
};

export type NeoAskOpenTarget = {
  readonly work: NeoWork;
  readonly driver: NeoWorkDriverReceipt | undefined;
  readonly link: string | null;
};

export type NeoAskGroups = {
  readonly asks: Readonly<Record<NeoSceneGroup, readonly NeoAskView[]>>;
  readonly loose: Readonly<Record<NeoSceneGroup, readonly NeoScene[]>>;
};

const askScenes: Record<NeoAskStatus, { group: NeoSceneGroup; label: string }> = {
  open: { group: 'running', label: 'Working on it' },
  waiting: { group: 'running', label: 'Waiting on checks or review' },
  blocked: { group: 'attention', label: 'Blocked · needs you' },
  achieved: { group: 'outcomes', label: 'Done' },
  abandoned: { group: 'outcomes', label: 'Dropped' },
};

export type NeoAskOutcome = 'achieved' | 'abandoned';

export const NEO_ASK_NEEDS_YOU_LABEL = 'Needs you';

export function describeNeoAsk(
  ask: NeoAsk,
  scenes: readonly NeoScene[],
  prs: NeoScenePrs = new Map()
): NeoAskView {
  const truth = askScenes[ask.status];
  const settled = truth.group === 'outcomes';
  const needsYou = !settled && scenes.some((scene) => scene.group === 'attention');
  const doneIds = new Set(
    scenes
      .filter(
        (scene) =>
          scene.group === 'outcomes' &&
          scene.receipt.kind === 'work' &&
          scene.receipt.status === 'reported' &&
          !neoWorkPrSetback(prs.get(scene.ref.id))
      )
      .map((scene) => scene.ref.id)
  );
  return {
    ask,
    group: needsYou ? 'attention' : truth.group,
    label: needsYou ? NEO_ASK_NEEDS_YOU_LABEL : truth.label,
    done: doneIds.size,
    doneIds,
    total: Math.max(ask.workIds.length, scenes.length),
    scenes,
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
  const views = (asks ?? []).map((ask) => {
    const scenes = ask.workIds.flatMap((id) => {
      const scene = byWork.get(id);
      if (!scene) return [];
      owned.add(id);
      return [scene];
    });
    return describeNeoAsk(ask, scenes, prs);
  });
  const pick = (group: NeoSceneGroup) => views.filter((view) => view.group === group);
  const loose = (group: NeoSceneGroup) =>
    (groups?.[group] ?? []).filter((scene) => !owned.has(scene.ref.id));
  return {
    asks: { attention: pick('attention'), running: pick('running'), outcomes: pick('outcomes') },
    loose: {
      attention: loose('attention'),
      running: loose('running'),
      outcomes: loose('outcomes'),
    },
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
