import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import {
  neoTodosAwaitingNeoDecision,
  planNeoQuestionPrune,
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
    kind: 'reply',
    state: 'open',
    text: 'Start?',
    todos: ['first', 'second'],
    ...change,
  }) as NeoQuestion;

describe('planNeoQuestionPrune', () => {
  test('retires a question whose todo is finished', () => {
    const question = card({
      kind: 'reply' as NeoQuestion['kind'],
      todoId: 'first',
      todos: ['first'],
    });
    expect(planNeoQuestionPrune(question, [step('first', { state: 'done' })])).toEqual({
      value: { retire: 'todo no longer active' },
    });
  });

  test('leaves a card that only holds one step open, whatever becomes of the step', () => {
    const question = card({ kind: 'reply' as NeoQuestion['kind'], todos: ['first'] });
    for (const change of [{}, { askId: 'child' }, { state: 'done' as const }])
      expect(planNeoQuestionPrune(question, [step('first', change)])).toEqual({
        reason: 'unchanged',
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
