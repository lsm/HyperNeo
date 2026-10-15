import { describe, expect, test } from 'bun:test';
import type {
  NeoAsk,
  NeoAskView,
  NeoCardView,
  NeoSnapshot,
} from '@hyperneo/shared/types/neo-snapshot';
import {
  compactNeoSnapshotAsks,
  compactNeoSnapshotCards,
  fitNeoSnapshotBudget,
  summarizeNeoSnapshot,
} from '../../../../src/lib/neo/snapshot-compact.ts';

const ask: NeoAsk = {
  id: 'a1',
  requestKey: 'k1',
  projectId: null,
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
    projectId: null,
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
      projects: [],
      consultations: [],
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
    expect(fitted.trimmed).toContain(
      `${20 - (fitted.asks?.length ?? 0)} older open asks are also left out`
    );
    expect(fitted.work.every((item) => item.instruction.length <= 300)).toBe(true);
  });

  test('falls back to identities when one ask alone is too big, and says so', () => {
    const huge = snapshot(1, 0);
    huge.asks = huge.asks?.map((item) => ({
      ...item,
      doneItems: Array.from({ length: 400 }, (_, n) => ({
        ...item.doneItems![0],
        id: `i${n}`,
        text: 't'.repeat(200),
        options: Array.from({ length: 10 }, () => 'o'.repeat(100)),
      })),
    }));
    const fitted = fitNeoSnapshotBudget(huge, 40_000);
    expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(40_000);
    expect(fitted.trimmed).toContain('only ask and card identities');
  });

  test('the trimmed note never pushes the result past the budget', () => {
    const big = snapshot(30, 30);
    for (let budget = 2_000; budget <= 40_000; budget += 397) {
      const fitted = fitNeoSnapshotBudget(big, budget);
      expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(budget);
    }
  });

  test('the last-resort fallbacks still carry the required consultations list', () => {
    expect(fitNeoSnapshotBudget(snapshot(5, 5), 10).consultations).toEqual([]);
    expect(fitNeoSnapshotBudget(snapshot(5, 5), 10, { focused: true }).consultations).toEqual([]);
  });

  test('a single-ask read keeps that ask even when it is settled', () => {
    const focused = snapshot(0, 1);
    focused.work = focused.work.map((item) => ({ ...item, report: 'r'.repeat(60_000) }));
    const fitted = fitNeoSnapshotBudget(focused, 40_000, { focused: true });
    expect(fitted.asks?.map((item) => item.id)).toEqual(['s0']);
    expect(fitted.trimmed).toContain('returns the same');
    expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(40_000);
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
    heavy.projects = Array.from({ length: 40 }, (_, n) => ({
      id: `c${n}`,
      title: `Project ${n}`,
      summary: '摘'.repeat(1000),
      context: '',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }));
    heavy.cards = Array.from({ length: 10 }, (_, n) => ({
      ...card,
      workId: `ow${n}`,
      goal: 'g'.repeat(1000),
      doneWhen: 'd'.repeat(2000),
      continuedMessage: 'c'.repeat(1000),
    }));
    heavy.projects = heavy.projects.map((concern) => ({ ...concern, context: '境'.repeat(4000) }));
    const fitted = fitNeoSnapshotBudget(heavy, 40_000);
    expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(40_000);
    expect(fitted.asks?.[0].doneItems).toHaveLength(12);
  });
});

