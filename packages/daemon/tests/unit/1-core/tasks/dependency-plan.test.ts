import { describe, expect, test } from 'bun:test';
import {
  planTaskDependencies,
  requireDependencyTarget,
  requireDistinctDependencies,
  requireExistingDependencies,
  requireAcyclicDependencies,
} from '../../../../src/lib/tasks/dependency-plan';

const graph = [
  { id: 'a', dependsOn: ['b'] },
  { id: 'b', dependsOn: ['c'] },
  { id: 'c', dependsOn: [] },
];

describe('dependency gate decision tables', () => {
  test.each([
    ['a', true],
    ['absent', false],
  ])('requires target %s', (id, exists) => {
    expect(requireDependencyTarget(graph, id as string, [])).toEqual(
      exists ? { value: [] } : { reason: 'task_not_found' }
    );
  });

  test.each([
    [[], undefined],
    [['b'], undefined],
    [['a'], 'self_dependency'],
    [['b', 'b'], 'duplicate_dependency'],
    [['a', 'a'], 'self_dependency'],
  ] as const)('checks distinct dependencies %j', (ids, reason) => {
    expect(requireDistinctDependencies('a', ids)).toEqual(reason ? { reason } : { value: ids });
  });

  test.each([
    [[], true],
    [['b', 'c'], true],
    [['b', 'absent'], false],
  ] as const)('checks referenced tasks %j', (ids, exists) => {
    expect(requireExistingDependencies(graph, ids)).toEqual(
      exists ? { value: ids } : { reason: 'dependency_not_found' }
    );
  });

  test.each([
    ['a', [], true],
    ['a', ['c'], true],
    ['c', ['a'], false],
    ['b', ['a'], false],
  ] as const)('checks cycles for %s with %j', (id, ids, acyclic) => {
    expect(requireAcyclicDependencies(graph, id, ids)).toEqual(
      acyclic ? { value: ids } : { reason: 'dependency_cycle' }
    );
  });
});

describe('dependency replacement decisions', () => {
  test('returns a detached replacement without mutating the graph or caller list', () => {
    const before = JSON.stringify(graph);
    const ids = ['c'];
    const result = planTaskDependencies(graph, 'a', ids);
    expect(result).toEqual(['c']);
    expect(result).not.toBe(ids);
    ids.push('b');
    expect(result).toEqual(['c']);
    expect(JSON.stringify(graph)).toBe(before);
  });

  test.each([
    ['missing', ['missing'], 'task_not_found'],
    ['a', ['a'], 'self_dependency'],
    ['a', ['b', 'b'], 'duplicate_dependency'],
    ['a', ['missing'], 'dependency_not_found'],
    ['c', ['a'], 'dependency_cycle'],
  ] as const)('rejects target %s with %j as %s', (id, ids, reason) => {
    expect(planTaskDependencies(graph, id, ids)).toBe(reason);
  });

  test('permits clearing edges to repair a cycle', () => {
    const cyclic = [
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
    ];
    expect(planTaskDependencies(cyclic, 'a', [])).toEqual([]);
  });

  test('rejects a cycle elsewhere in the supplied graph', () => {
    const cyclic = [...graph, { id: 'x', dependsOn: ['y'] }, { id: 'y', dependsOn: ['x'] }];
    expect(planTaskDependencies(cyclic, 'a', [])).toBe('dependency_cycle');
  });
});
