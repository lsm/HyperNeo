import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { DependencyNode } from '../work-queue/dependency-graph.ts';
import {
  type DependencyRejection,
  requireAcyclicDependencies,
  requireDistinctDependencies,
  requireExistingDependencies,
} from '../work-queue/dependency-plan.ts';

export function neoTodoDependencyNodes(todos: readonly NeoTodo[]): DependencyNode[] {
  const live = todos.filter((todo) => todo.state !== 'removed');
  return live.map((todo) => {
    if (todo.dependsOn) return { id: todo.id, dependsOn: todo.dependsOn };
    const previous = live
      .filter((other) => other.askId === todo.askId && other.position < todo.position)
      .sort((a, b) => b.position - a.position)[0];
    return { id: todo.id, dependsOn: previous ? [previous.id] : [] };
  });
}

export function neoTodoReady(todos: readonly NeoTodo[], todoId: string): boolean {
  const states = new Map(todos.map((todo) => [todo.id, todo.state]));
  const node = neoTodoDependencyNodes(todos).find((item) => item.id === todoId);
  return (node?.dependsOn ?? []).every((id) =>
    ['done', 'closed_unverified', 'removed', undefined].includes(states.get(id))
  );
}

export const planNeoTodoDependencies = (superpipe({})('neo.todo.plan-dependencies') as PipelineAPI)
  .input(['todos', 'todoId', 'after'])
  .pipe(neoTodoDependencyNodes, 'todos', 'nodes')
  .pipe(requireDistinctDependencies, ['todoId', 'after'], 'result:dependencies')
  .pipe(requireExistingDependencies, ['nodes', 'after'], 'result:dependencies')
  .pipe(requireAcyclicDependencies, ['nodes', 'todoId', 'after'], 'result:dependencies')
  .pipe((after: readonly string[]) => [...after], 'after', 'dependencies')
  .end('dependencies') as (
  todos: readonly NeoTodo[],
  todoId: string,
  after: readonly string[]
) => string[] | DependencyRejection;

export const NEO_TODO_NOT_READY =
  'not_ready: this step waits for unfinished steps; add it without start and the daemon starts it once they are done.';

export function neoTodoAfterRefusal(
  existing: readonly NeoTodo[],
  index: number | null,
  after: readonly (string | number)[] | undefined,
  start: boolean
): string | null {
  if (!after) return null;
  const live = new Map(
    existing.filter((todo) => todo.state !== 'removed').map((todo) => [todo.id, todo.state])
  );
  if (new Set(after).size !== after.length) return neoTodoDependencyRefusal('duplicate_dependency');
  if (
    after.some((ref) => (typeof ref === 'number' ? index === null || ref >= index : !live.has(ref)))
  )
    return neoTodoDependencyRefusal('dependency_not_found');
  return start &&
    after.some(
      (ref) =>
        typeof ref === 'number' || !['done', 'closed_unverified'].includes(live.get(ref) ?? '')
    )
    ? NEO_TODO_NOT_READY
    : null;
}

export function neoTodoDependencyRefusal(reason: DependencyRejection): string {
  return `${reason}: after must name other unremoved todos of this ask without a cycle.`;
}
