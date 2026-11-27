export type TurnTodoFacts = {
  keys: Readonly<Record<string, readonly string[]>>;
  starter: string | null;
  roles: Readonly<Record<string, string>>;
};

export type TurnTodo = { todo: string; role: string };

export function turnKeyTodos(
  turn: { id: string; inputs: readonly string[] },
  keys: TurnTodoFacts['keys']
): string[] {
  return [...new Set([turn.id, ...turn.inputs].flatMap((id) => keys[id] ?? []))];
}

export function planTurnTodo(
  turn: { id: string; inputs: readonly string[] },
  facts: TurnTodoFacts
): TurnTodo | null {
  const keyed = turnKeyTodos(turn, facts.keys);
  const todo = keyed.length ? (keyed.length === 1 ? keyed[0] : null) : facts.starter;
  return todo ? { todo, role: facts.roles[todo] ?? 'do' } : null;
}
