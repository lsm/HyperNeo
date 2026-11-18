import superpipe, { type PipelineAPI } from 'superpipe';
import type { RunDbOp } from '../../storage/db-gateway/db-op.ts';
import {
  neoTodoMoveReads,
  neoTodoMoveWrites,
  type NeoTodoMove,
} from '../../storage/repositories/neo-todo-move-worker.ts';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { WorkRef } from '../drivers/types.ts';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';

type RetargetResult = { ok: false; reason: string } | { ok: true; todo?: NeoTodo };

export function createNeoTodoRetarget(
  write: RunDbOp,
  store: NeoAskTodoRepository,
  stop: (todoId: string, ref: WorkRef) => Promise<string | null>,
  start: (todoId: string, replaced: WorkRef) => Promise<unknown>,
  tell: (todoId: string, text: string, at: number) => Promise<unknown>,
  changed: () => void
) {
  const resume = (superpipe({})('neo.todo.retarget') as PipelineAPI)
    .input(['move'])
    .pipe(
      async (move: NeoTodoMove) =>
        (await write(neoTodoMoveWrites, { method: 'active', args: [move] }))
          ? { value: move }
          : { reason: null },
      'move',
      'result:move'
    )
    .pipe((move: NeoTodoMove) => stop(move.todoId, move.fromRef), 'move', 'refusal')
    .pipe(
      async (move: NeoTodoMove, refusal: string | null) => {
        if (!refusal) return { value: move };
        if (await write(neoTodoMoveWrites, { method: 'release', args: [move] }))
          await tell(
            move.todoId,
            `The worker could not be stopped (${refusal}); the todo was not moved.`,
            move.at
          );
        return { reason: { ok: false, reason: refusal } };
      },
      ['move', 'refusal'],
      'result:move'
    )
    .pipe(
      (move: NeoTodoMove) => write(neoTodoMoveWrites, { method: 'reopen', args: [move] }),
      'move',
      'reopened'
    )
    .pipe(
      async (move: NeoTodoMove, reopened: boolean) => {
        if (reopened) {
          changed();
          await start(move.todoId, move.fromRef);
        }
        return { ok: true, todo: store.getTodo(move.todoId) ?? undefined };
      },
      ['move', 'reopened'],
      'move'
    )
    .endAsync('move') as (move: NeoTodoMove) => Promise<RetargetResult | null>;
  return {
    async retarget(todoId: string, fromRef: WorkRef): Promise<RetargetResult> {
      const claim = (await write(neoTodoMoveWrites, {
        method: 'claim',
        args: [todoId, fromRef, Date.now()],
      })) as ReturnType<InstanceType<typeof neoTodoMoveWrites.Repository>['claim']>;
      if (claim.reason) return { ok: false, reason: claim.reason };
      return (
        (claim.move && (await resume(claim.move))) ?? {
          ok: true,
          todo: store.getTodo(todoId) ?? undefined,
        }
      );
    },
    async recoverMoves() {
      for (const move of (await write(neoTodoMoveReads, {
        method: 'pending',
        args: [],
      })) as NeoTodoMove[])
        await resume(move);
    },
  };
}
