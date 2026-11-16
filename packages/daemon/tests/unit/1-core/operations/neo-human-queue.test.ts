import { describe, expect, test } from 'bun:test';
import type { NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { neoHumanQueue } from '../../../../src/lib/neo/human-queue.ts';
import { type NeoStepOwner, nextStepOwner } from '../../../../src/lib/neo/attention/owner.ts';

const todo = (id: string, state: NeoTodo['state'] = 'todo', askId = 'ask-a') => ({
  id,
  askId,
  title: `Todo ${id}`,
  state,
});
const card = (
  id: string,
  todos: string[],
  extra: Partial<Pick<NeoQuestion, 'state' | 'heldAt' | 'askId'>> = {}
) => ({ id, askId: 'ask-a', text: `Card ${id}?`, todos, state: 'open' as const, ...extra });
const asks = [{ id: 'ask-a' }, { id: 'ask-b' }];
const none = new Map<string, NeoStepOwner>();

describe('neoHumanQueue', () => {
  test('running work with no card is in progress, saying whose step it is', () => {
    const queue = neoHumanQueue({
      asks,
      questions: [],
      todos: [todo('t1', 'doing')],
      owners: new Map([['t1', { owner: 'worker' }]]),
      state: 'progress',
    });
    expect(queue.items).toEqual([
      { state: 'progress', askId: 'ask-a', todoId: 't1', title: 'Todo t1', owner: 'worker' },
    ]);
  });

  test('a finished todo is not listed, with or without an answered card', () => {
    const queue = neoHumanQueue({
      asks,
      questions: [card('q1', ['t1'], { state: 'answered' })],
      todos: [todo('t1', 'done'), todo('t2', 'removed')],
      owners: none,
    });
    expect(queue.items).toEqual([]);
    expect(queue.counts).toEqual({});
  });

  test('a card covering two todos is one item, and those todos are listed only under it', () => {
    const input = {
      asks,
      questions: [card('q1', ['t1', 't2'])],
      todos: [todo('t1', 'blocked'), todo('t2')],
      owners: none,
    };
    expect(neoHumanQueue(input).items).toEqual([
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
    expect(neoHumanQueue({ ...input, state: 'progress' }).items).toEqual([]);
  });

  test('two open cards on one todo are two items, the todo under both', () => {
    const queue = neoHumanQueue({
      asks,
      questions: [card('q1', ['t1']), card('q2', ['t1'])],
      todos: [todo('t1', 'blocked')],
      owners: none,
    });
    expect(queue.items.map((item) => [item.state, 'questionId' in item && item.questionId])).toEqual(
      [
        ['waiting', 'q1'],
        ['waiting', 'q2'],
      ]
    );
    expect(queue.items.every((item) => 'todos' in item && item.todos[0]?.id === 't1')).toBe(true);
  });

  test('an ask-level card is one item about the whole ask', () => {
    const queue = neoHumanQueue({ asks, questions: [card('q1', [])], todos: [], owners: none });
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
      asks,
      questions: [card('q1', ['t1'], { state: 'answered' })],
      todos: [blocked],
      owners: new Map([['t1', owner]]),
      state: 'progress',
    });
    expect(queue.items).toEqual([
      { state: 'progress', askId: 'ask-a', todoId: 't1', title: 'Todo t1', owner: 'neo' },
    ]);
  });

  test('a held card is listed under held, not waiting on you, and still covers its todo', () => {
    const input = {
      asks,
      questions: [card('q1', ['t1'], { heldAt: 5 })],
      todos: [todo('t1', 'blocked')],
      owners: none,
    };
    expect(neoHumanQueue(input).items).toEqual([]);
    expect(neoHumanQueue({ ...input, state: 'held' }).items).toMatchObject([
      { state: 'held', questionId: 'q1' },
    ]);
    expect(neoHumanQueue({ ...input, state: 'progress' }).items).toEqual([]);
  });

  test('counts are a state by ask table, and the ask filter narrows only the items', () => {
    const input = {
      asks,
      questions: [
        card('q1', ['t1']),
        card('q2', [], { heldAt: 5 }),
        card('q3', ['t3'], { askId: 'ask-b' }),
      ],
      todos: [todo('t1', 'blocked'), todo('t2', 'doing'), todo('t3', 'blocked', 'ask-b')],
      owners: none,
    };
    const counts = {
      'ask-a': { waiting: 1, held: 1, progress: 1 },
      'ask-b': { waiting: 1, held: 0, progress: 0 },
    };
    expect(neoHumanQueue(input)).toMatchObject({ state: 'waiting', askId: null, counts });
    expect(neoHumanQueue(input).items.map((item) => item.askId)).toEqual(['ask-a', 'ask-b']);
    const narrowed = neoHumanQueue({ ...input, askId: 'ask-b' });
    expect(narrowed.items.map((item) => item.askId)).toEqual(['ask-b']);
    expect(narrowed.counts).toEqual(counts);
  });
});
