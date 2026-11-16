import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';

type Step = Pick<NeoTodo, 'id' | 'title' | 'position' | 'state' | 'producesFollowUp'>;

export function neoTodoWithoutFollowUp<T extends Step>(todos: readonly T[]): T | null {
  const last = todos
    .filter((todo) => todo.state !== 'removed')
    .reduce<T | null>(
      (latest, todo) => (!latest || todo.position > latest.position ? todo : latest),
      null
    );
  return last?.producesFollowUp && last.state === 'done' ? last : null;
}

export function neoTodoFollowUpRefusal(todos: readonly Step[]): string | null {
  const gap = neoTodoWithoutFollowUp(todos);
  return gap
    ? `follow_up_missing: todo "${gap.title}" (${gap.id}) produces follow-up work and no todo follows it. Add each follow-up with neo.todo.add after:["${gap.id}"] (unstarted is fine) before settling done, or settle dropped.`
    : null;
}

export async function wakeNeoFollowUpGaps(
  todos: { listOpenAsks(): NeoAsk[]; listTodos(askId: string): NeoTodo[] },
  wake: (key: string, text: string) => Promise<boolean>
): Promise<void> {
  for (const ask of todos.listOpenAsks()) {
    const gap = neoTodoWithoutFollowUp(todos.listTodos(ask.id));
    if (gap)
      await wake(
        `neo-follow-up-missing:${ask.id}:${gap.id}`,
        `Todo "${gap.title}" (${gap.id}) in ask "${ask.title}" (${ask.id}) finished and produces follow-up work, but no todo follows it. Add the follow-up todos it calls for with neo.todo.add after:["${gap.id}"]; the ask cannot settle done until one exists.`
      ).catch(() => false);
  }
}
