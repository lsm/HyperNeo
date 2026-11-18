import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';

type Step = Pick<NeoTodo, 'id' | 'title' | 'state' | 'producesFollowUp' | 'dependsOn'>;

export function neoTodoWithoutFollowUp<T extends Step>(todos: readonly T[]): T | null {
  return (
    todos.find(
      (todo) =>
        todo.producesFollowUp &&
        todo.state === 'done' &&
        !todos.some((other) => other.state !== 'removed' && other.dependsOn?.includes(todo.id))
    ) ?? null
  );
}

export function neoTodoFollowUpRefusal(todos: readonly Step[]): string | null {
  const gap = neoTodoWithoutFollowUp(todos);
  return gap
    ? `follow_up_missing: todo "${gap.title}" (${gap.id}) produces follow-up work and no todo follows it. Add each follow-up with neo.todo.add after:["${gap.id}"] (unstarted is fine) before settling done, or settle dropped.`
    : null;
}
