import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoCardView } from '@hyperneo/shared/types/neo-snapshot';
import {
  compactNeoSnapshotAsks,
  compactNeoSnapshotCards,
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
