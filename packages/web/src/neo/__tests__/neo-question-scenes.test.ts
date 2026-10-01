import type { PendingUserQuestion } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { describe, expect, it } from 'vitest';
import { projectNeoConcernBoard } from '../neo-concern-board.ts';
import {
  classifyNeoScene,
  groupNeoScenes,
  classifyNeoScenes,
  projectNeoScenes,
  promoteNeoQuestionScene,
  promoteNeoQuestionScenes,
  selectNeoScene,
} from '../neo-scenes.ts';

const work = (id = 'work-A', status: NeoWork['status'] = 'queued'): NeoWork => ({
  id,
  requestKey: id,
  concernId: 'fictional',
  originSessionId: 'neo',
  originMessageId: 'ask',
  sessionId: 'worker-A',
  title: id,
  instruction: 'Bounded work',
  status,
  report: null,
  createdAt: 1,
  updatedAt: 2,
});
const question = (): PendingUserQuestion => ({
  toolUseId: 'question-A',
  askedAt: 3,
  inputOrigin: { sessionId: 'worker-A', messageId: 'work-A' },
  questions: [
    {
      question: 'Which fictional plan?',
      header: 'Plan',
      multiSelect: false,
      options: [{ label: 'Plan A', description: 'Fictional' }],
    },
  ],
});
const scene = (value: NeoWork = work()) => classifyNeoScene({ ...value, kind: 'work' });
const board = (works: NeoWork[]) =>
  projectNeoConcernBoard(
    {
      ok: true,
      sessionId: 'neo',
      concerns: [
        {
          id: 'fictional',
          title: 'Plans',
          summary: '',
          context: '',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      work: works,
      consultations: [],
    },
    null,
    null
  )!;

describe('promoteNeoQuestionScene', () => {
  it.each([
    ['attributed question', question(), work(), true],
    ['no question', undefined, work(), false],
    ['no origin', { ...question(), inputOrigin: undefined }, work(), false],
    [
      'wrong session',
      { ...question(), inputOrigin: { sessionId: 'worker-B', messageId: 'work-A' } },
      work(),
      false,
    ],
    [
      'wrong message',
      { ...question(), inputOrigin: { sessionId: 'worker-A', messageId: 'work-B' } },
      work(),
      false,
    ],
    ['empty tool', { ...question(), toolUseId: ' ' }, work(), false],
    ['empty session', question(), { ...work(), sessionId: ' ' }, false],
    [
      'empty work',
      { ...question(), inputOrigin: { sessionId: 'worker-A', messageId: ' ' } },
      { ...work(), id: ' ' },
      false,
    ],
    ['different target', question(), { ...work(), targetSessionId: 'worker-B' }, false],
    ['matching target', question(), { ...work(), targetSessionId: 'worker-A' }, true],
  ] as const)('classifies %s', (_name, pending, receipt, promoted) => {
    const original = scene(receipt);
    const before = structuredClone([original, pending]);
    const result = promoteNeoQuestionScene(original, pending);
    expect(result.group).toBe(promoted ? 'attention' : original.group);
    expect(result.label).toBe(promoted ? 'A quick choice' : original.label);
    expect(result.receipt).toBe(original.receipt);
    expect(result.ref).toBe(original.ref);
    expect(result.completionVerified).toBe(false);
    expect([original, pending]).toEqual(before);
    expect(result).not.toBeInstanceOf(Promise);
    if (!promoted) expect(result).toBe(original);
  });
  it.each(['proposed', 'reported', 'failed', 'cancelled'] as const)(
    'does not promote a stale question for %s work',
    (status) => {
      const original = scene(work('work-A', status));
      expect(promoteNeoQuestionScene(original, question())).toBe(original);
    }
  );
  it('does not promote a consultation even with colliding work/question ids', () => {
    const original = classifyNeoScene({
      kind: 'consultation',
      id: 'work-A',
      requestKey: 'check',
      concernId: 'fictional',
      originSessionId: 'neo',
      originMessageId: 'ask',
      sessionId: 'worker-A',
      question: 'Check',
      status: 'pending',
      answer: null,
      createdAt: 1,
    });
    expect(promoteNeoQuestionScene(original, question())).toBe(original);
  });
});

describe('projectNeoScenes with native question observations', () => {
  it('keeps default projection identical to the existing classification pipeline', () => {
    const input = board(
      ['proposed', 'queued', 'reported', 'failed', 'cancelled'].map((status) =>
        work(status, status as NeoWork['status'])
      )
    );
    expect(projectNeoScenes(input)).toEqual(groupNeoScenes(classifyNeoScenes(input.receipts)));
    expect(projectNeoScenes(input, new Map())).toEqual(projectNeoScenes(input));
    expect(projectNeoScenes(null, new Map([['work-A', question()]]))).toBeNull();
  });
  it('promotes only attributed work, retaining scene identity, order and total counts', () => {
    const input = board([
      work('first', 'proposed'),
      work(),
      work('work-B'),
      work('last', 'reported'),
    ]);
    const questions = new Map([
      ['work-A', question()],
      ['missing', question()],
    ]);
    const before = structuredClone([input, questions]);
    const groups = projectNeoScenes(input, questions)!;
    expect(groups.attention.map((item) => item.ref.id)).toEqual(['first', 'work-A']);
    expect(groups.running.map((item) => item.ref.id)).toEqual(['work-B']);
    expect(groups.outcomes.map((item) => item.ref.id)).toEqual(['last']);
    expect(groups.counts).toEqual({ attention: 2, running: 1, outcomes: 1, total: 4 });
    const selected = selectNeoScene(groups, { kind: 'work', id: 'work-A' });
    expect(selected).toMatchObject({
      value: { label: 'A quick choice', completionVerified: false },
    });
    expect([input, questions]).toEqual(before);
    const original = classifyNeoScenes(input.receipts);
    const promoted = promoteNeoQuestionScenes(original, questions);
    expect(promoted[0]).toBe(original[0]);
    expect(promoted[1].receipt).toBe(original[1].receipt);
  });
  it('reverts to the recorded work status when the observed question disappears', () => {
    const input = board([work()]);
    expect(projectNeoScenes(input, new Map([['work-A', question()]]))?.counts.attention).toBe(1);
    expect(projectNeoScenes(input, new Map())?.counts).toEqual({
      attention: 0,
      running: 1,
      outcomes: 0,
      total: 1,
    });
    expect(
      projectNeoScenes(board([work('work-A', 'reported')]), new Map([['work-A', question()]]))
        ?.counts
    ).toEqual({ attention: 0, running: 0, outcomes: 1, total: 1 });
  });
});
