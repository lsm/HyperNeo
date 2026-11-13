import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import {
  NEO_REMOVED_PREREQUISITE,
  planNeoRemovedPrerequisiteAnswer,
  planNeoTodoRemoval,
} from '../../../../src/lib/neo/todo-removal.ts';

type Row = Pick<
  NeoTodo,
  'id' | 'askId' | 'position' | 'title' | 'state' | 'startedAt' | 'dependsOn' | 'replacedBy'
> &
  Partial<Pick<NeoTodo, 'blockedBy'>>;

const step = (id: string, dependsOn: string[], patch: Partial<Row> = {}): Row => ({
  id,
  askId: 'ask',
  position: 0,
  title: id,
  state: 'todo',
  startedAt: null,
  dependsOn,
  replacedBy: null,
  ...patch,
});

const brief = (plan: { writes: { todo: Row; patch: object }[] }) =>
  Object.fromEntries(plan.writes.map(({ todo, patch }) => [todo.id, patch]));

const startCard = (todos: string[]) => ({ state: 'open' as const, kind: 'start' as const, todos });

describe('planNeoTodoRemoval', () => {
  const family = [
    step('a', []),
    step('b', ['a']),
    step('c', ['a', 'x']),
    step('d', ['b']),
    step('x', []),
    step('running', ['a'], { state: 'doing', startedAt: 5 }),
    step('finished', ['a'], { state: 'done', startedAt: 5 }),
  ];

  test('continue drops the edge of every dependent and opens no card', () => {
    const plan = planNeoTodoRemoval(
      family[0],
      family,
      [],
      { root: 'ask', dependents: 'continue' },
      9
    );
    expect(brief(plan)).toEqual({
      b: { dependsOn: [] },
      c: { dependsOn: ['x'] },
      running: { dependsOn: [] },
    });
    expect(plan.card).toBeNull();
  });

  test('remove takes the unstarted dependents and the unstarted steps behind them', () => {
    const plan = planNeoTodoRemoval(
      family[0],
      family,
      [],
      { root: 'ask', dependents: 'remove' },
      9
    );
    const gone = { state: 'removed', reason: 'Removed with its prerequisite "a".', finishedAt: 9 };
    expect(brief(plan)).toEqual({ running: { dependsOn: [] }, b: gone, c: gone, d: gone });
    expect(plan.card).toBeNull();
  });

  test('remove leaves a started dependent waiting for nothing that was removed', () => {
    const line = [
      step('a', []),
      step('b', ['a']),
      step('s', ['a', 'b', 'x'], { state: 'doing', startedAt: 5 }),
      step('x', []),
    ];
    const plan = planNeoTodoRemoval(line[0], line, [], { root: 'ask', dependents: 'remove' }, 9);
    expect(plan.writes.map(({ todo }) => todo.id).sort()).toEqual(['b', 's']);
    expect(brief(plan).s).toEqual({ dependsOn: ['x'] });
  });

  test('with no answer, one card on the root ask covers the unstarted direct dependents and their edge stays', () => {
    const sibling = [...family, step('far', ['a'], { askId: 'sibling' })];
    const plan = planNeoTodoRemoval(sibling[0], family, [], { root: 'home' }, 9);
    expect(brief(plan)).toEqual({ running: { dependsOn: [] } });
    expect(planNeoTodoRemoval(sibling[0], sibling, [], { root: 'home' }, 9).card?.todos).toEqual([
      'b',
      'c',
      'far',
      'a',
    ]);
    expect(plan.card).toEqual({
      askId: 'home',
      replaces: [],
      todos: ['b', 'c', 'a'],
      text: '"a" was removed. Continue "b", "c" without it, or remove these steps too?',
    });
  });

  test('a live replacement takes over the edge, started or not, and no card opens', () => {
    const replaced = [...family, step('next', [])];
    const plan = planNeoTodoRemoval(
      replaced[0],
      replaced,
      [],
      { root: 'ask', replacedBy: 'next' },
      9
    );
    expect(brief(plan)).toEqual({
      b: { dependsOn: ['next'] },
      c: { dependsOn: ['next', 'x'] },
      running: { dependsOn: ['next'] },
    });
    expect(plan.card).toBeNull();
  });

  test('a dependent on a Start card is left to it; one on an earlier removal card gets one wider card', () => {
    expect(
      planNeoTodoRemoval(family[0], family, [startCard(['b', 'c'])], { root: 'ask' }, 9).card
    ).toBeNull();
    const twice = [step('a', [], { state: 'removed' }), step('b', []), step('c', ['a', 'b'])];
    const earlier = {
      state: 'open' as const,
      kind: 'choice' as const,
      cause: NEO_REMOVED_PREREQUISITE,
      todos: ['c', 'a'],
    };
    expect(planNeoTodoRemoval(twice[1], twice, [earlier], { root: 'ask' }, 9).card).toEqual({
      askId: 'ask',
      replaces: [earlier],
      todos: ['c', 'a', 'b'],
      text: '"a", "b" were removed. Continue "c" without them, or remove this step too?',
    });
  });

  test('a todo nothing waits for is removed with no writes and no card', () => {
    expect(planNeoTodoRemoval(family[3], family, [], { root: 'ask' }, 9)).toEqual({
      writes: [],
      card: null,
    });
  });
});

