import { describe, expect, it } from 'vitest';
import type { NeoConcern, NeoConsultation, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import type { DaemonInventoryLink, DaemonSnapshot } from '@hyperneo/shared/types/daemon-snapshot';
import {
  selectNeoConcernBoard,
  neoBoardReceipts,
  neoBoardReferences,
  observedNeoBoardResources,
  projectNeoConcernBoard,
} from '../neo-concern-board.ts';

const ref = (kind: string, id: string): DaemonInventoryLink => ({ kind, id });
const concern = (id: string): NeoConcern => ({
  id,
  title: id,
  summary: 'Summary',
  context: 'Context',
  revision: 1,
  createdAt: 1,
  updatedAt: 2,
});
const work = (id: string, concernId: string | null, sessionId: string | null = null): NeoWork => ({
  id,
  requestKey: id,
  concernId,
  originSessionId: 'root',
  originMessageId: null,
  title: id,
  instruction: 'Do this',
  sessionId,
  status: sessionId ? 'queued' : 'proposed',
  report: null,
  createdAt: 2,
  updatedAt: 3,
});
const check = (id: string, concernId: string): NeoConsultation => ({
  ...{ originMessageId: null },
  id,
  requestKey: id,
  concernId,
  originSessionId: 'root',
  sessionId: `${concernId}-holder`,
  question: 'Next?',
  status: 'pending',
  answer: null,
  createdAt: 1,
});
const snapshot: NeoSnapshot = {
  ok: true,
  sessionId: 'root',
  concerns: [concern('a'), concern('b')],
  work: [work('a-work', 'a', 'a-worker'), work('b-work', 'b', 'b-worker'), work('one-off', null)],
  consultations: [check('a-check', 'a'), check('b-check', 'b')],
};
type Row = { kind: string; id: string; links?: DaemonInventoryLink[] };
function inventory(rows: Row[], truncatedKinds: string[] = []): DaemonSnapshot {
  const kinds = [...new Set([...rows.map((row) => row.kind), ...truncatedKinds])];
  return {
    capturedAt: 123,
    capabilities: [],
    resources: kinds.map((kind) => ({
      kind,
      truncated: truncatedKinds.includes(kind),
      total:
        rows.filter((row) => row.kind === kind).length + (truncatedKinds.includes(kind) ? 1 : 0),
      entries: rows
        .filter((row) => row.kind === kind)
        .map((row) => ({
          id: row.id,
          name: `Name ${row.id}`,
          status: 'active',
          updatedAt: 10,
          workspacePath: null,
          links: row.links ?? [],
        })),
    })),
  };
}
const selection = () => {
  const result = selectNeoConcernBoard(snapshot, 'a');
  if ('reason' in result) throw new Error('Expected concern A');
  return result.value;
};

describe('selectNeoConcernBoard', () => {
  it.each([
    [null, null],
    [null, 'a'],
    [snapshot, 'missing'],
  ] as const)('has no board for an unavailable scope: %j', (source, id) => {
    expect(selectNeoConcernBoard(source, id)).toEqual({ reason: null });
    expect(projectNeoConcernBoard(source, id, null)).toBeNull();
  });
  it('keeps overview one-offs but excludes unrelated concerns in a selected board', () => {
    expect(projectNeoConcernBoard(snapshot, null, null)?.receipts).toHaveLength(5);
    const result = selectNeoConcernBoard(snapshot, 'a');
    if ('reason' in result) throw new Error('Expected concern A');
    const selected = result.value;
    expect(selected.concern?.id).toBe('a');
    expect(selected.work.map((item) => item.id)).toEqual(['a-work']);
    expect(selected.consultations.map((item) => item.id)).toEqual(['a-check']);
  });
});

describe('neoBoardReceipts', () => {
  it('preserves actual statuses, evidence and distinct kind/id identities', () => {
    const selected = selection();
    selected.work[0] = { ...selected.work[0], status: 'reported', report: 'Verified result' };
    selected.consultations[0] = { ...selected.consultations[0], id: 'a-work', createdAt: 2 };
    expect(neoBoardReceipts(selected)).toMatchObject([
      { kind: 'consultation', id: 'a-work', status: 'pending' },
      { kind: 'work', id: 'a-work', status: 'reported', report: 'Verified result' },
    ]);
  });
});

describe('neoBoardReferences', () => {
  it('grounds references in the recorded sessions without making context holders workers', () => {
    const selected = selection();
    expect(neoBoardReferences(selected, neoBoardReceipts(selected))).toEqual({
      seeds: [
        ref('session', 'root'),
        ref('session', 'root'),
        ref('session', 'root'),
        ref('session', 'a-worker'),
        ref('session', 'a-holder'),
      ],
      targets: [ref('session', 'a-worker'), ref('session', 'a-holder')],
    });
    const proposed = projectNeoConcernBoard(
      { ...snapshot, work: [work('only', null)], consultations: [] },
      null,
      null
    );
    expect(proposed?.participants.map((item) => item.ref)).toEqual([ref('session', 'root')]);
    expect(proposed?.receipts[0].sessionId).toBeNull();
  });
  it('omits empty session references instead of fabricating a participant', () => {
    const selected = { ...selection(), snapshot: { ...snapshot, sessionId: null } };
    const receipts = [{ ...work('empty', 'a', ''), kind: 'work' as const, originSessionId: '' }];
    expect(neoBoardReferences(selected, receipts)).toEqual({ seeds: [], targets: [] });
  });
});

describe('Neo board resource projection', () => {
  it('follows recorded task/agent/workflow links without flooding the board with Space siblings', () => {
    const observed = inventory([
      { kind: 'session', id: 'a-worker', links: [ref('space', 'shared')] },
      {
        kind: 'task',
        id: 'task-a',
        links: [ref('session', 'a-worker'), ref('space', 'shared'), ref('workflow_run', 'run-a')],
      },
      { kind: 'agent', id: 'agent-a', links: [ref('session', 'a-worker'), ref('space', 'shared')] },
      { kind: 'workflow_run', id: 'run-a', links: [ref('workflow', 'flow-a')] },
      { kind: 'workflow', id: 'flow-a', links: [ref('space', 'shared')] },
      { kind: 'space', id: 'shared' },
      {
        kind: 'task',
        id: 'unrelated-task',
        links: [ref('space', 'shared'), ref('session', 'b-worker')],
      },
      { kind: 'session', id: 'unrelated-child', links: [ref('session', 'root')] },
    ]);
    const board = projectNeoConcernBoard(snapshot, 'a', observed)!;
    expect(board.participants.map((item) => item.ref)).toEqual([
      ref('agent', 'agent-a'),
      ref('session', 'a-holder'),
      ref('session', 'a-worker'),
      ref('session', 'root'),
      ref('space', 'shared'),
      ref('task', 'task-a'),
      ref('workflow', 'flow-a'),
      ref('workflow_run', 'run-a'),
    ]);
    expect(board.relations).toContainEqual({
      from: ref('task', 'task-a'),
      to: ref('session', 'a-worker'),
    });
    expect(board.participants.find((item) => item.ref.id === 'a-worker')?.metadata?.status).toBe(
      'active'
    );
    expect(board.inventoryCapturedAt).toBe(123);
  });
  it('supports new resource kinds, cycles and duplicate relationships deterministically', () => {
    const observed = inventory([
      {
        kind: 'session',
        id: 'a-worker',
        links: [ref('research_dataset', 'data'), ref('research_dataset', 'data')],
      },
      { kind: 'research_dataset', id: 'data', links: [ref('session', 'a-worker')] },
    ]);
    const refs = {
      seeds: [ref('session', 'a-worker'), ref('session', 'a-worker')],
      targets: [ref('session', 'a-worker')],
    };
    const graph = observedNeoBoardResources(refs, observed);
    expect(graph.participants).toHaveLength(2);
    expect(graph.relations).toHaveLength(2);
    expect(
      observedNeoBoardResources(refs, { ...observed, resources: [...observed.resources].reverse() })
    ).toEqual(graph);
  });
  it('keeps opaque kind/id references distinct even when colon concatenation would collide', () => {
    const refs = { seeds: [ref('session', 'a:b'), ref('session:a', 'b')], targets: [] };
    expect(observedNeoBoardResources(refs, null).participants.map((item) => item.ref)).toEqual(
      refs.seeds
    );
  });
  it('retains unknown references and flags bounded inventory rather than claiming deletion', () => {
    const observed = inventory(
      [{ kind: 'session', id: 'a-worker', links: [ref('goal', 'older-goal')] }],
      ['goal', 'agent']
    );
    const board = projectNeoConcernBoard(snapshot, 'a', observed)!;
    expect(board.participants.find((item) => item.ref.id === 'older-goal')).toEqual({
      ref: ref('goal', 'older-goal'),
      metadata: null,
    });
    expect(board.participants.find((item) => item.ref.id === 'a-holder')?.metadata).toBeNull();
    expect(board.truncatedKinds).toEqual(['agent', 'goal']);
    expect(projectNeoConcernBoard(snapshot, 'a', null)).toMatchObject({
      inventoryCapturedAt: null,
      truncatedKinds: [],
    });
  });
  it('does not mutate source receipts, resource metadata or relationships', () => {
    const observed = inventory([
      { kind: 'session', id: 'a-worker', links: [ref('space', 'shared')] },
    ]);
    const original = JSON.stringify({ snapshot, observed });
    projectNeoConcernBoard(snapshot, 'a', observed);
    projectNeoConcernBoard(snapshot, null, observed);
    expect(JSON.stringify({ snapshot, observed })).toBe(original);
  });
});