describe('summarizeNeoSnapshot', () => {
  const item = (id: string, status: 'queued' | 'reported') => ({
    id,
    requestKey: id,
    projectId: null,
    originSessionId: 'root',
    originMessageId: null,
    title: id,
    instruction: 'i'.repeat(1000),
    sessionId: null,
    status,
    report: status === 'reported' ? 'r'.repeat(3000) : null,
    createdAt: 1,
    updatedAt: 1,
  });
  const view = (askId: string): NeoAskView => ({
    askId,
    group: 'outcomes',
    label: 'Done',
    settled: true,
    needsYou: false,
    done: 1,
    total: 1,
    workIds: [],
    doneWorkIds: [],
    summary: null,
  });
  const live = { ...ask, id: 'live', workIds: ['lw'] };
  const settled = {
    ...ask,
    id: 'done',
    status: 'achieved' as const,
    outcome: 'o'.repeat(1000),
    settledAt: 3,
    workIds: ['dw', 'dq'],
  };
  const older = { ...settled, id: 'older', workIds: ['ow'] };
  const snapshot = (views: NeoAskView[]): NeoSnapshot => ({
    ok: true,
    sessionId: 'neo:root',
    projects: [],
    consultations: [],
    work: [
      item('lw', 'reported'),
      item('dw', 'reported'),
      item('dq', 'queued'),
      item('ow', 'reported'),
    ],
    asks: [live, settled],
    cards: ['lw', 'dw', 'dq', 'ow'].map((workId) => ({
      ...card,
      workId,
      phase: workId === 'ow' ? ('pr_setback' as const) : ('reported' as const),
    })),
    askViews: views,
  });

  test('marks a settled ask and its finished work as summaries, keeps the views and an actionable card goal', () => {
    const views = [view('live'), view('done')];
    const result = summarizeNeoSnapshot(snapshot(views), [live, settled, older]);
    expect(result.askViews).toBe(views);
    expect(result.asks?.[0]).toBe(live);
    expect(result.asks?.[1]).toMatchObject({
      summarized: true,
      ask: '',
      doneWhen: '',
      doneItems: [],
      evidence: null,
      workIds: ['dw', 'dq'],
    });
    expect(result.asks?.[1].outcome).toHaveLength(300);
    const [liveWork, doneWork, queuedWork, olderWork] = result.work;
    expect(liveWork.summarized).toBeUndefined();
    expect(liveWork.report).toHaveLength(3000);
    expect(doneWork).toMatchObject({ summarized: true, askId: 'done', instruction: '' });
    expect(doneWork.report).toHaveLength(300);
    expect(queuedWork.summarized).toBeUndefined();
    expect(olderWork).toMatchObject({ summarized: true, askId: 'older' });
    expect(result.cards.map((item) => item.goal)).toEqual([card.goal, null, card.goal, card.goal]);
  });

  test('summarizes finished work outside any ask without an askId and keeps its card', () => {
    const input: NeoSnapshot = {
      ...snapshot([]),
      work: [item('loose', 'reported'), item('waiting', 'queued')],
      cards: [{ ...card, workId: 'loose', phase: 'reported' }],
    };
    const result = summarizeNeoSnapshot(input, []);
    const [loose, waiting] = result.work;
    expect(loose).toMatchObject({ summarized: true, instruction: '' });
    expect(loose.report).toHaveLength(300);
    expect('askId' in loose).toBe(false);
    expect(waiting.summarized).toBeUndefined();
    expect(result.cards[0].goal).toBe(card.goal);
  });

  test('summarizes settled consultations and leaves a pending one whole', () => {
    const consultation = {
      id: 'c1',
      requestKey: 'c1',
      projectId: 'p',
      originSessionId: 'root',
      originMessageId: null,
      sessionId: 'holder',
      question: 'q'.repeat(1000),
      status: 'reported' as const,
      answer: 'a'.repeat(1000),
      createdAt: 1,
    };
    const pending = { ...consultation, id: 'c2', status: 'pending' as const, answer: null };
    const result = summarizeNeoSnapshot(
      { ...snapshot([]), consultations: [consultation, pending] },
      []
    );
    expect(result.consultations[0]).toMatchObject({ id: 'c1', summarized: true });
    expect(result.consultations[0].question).toHaveLength(300);
    expect(result.consultations[0].answer).toHaveLength(300);
    expect(result.consultations[1]).toBe(pending);
  });

  test('never cuts a summary inside a surrogate pair', () => {
    const report = `${'字'.repeat(299)}😀tail`;
    const [cut] = summarizeNeoSnapshot(
      { ...snapshot([]), work: [{ ...item('emoji', 'reported'), report }], cards: [] },
      []
    ).work;
    expect(cut.report).toBe('字'.repeat(299));
  });
});
