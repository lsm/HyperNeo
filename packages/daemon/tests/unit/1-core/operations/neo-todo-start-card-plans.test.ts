import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import {
  neoTodosAwaitingNeoDecision,
  planNeoQuestionPrune,
  planNeoStartRelease,
} from '../../../../src/lib/neo/todo-start-gate.ts';

const step = (id: string, change: Partial<NeoTodo> = {}) =>
  ({
    id,
    askId: 'ask',
    title: id,
    state: 'blocked',
    blockedBy: 'question',
    startedAt: null,
    approvedAt: null,
    dependsOn: [],
    instruction: `Do ${id}`,
    replacedBy: null,
    ...change,
  }) as NeoTodo;

const card = (change: Partial<NeoQuestion> = {}) =>
  ({
    id: 'card',
    askId: 'ask',
    kind: 'start',
    state: 'open',
    text: 'Start?',
    todos: ['first', 'second'],
    ...change,
  }) as NeoQuestion;

describe('planNeoStartRelease', () => {
  test('a declined step counts as cancelled for the next step on the card', () => {
    const gone = step('gone', { state: 'removed', blockedBy: null });
    const first = step('first', { dependsOn: ['gone'] });
    const second = step('second', { dependsOn: ['first'] });
    const writes = planNeoStartRelease(card(), [gone, first, second], [], ['second'], undefined, 7);
    expect(writes.map(({ todo, patch }) => [todo.id, patch.state, patch.dependsOn])).toEqual([
      ['first', 'removed', undefined],
      ['second', 'todo', []],
    ]);
  });

  test('a step still listed on another open card is left alone', () => {
    const other = card({ id: 'other', todos: ['first'] });
    const writes = planNeoStartRelease(
      card(),
      [step('first'), step('second')],
      [other],
      ['first', 'second'],
      undefined,
      7
    );
    expect(writes.map(({ todo }) => todo.id)).toEqual(['second']);
  });
});

describe('planNeoQuestionPrune', () => {
  test('retires a question whose todo is finished', () => {
    const question = card({ kind: 'reply' as NeoQuestion['kind'], todos: ['first'] });
    expect(planNeoQuestionPrune(question, [step('first', { state: 'done' })])).toEqual({
      value: { retire: 'todo no longer active' },
    });
  });

  test('keeps a card on a parent ask that holds one live step of a child ask', () => {
    const question = card({ kind: 'reply' as NeoQuestion['kind'], todos: ['first'] });
    const child = step('first', { askId: 'child' });
    expect(planNeoQuestionPrune(question, [child])).toEqual({ reason: 'unchanged' });
    expect(planNeoQuestionPrune(question, [{ ...child, state: 'removed' }])).toEqual({
      value: { retire: 'todo no longer active' },
    });
  });

  test('retires a card with nothing left and frees its approved steps', () => {
    const first = step('first', { approvedAt: 1 });
    const plan = planNeoQuestionPrune(card({ todos: ['first'] }), [first]);
    expect(plan).toMatchObject({
      value: { kept: [], text: 'Start?', state: 'retired', released: [first] },
    });
  });

  test('leaves an unchanged card alone', () => {
    expect(planNeoQuestionPrune(card(), [step('first'), step('second')])).toEqual({
      reason: 'unchanged',
    });
  });
});

describe('neoTodosAwaitingNeoDecision', () => {
  const family = [
    step('gone', { state: 'removed', blockedBy: null }),
    step('first', { state: 'todo', blockedBy: null, dependsOn: ['gone'] }),
  ];

  test('finds a step in an open ask that no card lists', () => {
    const ask = { id: 'ask', status: 'open' } as NeoAsk;
    expect(neoTodosAwaitingNeoDecision(family, ask, []).map(({ id }) => id)).toEqual(['first']);
  });

  test('asks nothing once the ask is closed', () => {
    const ask = { id: 'ask', status: 'done' } as NeoAsk;
    expect(neoTodosAwaitingNeoDecision(family, ask, [])).toEqual([]);
  });
});
