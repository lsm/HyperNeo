import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoPack, NeoTodoCheckResult } from './pack-contract.ts';

type Gate<T> = { value: T } | { reason: { ok: false; reason: string } };

export function sameNeoTodoCheck(expected: NeoTodo, current: NeoTodo | null): boolean {
  return !!current && JSON.stringify(expected.check) === JSON.stringify(current.check);
}

export async function readNeoTodoCompletion(
  packs: readonly NeoPack[],
  todo: NeoTodo
): Promise<NeoTodoCheckResult | null> {
  const rule = todo.check ? packs.find((pack) => pack.id === todo.check?.pack)?.todos : null;
  return rule ? rule.check(todo) : null;
}

export function requireNeoTodoMayFinish<T extends { todo: NeoTodo }>(
  plan: T,
  result: NeoTodoCheckResult | null
): Gate<T> {
  if (!result || result.done) return { value: plan };
  const check = plan.todo.check;
  return {
    reason: {
      ok: false,
      reason: result.failed
        ? `check_failed: ${result.failed}`
        : `check_unmet: ${check?.pack}.${check?.kind} is not met yet; the todo finishes on its own when it passes.`,
    },
  };
}