describe('planNeoRemovedPrerequisiteAnswer', () => {
  const family = [
    step('a', [], { state: 'removed' }),
    step('b', ['a', 'x']),
    step('c', ['b']),
    step('x', []),
    step('other', ['a']),
  ];
  const card = { cause: NEO_REMOVED_PREREQUISITE, todos: ['b', 'a'] };

  test('Continue drops the removed edge of the todos the card covers, and only theirs', () => {
    expect(
      brief({ writes: planNeoRemovedPrerequisiteAnswer(card, family, ['Continue'], 9) })
    ).toEqual({ b: { dependsOn: ['x'] } });
  });

  test('Continue keeps an edge to a prerequisite removed after the card was asked', () => {
    const later = [
      step('a', [], { state: 'removed' }),
      step('b', [], { state: 'removed' }),
      step('c', ['a', 'b']),
    ];
    const aboutA = { cause: NEO_REMOVED_PREREQUISITE, todos: ['c', 'a'] };
    expect(
      brief({ writes: planNeoRemovedPrerequisiteAnswer(aboutA, later, ['Continue'], 9) })
    ).toEqual({ c: { dependsOn: ['b'] } });
  });

  test('Remove these removes them and the unstarted steps behind them', () => {
    const gone = {
      state: 'removed',
      reason: 'The human removed it after its prerequisite was removed.',
      finishedAt: 9,
    };
    expect(
      brief({ writes: planNeoRemovedPrerequisiteAnswer(card, family, ['Remove these'], 9) })
    ).toEqual({ b: gone, c: gone });
  });

  test('Continue drops the edge and leaves a check hold in place', () => {
    const blocked = [
      step('a', [], { state: 'removed' }),
      step('b', ['a'], { state: 'blocked', blockedBy: 'check' }),
    ];
    expect(
      brief({ writes: planNeoRemovedPrerequisiteAnswer(card, blocked, ['Continue'], 9) })
    ).toEqual({ b: { dependsOn: [] } });
    expect(
      brief(
        planNeoTodoRemoval(
          step('a', []),
          [step('a', []), blocked[1]],
          [],
          { root: 'ask', dependents: 'continue' },
          9
        )
      )
    ).toEqual({ b: { dependsOn: [] } });
  });

  test('Remove these still removes a todo whose edge was dropped while the card was open', () => {
    const dropped = [step('a', [], { state: 'removed' }), step('b', [])];
    expect(
      Object.keys(
        brief({ writes: planNeoRemovedPrerequisiteAnswer(card, dropped, ['Remove these'], 9) })
      )
    ).toEqual(['b']);
  });

  test('a free reply, or a card about something else, changes nothing', () => {
    expect(planNeoRemovedPrerequisiteAnswer(card, family, 'Do the other thing first', 9)).toEqual(
      []
    );
    expect(planNeoRemovedPrerequisiteAnswer({ todos: ['b'] }, family, ['Continue'], 9)).toEqual([]);
  });
});
