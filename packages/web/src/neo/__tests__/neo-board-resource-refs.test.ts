import { describe, expect, it } from 'vitest';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import type { DaemonSnapshot } from '@hyperneo/shared/types/daemon-snapshot';
import { projectNeoConcernBoard } from '../neo-concern-board.ts';
import { projectNeoRequestSnapshot } from '../request-board.ts';

const work = (id: string, concernId: string): NeoWork => ({
  id,
  requestKey: id,
  concernId,
  originSessionId: 'root',
  originMessageId: `ask-${id}`,
  title: id,
  instruction: 'Draft only',
  sessionId: 'shared-manager',
  status: 'reported',
  report: 'Claim only',
  createdAt: 1,
  updatedAt: 2,
});
const taskA = { kind: 'task', id: 'draft:α/A' };
const taskB = { kind: 'task', id: 'draft:β/B' };
const source: NeoSnapshot = {
  ok: true,
  sessionId: 'root',
  concerns: ['A', 'B'].map((id) => ({
    id,
    title: id,
    summary: id,
    context: id,
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
  })),
  work: [work('A', 'A'), work('B', 'B')],
  workResources: [
    { workId: 'A', refs: [taskA] },
    { workId: 'B', refs: [taskB] },
  ],
  askOrigins: ['A', 'B'].map((id) => ({
    kind: 'work',
    id,
    origin: { sessionId: 'root', messageId: `ask-${id}` },
  })),
};
const inventory: DaemonSnapshot = {
  capturedAt: 123,
  capabilities: [],
  resources: [
    {
      kind: 'task',
      total: 3,
      truncated: true,
      entries: [taskA, taskB].map((ref) => ({
        id: ref.id,
        name: ref.id,
        status: 'draft',
        updatedAt: 2,
        workspacePath: null,
        links: [],
      })),
    },
  ],
};
const participants = (
  snapshot: NeoSnapshot,
  concernId: string | null = 'A',
  world: DaemonSnapshot | null = inventory
) => projectNeoConcernBoard(snapshot, concernId, world)?.participants ?? [];

describe('exact work resource seeds on Neo boards', () => {
  it('keeps different receipts sharing one native manager separate without mutation', () => {
    const before = structuredClone(source);
    const board = projectNeoConcernBoard(source, 'A', inventory);
    expect(board?.participants.map((row) => row.ref)).toContainEqual(taskA);
    expect(board?.participants.map((row) => row.ref)).not.toContainEqual(taskB);
    expect(board?.participants.find((row) => row.ref.id === taskA.id)?.metadata?.status).toBe(
      'draft'
    );
    expect(board?.truncatedKinds).toEqual(['task']);
    expect(source).toEqual(before);
  });
  it('request scoping removes unrelated resource sidecars and uses exact ask identity', () => {
    const scoped = projectNeoRequestSnapshot(source, { sessionId: 'root', messageId: 'ask-A' });
    expect(scoped?.workResources).toEqual([{ workId: 'A', refs: [taskA] }]);
    expect(participants(scoped!, null).map((row) => row.ref)).toContainEqual(taskA);
    expect(participants(scoped!, null).map((row) => row.ref)).not.toContainEqual(taskB);
  });
  it.each([undefined, [], [{ workId: 'A', refs: null }], [{ workId: 'A', refs: [] }]])(
    'legacy, unknown and explicit empty refs never infer manager tasks: %j',
    (workResources) => {
      expect(
        participants({ ...source, workResources }).filter((row) => row.ref.kind === 'task')
      ).toEqual([]);
    }
  );
  it('ambiguous duplicate receipt rows fail closed instead of merging resource claims', () => {
    const workResources = [
      { workId: 'A', refs: [taskA] },
      { workId: 'A', refs: [taskB] },
    ];
    expect(
      participants({ ...source, workResources }).filter((row) => row.ref.kind === 'task')
    ).toEqual([]);
  });
  it('foreign receipt IDs and beyond-bound sets do not seed participants', () => {
    const workResources = [
      { workId: 'missing', refs: [taskB] },
      { workId: 'A', refs: Array.from({ length: 17 }, () => taskA) },
    ];
    expect(
      participants({ ...source, workResources }).filter((row) => row.ref.kind === 'task')
    ).toEqual([]);
  });
  it('unknown future kinds remain exact references, never invented deletion or completion', () => {
    const future = { kind: 'future primitive', id: '  opaque/世界  ' };
    const board = participants(
      { ...source, workResources: [{ workId: 'A', refs: [future] }] },
      'A',
      null
    );
    expect(board.find((row) => row.ref.kind === future.kind)).toEqual({
      ref: future,
      metadata: null,
    });
  });
});
