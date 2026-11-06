import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { neoTodoDependencyNodes, neoTodoFinished, neoTodoReady } from './todo-dependencies.ts';
import { neoTodoWaitReason } from './todo-start-gate.ts';

export type NeoPlanLine = {
  kind: 'ask' | 'todo';
  id: string;
  askId: string;
  text: string;
  omitted?: boolean;
};

export function neoPlanLines(
  asks: readonly NeoAsk[],
  todos: readonly NeoTodo[],
  questions: readonly NeoQuestion[]
): NeoPlanLine[] {
  const nodes = neoTodoDependencyNodes(todos);
  return asks
    .filter((ask) => ask.status === 'open')
    .flatMap((ask) => {
      const open = questions.filter((q) => q.askId === ask.id && q.state === 'open');
      return [
        {
          kind: 'ask' as const,
          id: ask.id,
          askId: ask.id,
          text: `Ask ${ask.id} [${ask.status}] ${ask.title} questions=${open.length}`.replace(
            /\s+/g,
            ' '
          ),
        },
        ...todos
          .filter((todo) => todo.askId === ask.id && !['done', 'removed'].includes(todo.state))
          .map((todo) => {
            const waits =
              nodes
                .find((node) => node.id === todo.id)
                ?.dependsOn?.filter(
                  (id) => !neoTodoFinished(todos.find((other) => other.id === id))
                ) ?? [];
            const wait = neoTodoWaitReason(todo, todos, open);
            const ready =
              todo.state === 'todo' &&
              todo.approvedAt !== null &&
              neoTodoReady(todos, todo.id) &&
              !wait;
            return {
              kind: 'todo' as const,
              id: todo.id,
              askId: ask.id,
              text: `  Todo ${todo.id} [${todo.state}] ${todo.title}; waits=${waits.join(',') || 'none'}; reason=${todo.blockedReason ?? wait ?? todo.reason ?? 'none'}; ready=${ready}; questions=${open.filter((q) => !q.todoId || q.todoId === todo.id).length}`.replace(
                /\s+/g,
                ' '
              ),
            };
          }),
      ];
    });
}

export function fitNeoPlanLines(lines: readonly NeoPlanLine[], budget: number): NeoPlanLine[] {
  if (Buffer.byteLength(lines.map((line) => line.text).join('\n'), 'utf8') <= budget)
    return [...lines];
  return lines
    .filter((line) => line.kind === 'ask')
    .map((line) => {
      const omitted = lines.some((detail) => detail.kind === 'todo' && detail.askId === line.askId);
      return {
        ...line,
        omitted,
        text: omitted ? `${line.text} (Steps omitted; use neo.ask.read ${line.askId}.)` : line.text,
      };
    });
}

export function planNeoPlanContext(
  previous: readonly NeoPlanLine[] | null,
  lines: readonly NeoPlanLine[],
  source: 'startup' | 'resume' | 'compact' | 'prompt'
): string {
  if (source !== 'prompt' || previous === null)
    return `Open plans\n${lines.map((line) => line.text).join('\n') || '(none)'}`;
  const changed = lines.filter(
    (line) =>
      !previous.some(
        (old) => old.kind === line.kind && old.id === line.id && old.text === line.text
      )
  );
  const removed = previous.filter(
    (old) =>
      !lines.some(
        (line) =>
          (line.kind === old.kind && line.id === old.id) ||
          (old.kind === 'todo' && line.kind === 'ask' && line.id === old.askId && line.omitted)
      )
  );
  return [
    ...changed.map((line) => line.text),
    ...removed.map((line) => `${line.kind} ${line.id}: no longer open or pending.`),
  ].join('\n');
}
