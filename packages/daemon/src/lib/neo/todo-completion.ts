import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoPack, NeoTodoCheckResult } from './pack-contract.ts';
import type { NeoTodoPatch } from '../../storage/repositories/neo-ask-todo-repository.ts';

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

export function requireNeoTodoMayFinish<T extends { todo: NeoTodo; patch?: NeoTodoPatch }>(
  plan: T,
  result: NeoTodoCheckResult | null
): Gate<T> {
  if (plan.patch?.state !== 'done') return { value: plan };
  if (result?.done) return { value: { ...plan, patch: { ...plan.patch, reason: null } } };
  const check = plan.todo.check;
  return {
    value: {
      ...plan,
      patch: {
        ...plan.patch,
        state: 'blocked',
        finishedAt: null,
        blockedBy: 'check',
        blockedReason: result?.failed
          ? `check_failed: ${result.failed}`
          : `check_unmet: ${check ? `"${plan.todo.doneWhen ?? `${check.pack}.${check.kind}`}"` : 'outcome'} has not passed.`,
        nextAction: 'It finishes when its check passes; fix a wrong check with neo.todo.edit.',
      },
    },
  };
}
