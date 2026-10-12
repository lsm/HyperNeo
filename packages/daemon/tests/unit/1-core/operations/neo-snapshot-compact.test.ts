import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoCardView, NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import {
  compactNeoSnapshotAsks,
  compactNeoSnapshotCards,
  fitNeoSnapshotBudget,
} from '../../../../src/lib/neo/snapshot-compact.ts';

const ask: NeoAsk = {
  id: 'a1',
  requestKey: 'k1',
  concernId: null,
  originSessionId: 'root',
  originMessageId: 'm1',
  title: 'Fix login',
  ask: 'Fix the login bug '.repeat(200),
  doneWhen: '- merged\n- CI green',
  doneSource: 'human',
  status: 'open',
  outcome: null,
  evidence: 'x'.repeat(5000),
  doneItems: [
    {
      id: 'i1',
      text: 'merged',
      check: null,
      state: 'pending',
      evidence: null,
      metBy: null,
      removed: false,
      addedAt: null,
    },
  ],
  workIds: ['w1'],
  createdAt: 1,
  updatedAt: 2,
  settledAt: null,
};

const card = {
  workId: 'w1',
  phase: 'running',
  group: 'running',
  goal: 'Fix the login bug',
  doneWhen: '- merged',
  continued: 2,
  continuedMessage: 'y'.repeat(5000),
} as NeoCardView;

describe('compactNeoSnapshotAsks', () => {
  test('keeps an open ask whole but caps its evidence', () => {
    const [open] = compactNeoSnapshotAsks([ask]);
    expect(open).toMatchObject({ ask: ask.ask, doneWhen: ask.doneWhen, doneItems: ask.doneItems });
    expect(open.evidence).toHaveLength(2000);
  });

  test('drops a settled ask to its identity, status and a short outcome', () => {
    const [settled] = compactNeoSnapshotAsks([
      { ...ask, status: 'achieved', outcome: 'z'.repeat(1000), settledAt: 3 },
    ]);
    expect(settled).toMatchObject({
      id: 'a1',
      title: 'Fix login',
      status: 'achieved',
      ask: '',
      doneWhen: '',
      evidence: null,
      doneItems: [],
      workIds: ['w1'],
    });
    expect(settled.outcome).toHaveLength(300);
  });
});

describe('compactNeoSnapshotCards', () => {
  test('keeps a live card goal and caps its continue message', () => {
    const [live] = compactNeoSnapshotCards([card]);
    expect(live).toMatchObject({ goal: card.goal, doneWhen: card.doneWhen });
    expect(live.continuedMessage).toHaveLength(1000);
  });

  test.each(['stopped', 'pr_setback', 'failed'] as const)(
    'keeps the goal of a %s card Neo still has to act on',
    (phase) => {
      const [kept] = compactNeoSnapshotCards([{ ...card, phase, group: 'outcomes' }]);
      expect(kept).toMatchObject({ goal: card.goal, doneWhen: card.doneWhen });
    }
  );

  test('drops the text of a finished card', () => {
    const [done] = compactNeoSnapshotCards([{ ...card, phase: 'merged', group: 'outcomes' }]);
    expect(done).toMatchObject({
      workId: 'w1',
      phase: 'merged',
      goal: null,
      doneWhen: null,
      continuedMessage: null,
    });
  });
});

describe('fitNeoSnapshotBudget', () => {
  const work = (id: string) => ({
    id,
    requestKey: id,
    concernId: null,
    originSessionId: 'root',
    originMessageId: null,
    title: id,
    instruction: 'i'.repeat(1000),
    sessionId: null,
    status: 'reported' as const,
    report: 'r'.repeat(3000),
    createdAt: 1,
    updatedAt: 1,
  });
  const view = (askId: string) => ({
    askId,
    group: 'running' as const,
    label: 'Working on it',
    settled: false,
    needsYou: false,
    done: 0,
    total: 1,
    workIds: [],
    doneWorkIds: [],
    summary: null,
  });
  const snapshot = (open: number, settled: number): NeoSnapshot => {
    const asks = [
      ...Array.from({ length: open }, (_, n) => ({ ...ask, id: `o${n}`, workIds: [`ow${n}`] })),
      ...Array.from({ length: settled }, (_, n) => ({
        ...ask,
        id: `s${n}`,
        status: 'achieved' as const,
        settledAt: 3,
        workIds: [`sw${n}`],
      })),
    ];
    const ids = asks.flatMap((item) => item.workIds);
    return {
      ok: true,
      sessionId: 'neo:root',
      concerns: [],
      work: ids.map(work),
      asks,
      cards: ids.map((id) => ({ ...card, workId: id, phase: 'reported' as const })),
      askViews: asks.map((item) => view(item.id)),
    };
  };

  test('leaves a snapshot under budget untouched', () => {
    const small = snapshot(1, 1);
    expect(fitNeoSnapshotBudget(small, 1_000_000)).toBe(small);
  });

  test('drops settled asks and their finished cards first, and says so', () => {
    const fitted = fitNeoSnapshotBudget(snapshot(2, 8), 60_000);
    expect(fitted.asks?.map((item) => item.id)).toEqual(['o0', 'o1']);
    expect(fitted.work.map((item) => item.id)).toEqual(['ow0', 'ow1']);
    expect(fitted.cards.map((item) => item.workId)).toEqual(['ow0', 'ow1']);
    expect(fitted.askViews.map((item) => item.askId)).toEqual(['o0', 'o1']);
    expect(fitted.trimmed).toContain('neo.snapshot {askId}');
  });

  test('cuts long text, then keeps only the newest open asks until it fits', () => {
    const fitted = fitNeoSnapshotBudget(snapshot(20, 0), 40_000);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(40_000);
    expect(fitted.asks?.[0].id).toBe('o0');
    expect(fitted.work.every((item) => item.instruction.length <= 300)).toBe(true);
  });

  test('stays within budget in bytes even with one ask of long checklist evidence', () => {
    const heavy = snapshot(1, 0);
    heavy.asks = heavy.asks?.map((item) => ({
      ...item,
      doneItems: Array.from({ length: 12 }, (_, n) => ({
        ...item.doneItems![0],
        id: `i${n}`,
        evidence: '证'.repeat(4000),
      })),
    }));
    heavy.concerns = Array.from({ length: 40 }, (_, n) => ({
      id: `c${n}`,
      title: `Concern ${n}`,
      summary: '摘'.repeat(1000),
      context: '',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }));
    const fitted = fitNeoSnapshotBudget(heavy, 40_000);
    expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(40_000);
    expect(fitted.asks?.[0].doneItems).toHaveLength(12);
  });
});
