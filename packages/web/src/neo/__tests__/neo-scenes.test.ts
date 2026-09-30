import type {
  NeoConsultation,
  NeoConsultationWaiter,
  NeoWork,
} from '@hyperneo/shared/types/neo-context';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { describe, expect, it } from 'vitest';
import { type NeoConcernBoard, projectNeoConcernBoard } from '../neo-concern-board.ts';
import {
  admitNeoSceneReceipts,
  classifyNeoScene,
  classifyNeoScenes,
  groupNeoScenes,
  type NeoSceneRef,
  projectNeoScenes,
  selectNeoScene,
} from '../neo-scenes.ts';

type NeoBoardReceipt = NeoConcernBoard['receipts'][number];
type Group = 'attention' | 'running' | 'outcomes';
type SceneRow = readonly [NeoBoardReceipt['kind'], string, Group, string, NeoBoardReceipt];

const check = (id: string, status: NeoConsultation['status'], at: number): NeoConsultation => ({
  id,
  requestKey: id,
  concernId: 'a',
  originSessionId: 'root',
  originMessageId: `ask-${id}`,
  sessionId: `${id}-holder`,
  question: `Question ${id}`,
  status,
  answer: status === 'reported' ? 'Yes' : null,
  createdAt: at,
});
const waiter = (id: string, at: number): NeoConsultationWaiter => {
  const { answer, ...queued } = check(id, 'pending', at);
  return { ...queued, originMessageId: `ask-${id}`, status: 'queued' };
};
const work = (
  id: string,
  status: NeoWork['status'],
  createdAt: number,
  concernId: string | null = 'a'
): NeoWork => ({
  id,
  requestKey: id,
  concernId,
  originSessionId: 'root',
  originMessageId: `ask-${id}`,
  title: `Title ${id}`,
  instruction: `Instruction ${id}`,
  sessionId: status === 'proposed' ? null : `${id}-session`,
  status,
  report: status === 'reported' ? `Report ${id}` : null,
  createdAt,
  updatedAt: createdAt + 1,
});
const wRow = (status: NeoWork['status'], group: Group, label: string, at: number): SceneRow => [
  'work',
  status,
  group,
  label,
  { ...work(`w-${status}`, status, at), kind: 'work' },
];
type CheckStatus = NeoConsultation['status'] | 'queued';
const cRow = (status: CheckStatus, group: Group, label: string, at: number): SceneRow => [
  'consultation',
  status,
  group,
  label,
  {
    ...(status === 'queued' ? waiter(`c-${status}`, at) : check(`c-${status}`, status, at)),
    kind: 'consultation',
    status,
    answer: null,
  },
];

const rows: SceneRow[] = [
  wRow('proposed', 'attention', 'Your call', 10),
  wRow('failed', 'attention', 'Needs attention', 40),
  wRow('queued', 'running', 'Handed to HyperNeo', 20),
  wRow('reported', 'outcomes', 'Response ready', 30),
  wRow('cancelled', 'outcomes', 'Stopped', 50),
  cRow('pending', 'running', 'Checking context', 60),
  cRow('failed', 'attention', 'Needs attention', 80),
  cRow('reported', 'outcomes', 'Response ready', 70),
  cRow('queued', 'running', 'Waiting for context', 90),
];

const receipts = rows.map((row) => row[4]);
type Check = Extract<NeoBoardReceipt, { kind: 'consultation' }> & {
  status: NeoConsultation['status'];
};
const isCheck = (r: NeoBoardReceipt): r is Check =>
  r.kind === 'consultation' && r.status !== 'queued';
const fullSnapshot: NeoSnapshot = {
  ok: true,
  sessionId: 'root',
  concerns: [
    { id: 'a', title: 'A', summary: 'A', context: 'A', revision: 1, createdAt: 1, updatedAt: 2 },
    { id: 'b', title: 'B', summary: 'B', context: 'B', revision: 1, createdAt: 1, updatedAt: 2 },
  ],
  work: receipts.filter((r) => r.kind === 'work'),
  consultations: receipts.filter(isCheck),
  consultationWaiters: [waiter('c-queued', 90)],
};

const boardFor = (
  snap: NeoSnapshot = fullSnapshot,
  concernId: string | null = null
): NeoConcernBoard => {
  const board = projectNeoConcernBoard(snap, concernId, null);
  if (!board) throw new Error(`Expected a board for ${concernId ?? 'overview'}`);
  return board;
};
const ids = (scenes: readonly { ref: NeoSceneRef }[]) => scenes.map((scene) => scene.ref.id);

