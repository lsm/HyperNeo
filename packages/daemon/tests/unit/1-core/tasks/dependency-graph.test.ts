import { describe, expect, test } from 'bun:test';
import {
  buildTaskDependencyGraph,
  hasTaskDependencyCycle,
} from '../../../../src/lib/tasks/dependency-graph';

describe('task dependency graph', () => {
  test('projects only dependency data and substitutes the proposed update without mutating input', () => {
    const tasks = [{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: [] }, { id: 'c' }];
    const proposed = ['c'];
    const graph = buildTaskDependencyGraph(tasks, 'a', proposed);
    expect([...graph]).toEqual([
      ['a', ['c']],
      ['b', []],
      ['c', []],
    ]);
    graph.get('a')?.push('b');
    expect(proposed).toEqual(['c']);
    expect(tasks[0].dependsOn).toEqual(['b']);
  });

  test.each([
    { edges: [], cyclic: false },
    { edges: [['a', ['a']]], cyclic: true },
    {
      edges: [
        ['a', ['b']],
        ['b', ['a']],
      ],
      cyclic: true,
    },
    {
      edges: [
        ['a', ['b']],
        ['b', ['c']],
        ['c', ['a']],
      ],
      cyclic: true,
    },
    {
      edges: [
        ['a', ['b', 'c']],
        ['b', ['d']],
        ['c', ['d']],
        ['d', []],
      ],
      cyclic: false,
    },
    {
      edges: [
        ['a', []],
        ['b', ['c']],
        ['c', ['b']],
      ],
      cyclic: true,
    },
    { edges: [['a', ['missing']]], cyclic: false },
  ] as { edges: [string, string[]][]; cyclic: boolean }[])('detects cycles in %j', ({
    edges,
    cyclic,
  }) => {
    expect(hasTaskDependencyCycle(new Map(edges))).toBe(cyclic);
  });

  test('does not synthesize an absent update target', () => {
    expect([...buildTaskDependencyGraph([{ id: 'a' }], 'missing', ['a'])]).toEqual([['a', []]]);
  });
});
