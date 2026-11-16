import superpipe, { type PipelineAPI } from 'superpipe';
import type { RunDbOp } from '../../storage/db-gateway/db-op.ts';
import {
  neoTodoMoveReads,
  neoTodoMoveWrites,
  type NeoTodoMove,
} from '../../storage/repositories/neo-todo-move-worker.ts';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { WorkRef } from '../drivers/types.ts';

export function createNeoTodoRetarget(
  write: RunDbOp,
  store: NeoAskTodoRepository,
  stop: (todoId: string, ref: WorkRef) => Promise<string | null>,
  start: (todoId: string) => Promise<unknown>,
  tell: (todoId: string, text: string, at: number) => Promise<unknown>
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
        if (reopened) await start(move.todoId);
        return { ok: true, todo: store.getTodo(move.todoId) };
      },
      ['move', 'reopened'],
      'move'
    )
    .endAsync('move') as (
    move: NeoTodoMove
  ) => Promise<{ ok: boolean; reason?: string; todo?: unknown } | null>;
  return {
    async retarget(todoId: string, fromRef: WorkRef) {
      const claim = (await write(neoTodoMoveWrites, {
        method: 'claim',
        args: [todoId, fromRef, Date.now()],
      })) as ReturnType<InstanceType<typeof neoTodoMoveWrites.Repository>['claim']>;
      if ('reason' in claim) return { ok: false, reason: claim.reason };
      return (
        (claim.move && (await resume(claim.move))) ?? { ok: true, todo: store.getTodo(todoId) }
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
