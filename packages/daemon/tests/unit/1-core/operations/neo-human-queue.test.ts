import { describe, expect, test } from 'bun:test';
import type { NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { neoHumanQueue } from '../../../../src/lib/neo/human-queue.ts';
import { type NeoStepOwner, nextStepOwner } from '../../../../src/lib/neo/attention/owner.ts';

const todo = (id: string, state: NeoTodo['state'] = 'todo', askId = 'ask-a') => ({
  id,
  askId,
  title: `Todo ${id}`,
  state,
  named: null,
});
const card = (
  id: string,
  todos: string[],
  extra: Partial<Pick<NeoQuestion, 'state' | 'heldAt' | 'askId'>> = {}
) => ({ id, askId: 'ask-a', text: `Card ${id}?`, todos, state: 'open' as const, ...extra });
const none = new Map<string, NeoStepOwner>();

describe('neoHumanQueue', () => {
  test('running work with no card is in progress, saying whose step it is', () => {
    const queue = neoHumanQueue({
      questions: [],
      todos: [todo('t1', 'doing')],
      owners: new Map([['t1', { owner: 'worker' }]]),
    });
    expect(queue.items).toEqual([
      { state: 'progress', askId: 'ask-a', todoId: 't1', title: 'Todo t1', owner: 'worker' },
    ]);
  });

  test('a finished todo is not listed, with or without an answered card', () => {
    const queue = neoHumanQueue({
      questions: [card('q1', ['t1'], { state: 'answered' })],
      todos: [todo('t1', 'done'), todo('t2', 'removed')],
      owners: none,
    });
    expect(queue).toEqual({ items: [], counts: {} });
  });

  test('a card covering two todos is one item, and those todos are listed only under it', () => {
    const queue = neoHumanQueue({
      questions: [card('q1', ['t1', 't2'])],
      todos: [todo('t1', 'blocked'), todo('t2')],
      owners: none,
    });
    expect(queue.items).toEqual([
      {
        state: 'waiting',
        askId: 'ask-a',
        questionId: 'q1',
        text: 'Card q1?',
        todos: [
          { id: 't1', title: 'Todo t1' },
          { id: 't2', title: 'Todo t2' },
        ],
      },
    ]);
  });

  test('two open cards on one todo are two items, the todo under both', () => {
    const queue = neoHumanQueue({
      questions: [card('q1', ['t1']), card('q2', ['t1'])],
      todos: [todo('t1', 'blocked')],
      owners: none,
    });
    expect(queue.items).toMatchObject([
      { state: 'waiting', questionId: 'q1', todos: [{ id: 't1' }] },
      { state: 'waiting', questionId: 'q2', todos: [{ id: 't1' }] },
    ]);
    expect(queue.items).toHaveLength(2);
  });

  test('an ask-level card is one item about the whole ask', () => {
    const queue = neoHumanQueue({ questions: [card('q1', [])], todos: [], owners: none });
    expect(queue.items).toEqual([
      { state: 'waiting', askId: 'ask-a', questionId: 'q1', text: 'Card q1?', todos: [] },
    ]);
  });

  test('an uncovered blocked todo is in progress with the owner nextStepOwner gives', () => {
    const blocked = { ...todo('t1', 'blocked'), blockedBy: 'question' as const };
    const owner = nextStepOwner({
      todo: { ...blocked, createdAt: 1, approvedAt: 1, startedAt: 2, finishedAt: null },
      covered: false,
      held: false,
      prerequisites: [],
      answerPending: false,
      cardClosedAt: 3,
      failedAt: null,
      worker: null,
      packWaiting: false,
      start: null,
    });
    const queue = neoHumanQueue({
      questions: [card('q1', ['t1'], { state: 'answered' })],
      todos: [blocked],
      owners: new Map([['t1', owner]]),
    });
    expect(queue.items).toEqual([
      { state: 'progress', askId: 'ask-a', todoId: 't1', title: 'Todo t1', owner: 'neo' },
    ]);
  });

  test('a held card is listed as held and still covers its todo', () => {
    const queue = neoHumanQueue({
      questions: [card('q1', ['t1'], { heldAt: 5 })],
      todos: [todo('t1', 'blocked')],
      owners: none,
    });
    expect(queue.items).toMatchObject([{ state: 'held', questionId: 'q1' }]);
    expect(queue.items).toHaveLength(1);
  });

  test('an open worker request todo is not in the human queue', () => {
    const request = { ...todo('t1', 'doing'), named: { requestFrom: 'session-w' } };
    const queue = neoHumanQueue({
      questions: [],
      todos: [request],
      owners: new Map([['t1', { owner: 'neo' }]]),
    });
    expect(queue).toEqual({ items: [], counts: {} });
  });

  test('counts are a state by ask table', () => {
    const queue = neoHumanQueue({
      questions: [
        card('q1', ['t1']),
        card('q2', [], { heldAt: 5 }),
        card('q3', ['t3'], { askId: 'ask-b' }),
      ],
      todos: [todo('t1', 'blocked'), todo('t2', 'doing'), todo('t3', 'blocked', 'ask-b')],
      owners: none,
    });
    expect(queue.counts).toEqual({
      'ask-a': { waiting: 1, held: 1, progress: 1 },
      'ask-b': { waiting: 1, held: 0, progress: 0 },
    });
  });
});
