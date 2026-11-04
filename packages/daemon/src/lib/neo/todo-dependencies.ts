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
  return todos.map((todo) => {
    if (todo.dependsOn) return { id: todo.id, dependsOn: todo.dependsOn };
    const previous = todos
      .filter((other) => other.askId === todo.askId && other.position < todo.position)
      .sort((a, b) => b.position - a.position)[0];
    return { id: todo.id, dependsOn: previous ? [previous.id] : [] };
  });
}

export const neoTodoFinished = (todo: NeoTodo | undefined) =>
  todo?.state === 'done' || (todo?.state === 'closed_unverified' && todo.startedAt !== null);

const dependencies = (todos: readonly NeoTodo[], todoId: string) =>
  neoTodoDependencyNodes(todos).find((item) => item.id === todoId)?.dependsOn ?? [];

export function neoTodoReady(todos: readonly NeoTodo[], todoId: string): boolean {
  return dependencies(todos, todoId).every((id) =>
    neoTodoFinished(todos.find((todo) => todo.id === id))
  );
}

export function neoTodoCancelledDependencies(todos: readonly NeoTodo[], todoId: string): NeoTodo[] {
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
  const live = (id: string | null) =>
    todos.some((todo) => todo.id === id && todo.state !== 'removed');
  return [
    ...new Set(
      dependencies(todos, todoId).flatMap((id) => {
        const gone = cancelled.find((todo) => todo.id === id);
        if (!gone) return [id];
        return gone.replacedBy && live(gone.replacedBy) ? [gone.replacedBy] : [];
      })
    ),
  ];
}

export const planNeoTodoDependencies = (superpipe({})('neo.todo.plan-dependencies') as PipelineAPI)
  .input(['todos', 'todoId', 'after'])
  .pipe(neoTodoDependencyNodes, 'todos', 'nodes')
  .pipe(requireDistinctDependencies, ['todoId', 'after'], 'result:dependencies')
  .pipe(
    (todos: readonly NeoTodo[]) => todos.filter((todo) => todo.state !== 'removed'),
    'todos',
    'available'
  )
  .pipe(requireExistingDependencies, ['available', 'after'], 'result:dependencies')
  .pipe(requireAcyclicDependencies, ['nodes', 'todoId', 'after'], 'result:dependencies')
  .pipe((after: readonly string[]) => [...after], 'after', 'dependencies')
  .end('dependencies') as (
  todos: readonly NeoTodo[],
  todoId: string,
  after: readonly string[]
) => string[] | DependencyRejection;

export const NEO_TODO_CANCELLED_DEPENDENCY =
  'cancelled_dependency: a prerequisite of this step was cancelled; only the human can clear it by answering its card.';

export const NEO_TODO_NOT_READY =
  'not_ready: this step waits for unfinished steps; add it without start and the daemon starts it once they are done.';

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
