import superpipe, { type PipelineAPI } from 'superpipe';
import type { PendingUserQuestion } from '@hyperneo/shared';
import type { NeoConcernBoard } from './neo-concern-board.ts';
import type { NeoWorkDriverReceipt, NeoWorkPrReceipt } from '@hyperneo/shared/types/neo-snapshot';
import { requireNeoQuestionOrigin, requireNeoQuestionWork } from './work-question.ts';
import { neoWorkDriverLabel } from './work-driver.ts';
import { neoWorkPrInProgress, neoWorkPrLabel } from './work-prs.ts';

type NeoBoardReceipt = NeoConcernBoard['receipts'][number];
type NeoWorkReceipt = Extract<NeoBoardReceipt, { kind: 'work' }>;
type NeoConsultationReceipt = Extract<NeoBoardReceipt, { kind: 'consultation' }>;

export type NeoSceneRef = { readonly kind: NeoBoardReceipt['kind']; readonly id: string };
export type NeoSceneGroup = 'attention' | 'running' | 'outcomes';
export type NeoScene = {
  readonly ref: NeoSceneRef;
  readonly group: NeoSceneGroup;
  readonly label: string;
  readonly completionVerified: false;
  readonly receipt: NeoBoardReceipt;
};
export type NeoSceneCounts = {
  readonly attention: number;
  readonly running: number;
  readonly outcomes: number;
  readonly total: number;
};
export type NeoSceneGroups = {
  readonly attention: readonly NeoScene[];
  readonly running: readonly NeoScene[];
  readonly outcomes: readonly NeoScene[];
  readonly counts: NeoSceneCounts;
};
export type NeoSceneSelection = { value: NeoScene } | { reason: 'unknown_scene' };
export type NeoSceneQuestions = ReadonlyMap<string, PendingUserQuestion>;
export type NeoSceneUnavailableSessions = ReadonlyMap<string, string>;
export type NeoSceneDrivers = ReadonlyMap<string, NeoWorkDriverReceipt>;
export type NeoScenePrs = ReadonlyMap<string, NeoWorkPrReceipt>;
type SceneTruth = { group: NeoSceneGroup; label: string };

const workScenes: Record<NeoWorkReceipt['status'], SceneTruth> = {
  proposed: { group: 'attention', label: 'Your call' },
  queued: { group: 'running', label: 'Handed to HyperNeo' },
  reported: { group: 'outcomes', label: 'Response ready' },
  failed: { group: 'outcomes', label: 'Failed' },
  cancelled: { group: 'outcomes', label: 'Stopped' },
};

const consultationScenes: Record<NeoConsultationReceipt['status'], SceneTruth> = {
  pending: { group: 'running', label: 'Checking context' },
  queued: { group: 'running', label: 'Waiting for context' },
  reported: { group: 'outcomes', label: 'Response ready' },
  failed: { group: 'attention', label: 'Needs attention' },
};

export function admitNeoSceneReceipts(
  board: NeoConcernBoard | null
): { value: readonly NeoBoardReceipt[] } | { reason: null } {
  if (!board || !Array.isArray(board.receipts)) return { reason: null };
  return { value: board.receipts };
}

export function classifyNeoScene(receipt: NeoBoardReceipt): NeoScene {
  const truth =
    receipt.kind === 'work' ? workScenes[receipt.status] : consultationScenes[receipt.status];
  return {
    ref: { kind: receipt.kind, id: receipt.id },
    group: truth.group,
    label: truth.label,
    completionVerified: false,
    receipt,
  };
}

export function classifyNeoScenes(receipts: readonly NeoBoardReceipt[]): NeoScene[] {
  return receipts.map(classifyNeoScene);
}

export function promoteNeoQuestionScene(
  scene: NeoScene,
  question: PendingUserQuestion | undefined
): NeoScene {
  const work = scene.receipt;
  if (work.kind !== 'work' || !question) return scene;
  return 'value' in requireNeoQuestionWork(work, work.sessionId ?? null, true) &&
    'value' in requireNeoQuestionOrigin(question, work)
    ? { ...scene, group: 'attention', label: NEO_QUICK_CHOICE_LABEL }
    : scene;
}

export const NEO_QUICK_CHOICE_LABEL = 'A quick choice';

export function promoteNeoQuestionScenes(
  scenes: readonly NeoScene[],
  questions: NeoSceneQuestions
): NeoScene[] {
  return scenes.map((scene) => promoteNeoQuestionScene(scene, questions.get(scene.ref.id)));
}

const driverSceneGroups: Partial<
  Record<NonNullable<NeoWorkDriverReceipt['status']>, NeoSceneGroup>
