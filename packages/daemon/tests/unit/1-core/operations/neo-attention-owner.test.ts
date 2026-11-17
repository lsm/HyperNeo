import { describe, expect, test } from 'bun:test';
import { type NeoStepFacts, nextStepOwner } from '../../../../src/lib/neo/attention/owner.ts';

const facts = (change: Partial<NeoStepFacts> = {}): NeoStepFacts => ({
  todo: {
    state: 'todo',
    blockedBy: null,
    createdAt: 10,
    approvedAt: 20,
    startedAt: null,
    finishedAt: null,
  },
  covered: false,
  held: false,
  prerequisites: [],
  answerPending: false,
  cardClosedAt: null,
  failedAt: null,
  worker: null,
  packWaiting: false,
  start: null,
  now: 0,
  ...change,
});
const doing = { ...facts().todo, state: 'doing' as const, startedAt: 30 };
const blocked = (blockedBy: NeoStepFacts['todo']['blockedBy']) => ({
  ...doing,
  state: 'blocked' as const,
  blockedBy,
});
const idle = { status: 'idle' as const, since: 50 };
const DAY = 24 * 3_600_000;
const checked = {
  ...facts().todo,
  instruction: null,
  check: { pack: 'coding', kind: 'pr_merged', params: {} },
};

describe('nextStepOwner', () => {
  test.each<[string, NeoStepFacts, ReturnType<typeof nextStepOwner>]>([
    [
      'an open card covers the todo',
      facts({ covered: true, todo: blocked('failure') }),
      { owner: 'human' },
    ],
    [
      'Neo put the todo on hold',
      facts({ held: true, todo: blocked('failure') }),
      { owner: 'nobody' },
    ],
    [
      'a failed todo with an idle worker',
      facts({ todo: blocked('failure'), worker: idle }),
      { owner: 'neo', reason: 'failed', since: 50 },
    ],
    [
      'a failure long after its worker went idle',
      facts({
        todo: blocked('failure'),
        failedAt: 72 * 3_600_000,
        worker: { status: 'idle', since: 0 },
      }),
      { owner: 'neo', reason: 'failed', since: 72 * 3_600_000 },
    ],
    [
      'a prerequisite that failed later',
      facts({
        prerequisites: [{ state: 'blocked', blockedBy: 'failure', finishedAt: null, failedAt: 90 }],
      }),
      { owner: 'neo', reason: 'prerequisite_gone', since: 90 },
    ],
    [
      'a removed prerequisite',
      facts({ prerequisites: [{ state: 'removed', finishedAt: 60 }], start: 'ready' }),
      { owner: 'neo', reason: 'prerequisite_gone', since: 60 },
    ],
    [
      'a failed prerequisite',
      facts({ prerequisites: [{ state: 'blocked', blockedBy: 'failure', finishedAt: null }] }),
      { owner: 'neo', reason: 'prerequisite_gone', since: 20 },
    ],
    [
      'an unfinished prerequisite',
      facts({ prerequisites: [{ state: 'doing', finishedAt: null }] }),
      { owner: 'prerequisite' },
    ],
    [
      'an answer still being delivered',
      facts({ todo: blocked('needs-human'), answerPending: true, worker: idle }),
      { owner: 'daemon' },
    ],
    [
      'blocked on a question with no open card, even with a start target',
      facts({ todo: blocked('question'), cardClosedAt: 70, start: 'ready', worker: idle }),
      { owner: 'neo', reason: 'unanswered', since: 70 },
    ],
    [
      'unknown live status',
      facts({ todo: doing, worker: { status: 'unknown', since: 50 } }),
      { owner: 'daemon' },
    ],
    [
      'a running worker',
      facts({ todo: doing, worker: { status: 'running', since: 50 } }),
      { owner: 'worker' },
    ],
    [
      'an idle worker with an open pull request',
      facts({ todo: doing, worker: idle, packWaiting: true }),
      { owner: 'pack' },
    ],
    ['a target with a queue hold', facts({ start: 'held' }), { owner: 'daemon' }],
    ['a target the queue would start now', facts({ start: 'ready' }), { owner: 'daemon' }],
    [
      'no start target after its prerequisite finished',
      facts({ prerequisites: [{ state: 'done', finishedAt: 80 }] }),
      { owner: 'neo', reason: 'no_worker', since: 80 },
    ],
    [
      'a check with no instruction before its deadline',
      facts({ todo: checked, now: 10 + DAY - 1 }),
      { owner: 'daemon' },
    ],
    [
      'a check with no instruction once its deadline passed',
      facts({ todo: checked, now: 10 + DAY }),
      { owner: 'neo', reason: 'check_overdue', since: 10 + DAY },
    ],
    [
      'a check whose prerequisite finished later counts its deadline from that finish',
      facts({
        todo: checked,
        prerequisites: [{ state: 'done', finishedAt: 80 }],
        now: 80 + DAY - 1,
      }),
      { owner: 'daemon' },
    ],
    [
      'a check with an instruction and no start target is still Neo’s to start',
      facts({ todo: { ...checked, instruction: 'Merge it.' }, now: 10 + DAY - 1 }),
      { owner: 'neo', reason: 'no_worker', since: 20 },
    ],
    [
      'an idle worker with nothing to wait on',
      facts({ todo: doing, worker: idle, start: 'ready' }),
      { owner: 'neo', reason: 'idle_worker', since: 50 },
    ],
  ])('%s', (_name, input, owner) => {
    expect(nextStepOwner(input)).toEqual(owner);
  });

  test('a second failure with the worker unchanged is a new incident', () => {
    const first = nextStepOwner(facts({ todo: blocked('failure'), failedAt: 100, worker: idle }));
    const second = nextStepOwner(facts({ todo: blocked('failure'), failedAt: 200, worker: idle }));
    expect([first, second]).toEqual([
      { owner: 'neo', reason: 'failed', since: 100 },
      { owner: 'neo', reason: 'failed', since: 200 },
    ]);
  });

  test('a later daemon write to the todo does not move since', () => {
    const before = nextStepOwner(facts({ todo: blocked('failure'), worker: idle }));
    const after = nextStepOwner(
      facts({ todo: { ...blocked('failure'), updatedAt: 9_999 } as never, worker: idle })
    );
    expect(after).toEqual(before);
  });
});
