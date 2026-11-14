import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { defineDbOp, type ChangeRecorder } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';

type Input = { todoId: string; on: boolean; now: number };
export type DesktopControlResult =
  | { accepted: true; desktopControl: boolean }
  | { accepted: false; reason: 'todo_not_found' | 'todo_finished' };

const set = (superpipe({})('desktop.control.set') as PipelineAPI)
  .input(['db', 'input', 'changes'])
  .pipe(
    (db: Database, changes: ChangeRecorder) =>
      new NeoAskTodoRepository(
        db,
        () => changes.notifyChange('neo_todos'),
        undefined,
        undefined,
        changes
      ),
    ['db', 'changes'],
    'store'
  )
  .pipe(
    (store: NeoAskTodoRepository, input: Input) => {
      const todo = store.getTodo(input.todoId);
      if (!todo) return { reason: { accepted: false, reason: 'todo_not_found' } };
      return ['todo', 'doing', 'blocked'].includes(todo.state)
        ? { value: todo }
        : { reason: { accepted: false, reason: 'todo_finished' } };
    },
    ['store', 'input'],
    'result:control'
  )
  .pipe(
    (store: NeoAskTodoRepository, todo: NeoTodo, input: Input) => {
      store.updateTodo(todo, { named: { ...todo.named, desktopControl: input.on } }, input.now);
      return { value: { accepted: true, desktopControl: input.on } };
    },
    ['store', 'control', 'input'],
    'result:control'
  )
  .end('control') as (db: Database, input: Input, changes: ChangeRecorder) => DesktopControlResult;

export const neoTodoDesktopControlWrite = defineDbOp<Input, DesktopControlResult>({
  name: 'desktop.control.set',
  mode: 'write',
  run: (db, input, changes) => set(db, input, changes),
});