> = {
  needs_you: 'attention',
  failed: 'outcomes',
  stopped: 'outcomes',
};

export function describeNeoDriverScenes(
  scenes: readonly NeoScene[],
  drivers: NeoSceneDrivers
): NeoScene[] {
  return scenes.map((scene) => {
    const driver = drivers.get(scene.ref.id);
    if (scene.receipt.kind !== 'work' || scene.receipt.status !== 'queued' || !driver) return scene;
    return {
      ...scene,
      group: (driver.status && driverSceneGroups[driver.status]) || scene.group,
      label: neoWorkDriverLabel(driver),
    };
  });
}

export function describeNeoPrScenes(scenes: readonly NeoScene[], prs: NeoScenePrs): NeoScene[] {
  return scenes.map((scene) => {
    const receipt = prs.get(scene.ref.id);
    const label = neoWorkPrLabel(receipt);
    if (scene.receipt.kind !== 'work' || scene.receipt.status !== 'reported' || !label) {
      return scene;
    }
    return { ...scene, group: neoWorkPrInProgress(receipt) ? 'running' : scene.group, label };
  });
}

function promoteNeoUnavailableScenes(
  scenes: NeoScene[],
  unavailableSessions: NeoSceneUnavailableSessions
): NeoScene[] {
  return scenes.map((scene) => {
    const work = scene.receipt;
    return work.kind === 'work' &&
      !!work.sessionId &&
      unavailableSessions.get(work.id) === work.sessionId &&
      'value' in requireNeoQuestionWork(work, work.sessionId, true)
      ? { ...scene, group: 'attention', label: 'Could not check questions' }
      : scene;
  });
}

export function groupNeoScenes(scenes: readonly NeoScene[]): NeoSceneGroups {
  const attention: NeoScene[] = [];
  const running: NeoScene[] = [];
  const outcomes: NeoScene[] = [];
  for (const scene of scenes) {
    if (scene.group === 'attention') attention.push(scene);
    else if (scene.group === 'running') running.push(scene);
    else outcomes.push(scene);
  }
  return {
    attention,
    running,
    outcomes,
    counts: {
      attention: attention.length,
      running: running.length,
      outcomes: outcomes.length,
      total: scenes.length,
    },
  };
}

export function selectNeoScene(
  groups: NeoSceneGroups | null,
  ref: NeoSceneRef | null
): NeoSceneSelection {
  if (!groups || !ref) return { reason: 'unknown_scene' };
  for (const group of [groups.attention, groups.running, groups.outcomes]) {
    for (const scene of group) {
      if (scene.ref.kind === ref.kind && scene.ref.id === ref.id) return { value: scene };
    }
  }
  return { reason: 'unknown_scene' };
}

export function hideNeoInternalReceipts(receipts: readonly NeoBoardReceipt[]): NeoBoardReceipt[] {
  return receipts.filter(
    (receipt) =>
      receipt.kind !== 'consultation' &&
      !(receipt.kind === 'work' && receipt.status === 'cancelled' && !receipt.sessionId)
  );
}

const projectScenes = (superpipe({})('neo-scenes') as PipelineAPI)
  .input(['board', 'questions', 'unavailableSessions', 'drivers', 'prs'])
  .pipe(admitNeoSceneReceipts, 'board', 'result:scenes')
  .pipe(hideNeoInternalReceipts, 'scenes', 'visible')
  .pipe(classifyNeoScenes, 'visible', 'classified')
  .pipe(describeNeoDriverScenes, ['classified', 'drivers'], 'driven')
  .pipe(describeNeoPrScenes, ['driven', 'prs'], 'described')
  .pipe(promoteNeoQuestionScenes, ['described', 'questions'], 'promoted')
  .pipe(promoteNeoUnavailableScenes, ['promoted', 'unavailableSessions'], 'observed')
  .pipe(groupNeoScenes, 'observed', 'scenes')
  .end('scenes') as (
  board: NeoConcernBoard | null,
  questions: NeoSceneQuestions,
  unavailableSessions: NeoSceneUnavailableSessions,
  drivers: NeoSceneDrivers,
  prs: NeoScenePrs
) => NeoSceneGroups | null;

export function projectNeoScenes(
  board: NeoConcernBoard | null,
  questions: NeoSceneQuestions = new Map(),
  unavailableSessions: NeoSceneUnavailableSessions = new Map(),
  drivers: NeoSceneDrivers = new Map(),
  prs: NeoScenePrs = new Map()
): NeoSceneGroups | null {
  return projectScenes(board, questions, unavailableSessions, drivers, prs);
}