describe('classifyNeoScene', () => {
  it.each(rows)('reads %s %s as %s labelled %s', (kind, status, group, label, receipt) => {
    const scene = classifyNeoScene(receipt);
    expect([scene.group, scene.label, scene.ref, receipt.status]).toEqual([
      group,
      label,
      { kind, id: receipt.id },
      status,
    ]);
  });

  it('treats a pending or queued consultation as internal progress, not your attention', () => {
    const checks = rows.filter((r) => r[0] === 'consultation').map((r) => classifyNeoScene(r[4]));
    expect(checks.filter((s) => s.group === 'running').map((s) => s.label)).toEqual([
      'Checking context',
      'Waiting for context',
    ]);
  });

  it('never claims a reported response is verified or accepted', () => {
    const reported = rows.filter((r) => r[1] === 'reported').map((r) => classifyNeoScene(r[4]));
    expect(reported.map((scene) => [scene.group, scene.completionVerified])).toEqual([
      ['outcomes', false],
      ['outcomes', false],
    ]);
  });

  it('carries the original receipt text, origin and report bytes', () => {
    const receipt = boardFor().receipts.find((item) => item.id === 'w-reported');
    if (receipt?.kind !== 'work') throw new Error('Expected a reported work receipt');
    expect([
      classifyNeoScene(receipt).receipt === receipt,
      receipt.instruction,
      receipt.report,
    ]).toEqual([true, 'Instruction w-reported', 'Report w-reported']);
    expect([receipt.originMessageId, receipt.originSessionId]).toEqual(['ask-w-reported', 'root']);
  });
});

describe('groupNeoScenes', () => {
  it('groups the whole status table once each, in board order', () => {
    const board = boardFor();
    const before = structuredClone(board.receipts);
    const scenes = groupNeoScenes(classifyNeoScenes(board.receipts));
    const all = [...scenes.attention, ...scenes.running, ...scenes.outcomes];
    expect([
      [ids(scenes.attention), ids(scenes.running), ids(scenes.outcomes)],
      scenes.counts,
      [all.length, new Set(all.map((s) => `${s.ref.kind}:${s.ref.id}`)).size],
      board.receipts,
      projectNeoScenes(board),
    ]).toEqual([
      [
        ['c-failed', 'w-failed', 'w-proposed'],
        ['c-queued', 'c-pending', 'w-queued'],
        ['c-reported', 'w-cancelled', 'w-reported'],
      ],
      { attention: 3, running: 3, outcomes: 3, total: 9 },
      [9, 9],
      before,
      scenes,
    ]);
  });
});

describe('projectNeoScenes', () => {
  it('is honest about a missing board, an empty overview and a concern holding no work', () => {
    const board = boardFor();
    const admitted = admitNeoSceneReceipts(board);
    if (!('value' in admitted)) throw new Error('Expected admitted receipts');
    expect(admitted.value).toBe(board.receipts);
    const empty = projectNeoScenes(
      boardFor({ ...fullSnapshot, work: [], consultations: [], consultationWaiters: [] })
    );
    if (!empty) throw new Error('Expected an empty projection');
    expect([admitNeoSceneReceipts(null), projectNeoScenes(null), empty.counts]).toEqual([
      { reason: null },
      null,
      { attention: 0, running: 0, outcomes: 0, total: 0 },
    ]);
    expect(projectNeoScenes(boardFor(fullSnapshot, 'b'))?.counts.total).toBe(0);
    expect(projectNeoConcernBoard(fullSnapshot, 'missing', null)).toBeNull();
  });

  it('projects only the receipts of the selected concern', () => {
    const scoped: NeoSnapshot = {
      ...fullSnapshot,
      work: [work('a-work', 'queued', 10, 'a'), work('b-work', 'failed', 20, 'b')],
    };
    const scenes = projectNeoScenes(boardFor(scoped, 'b'));
    if (!scenes) throw new Error('Expected a projection');
    expect([ids(scenes.attention), scenes.counts.total]).toEqual([['b-work'], 1]);
  });
});

describe('selectNeoScene', () => {
  it('keeps a work and a consultation with the same id distinct', () => {
    const scenes = projectNeoScenes(
      boardFor({
        ...fullSnapshot,
        work: [work('same', 'queued', 10)],
        consultations: [check('same', 'pending', 20)],
        consultationWaiters: [],
      })
    );
    if (!scenes) throw new Error('Expected a projection');
    const a = selectNeoScene(scenes, { kind: 'work', id: 'same' });
    const b = selectNeoScene(scenes, { kind: 'consultation', id: 'same' });
    if (!('value' in a) || !('value' in b)) throw new Error('Expected both identities');
    expect([a.value.label, b.value.label]).toEqual(['Handed to HyperNeo', 'Checking context']);
  });

  it('resolves a ref by kind and id, stably, under inserted rows', () => {
    const ref: NeoSceneRef = { kind: 'work', id: 'w-queued' };
    const before = selectNeoScene(projectNeoScenes(boardFor()), ref);
    const after = selectNeoScene(
      projectNeoScenes(
        boardFor({
          ...fullSnapshot,
          work: [work('w-newest', 'proposed', 999), ...(fullSnapshot.work ?? [])],
        })
      ),
      ref
    );
    if (!('value' in before) || !('value' in after)) throw new Error('Expected a selection');
    expect([after.value, after.value.ref]).toEqual([before.value, ref]);
  });

  it('answers unknown_scene rather than a fabricated detail', () => {
    const scenes = projectNeoScenes(boardFor());
    if (!scenes) throw new Error('Expected a projection');
    const unknown = { reason: 'unknown_scene' };
    expect([
      selectNeoScene(scenes, { kind: 'work', id: 'nope' }),
      selectNeoScene(scenes, { kind: 'consultation', id: 'w-queued' }),
      selectNeoScene(scenes, null),
      selectNeoScene(null, { kind: 'work', id: 'w-queued' }),
    ]).toEqual([unknown, unknown, unknown, unknown]);
  });
});
