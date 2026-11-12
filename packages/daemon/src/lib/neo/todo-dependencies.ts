import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { DependencyNode } from '../work-queue/dependency-graph.ts';
import {
  type DependencyRejection,
  requireAcyclicDependencies,
  requireDistinctDependencies,
  requireExistingDependencies,
} from '../work-queue/dependency-plan.ts';

export type NeoTodoEdge = Pick<
  NeoTodo,
  'id' | 'askId' | 'position' | 'dependsOn' | 'state' | 'startedAt' | 'replacedBy'
>;

export function neoTodoDependencyNodes(todos: readonly NeoTodoEdge[]): DependencyNode[] {
  return todos.map((todo) => ({ id: todo.id, dependsOn: todo.dependsOn ?? [] }));
}

export const neoTodoFinished = (todo: NeoTodo | undefined) =>
  todo?.state === 'done' || (todo?.state === 'closed_unverified' && todo.startedAt !== null);

const dependencies = (todos: readonly NeoTodoEdge[], todoId: string) =>
  neoTodoDependencyNodes(todos).find((item) => item.id === todoId)?.dependsOn ?? [];

export function neoTodoReady(todos: readonly NeoTodo[], todoId: string): boolean {
  return dependencies(todos, todoId).every((id) =>
    neoTodoFinished(todos.find((todo) => todo.id === id))
  );
}

export function neoTodoCancelledDependencies<T extends NeoTodoEdge>(
  todos: readonly T[],
  todoId: string
): T[] {
  const ids = dependencies(todos, todoId);
  return todos.filter(
    (todo) =>
      ids.includes(todo.id) &&
      (todo.state === 'removed' || (todo.state === 'closed_unverified' && todo.startedAt === null))
  );
}

export function neoTodoDependenciesAfterApproval(
  todos: readonly NeoTodo[],
  todoId: string
): string[] {
  const cancelled = neoTodoCancelledDependencies(todos, todoId);
  const replacement = (todo: NeoTodo, seen = new Set<string>()): string[] => {
    const next = todos.find((item) => item.id === todo.replacedBy);
    if (!next || seen.has(next.id)) return [];
    if (next.state === 'removed') return replacement(next, seen.add(next.id));
    return typeof planNeoTodoDependencies(todos, todoId, [next.id]) === 'string' ? [] : [next.id];
  };
  return [
    ...new Set(
      dependencies(todos, todoId).flatMap((id) => {
        const gone = cancelled.find((todo) => todo.id === id);
        return gone ? replacement(gone) : [id];
      })
    ),
  ];
}

function liveDependencyNodes(
  todos: readonly NeoTodoEdge[],
  available: readonly NeoTodoEdge[]
): DependencyNode[] {
  const live = new Set(available.map((todo) => todo.id));
  return neoTodoDependencyNodes(todos)
    .filter((node) => live.has(node.id))
    .map((node) => ({ ...node, dependsOn: node.dependsOn?.filter((id) => live.has(id)) }));
}

export const planNeoTodoDependencies = (superpipe({})('neo.todo.plan-dependencies') as PipelineAPI)
  .input(['todos', 'todoId', 'after'])
  .pipe(requireDistinctDependencies, ['todoId', 'after'], 'result:dependencies')
  .pipe(
    (todos: readonly NeoTodoEdge[]) => todos.filter((todo) => todo.state !== 'removed'),
    'todos',
    'available'
  )
  .pipe(requireExistingDependencies, ['available', 'after'], 'result:dependencies')
  .pipe(liveDependencyNodes, ['todos', 'available'], 'nodes')
  .pipe(requireAcyclicDependencies, ['nodes', 'todoId', 'after'], 'result:dependencies')
  .pipe((after: readonly string[]) => [...after], 'after', 'dependencies')
  .end('dependencies') as (
  todos: readonly NeoTodoEdge[],
  todoId: string,
  after: readonly string[]
) => string[] | DependencyRejection;

export const NEO_TODO_CANCELLED_DEPENDENCY =
  'cancelled_dependency: a prerequisite of this step was cancelled; continue it with neo.todo.proceed or stop it with neo.todo.remove.';

export const NEO_TODO_NOT_READY =
  'not_ready: this step waits for unfinished steps; add it without start and the daemon starts it once they are done.';

export const NEO_TODO_PREREQUISITE_UNFINISHED =
  'not_ready: this step waits for unfinished steps; nothing was sent, try again once they are done.';

export function neoTodoAfterRefusal(
  existing: readonly NeoTodo[],
  index: number | null,
  after: readonly (string | number)[] | undefined
): string | null {
  if (!after) return null;
  const live = new Set(existing.filter((todo) => todo.state !== 'removed').map((todo) => todo.id));
  if (new Set(after).size !== after.length) return neoTodoDependencyRefusal('duplicate_dependency');
  return after.some((ref) =>
    typeof ref === 'number' ? index === null || ref >= index : !live.has(ref)
  )
    ? neoTodoDependencyRefusal('dependency_not_found')
    : null;
}

export function neoTodoDependencyRefusal(reason: DependencyRejection): string {
  return `${reason}: after must name other unremoved todos of this ask without a cycle.`;
}
