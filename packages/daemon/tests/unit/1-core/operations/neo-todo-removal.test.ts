import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import {
  NEO_REMOVED_PREREQUISITE,
  planNeoCancelledEdges,
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
    const plan = planNeoTodoRemoval(family[0], family, [], { dependents: 'continue' }, 9);
    expect(brief(plan)).toEqual({
      b: { dependsOn: [] },
      c: { dependsOn: ['x'] },
      running: { dependsOn: [] },
    });
    expect(plan.card).toBeNull();
  });

  test('remove takes the unstarted dependents and the unstarted steps behind them', () => {
    const plan = planNeoTodoRemoval(family[0], family, [], { dependents: 'remove' }, 9);
    const gone = { state: 'removed', reason: 'Removed with its prerequisite "a".', finishedAt: 9 };
    expect(brief(plan)).toEqual({ running: { dependsOn: [] }, b: gone, c: gone, d: gone });
    expect(plan.card).toBeNull();
  });

  test('with no answer, one card covers the unstarted direct dependents and their edge stays', () => {
    const plan = planNeoTodoRemoval(family[0], family, [], {}, 9);
    expect(brief(plan)).toEqual({ running: { dependsOn: [] } });
    expect(plan.card).toEqual({
      askId: 'ask',
      todos: ['b', 'c'],
      text: '"a" was removed. Continue "b", "c" without it, or remove these steps too?',
    });
  });

  test('a live replacement takes over the edge, started or not, and no card opens', () => {
    const replaced = [...family, step('next', [])];
    const plan = planNeoTodoRemoval(replaced[0], replaced, [], { replacedBy: 'next' }, 9);
    expect(brief(plan)).toEqual({
      b: { dependsOn: ['next'] },
      c: { dependsOn: ['next', 'x'] },
      running: { dependsOn: ['next'] },
    });
    expect(plan.card).toBeNull();
  });

  test('a dependent that an open card already asks about is not asked again', () => {
    const asked = { state: 'open' as const, kind: 'choice' as const, todos: ['c'] };
    const plan = planNeoTodoRemoval(
      family[0],
      family,
      [startCard(['b']), { ...asked, cause: NEO_REMOVED_PREREQUISITE }],
      {},
      9
    );
    expect(plan.card).toBeNull();
    expect(planNeoTodoRemoval(family[0], family, [asked], {}, 9).card?.todos).toEqual(['b', 'c']);
  });

  test('a todo nothing waits for is removed with no writes and no card', () => {
    expect(planNeoTodoRemoval(family[3], family, [], {}, 9)).toEqual({ writes: [], card: null });
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
  const card = { cause: NEO_REMOVED_PREREQUISITE, todos: ['b'] };

  test('Continue drops the removed edge of the todos the card covers, and only theirs', () => {
    expect(
      brief({ writes: planNeoRemovedPrerequisiteAnswer(card, family, ['Continue'], 9) })
    ).toEqual({ b: { dependsOn: ['x'] } });
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

  test('Continue puts an unstarted todo its check had blocked back in the queue', () => {
    const blocked = [
      step('a', [], { state: 'removed' }),
      step('b', ['a'], { state: 'blocked', blockedBy: 'check' }),
    ];
    expect(
      brief({ writes: planNeoRemovedPrerequisiteAnswer(card, blocked, ['Continue'], 9) })
    ).toEqual({ b: { state: 'todo', dependsOn: [] } });
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

describe('planNeoCancelledEdges', () => {
  test('an unstarted todo behind a cancelled prerequisite gets one card per ask and keeps the edge', () => {
    const family = [
      step('gone', [], { state: 'removed' }),
      step('never', [], { state: 'closed_unverified' }),
      step('b', ['gone']),
      step('c', ['never', 'x']),
      step('x', []),
    ];
    expect(planNeoCancelledEdges(family, [])).toEqual({
      writes: [],
      cards: [
        {
          askId: 'ask',
          todos: ['b', 'c'],
          text: '"gone", "never" were removed. Continue "b", "c" without them, or remove these steps too?',
        },
      ],
    });
  });

  test('a started todo loses the edge and gets no card', () => {
    const family = [
      step('gone', [], { state: 'removed' }),
      step('running', ['gone', 'x'], { state: 'doing', startedAt: 5 }),
      step('x', []),
    ];
    const plan = planNeoCancelledEdges(family, []);
    expect(brief(plan)).toEqual({ running: { dependsOn: ['x'] } });
    expect(plan.cards).toEqual([]);
  });

  test('an edge moves to the live replacement, and a todo on an open Start card is left to it', () => {
    const family = [
      step('gone', [], { state: 'removed', replacedBy: 'next' }),
      step('lost', [], { state: 'removed' }),
      step('next', []),
      step('b', ['gone']),
      step('c', ['lost']),
    ];
    const plan = planNeoCancelledEdges(family, [startCard(['c'])]);
    expect(brief(plan)).toEqual({ b: { dependsOn: ['next'] } });
    expect(plan.cards).toEqual([]);
  });
});
