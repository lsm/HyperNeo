import { coreTodoPolicy } from '../core-todo-checks.ts';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { NeoTodoPolicy } from '../todo-operations.ts';
import { createCodingTodoPolicy, CodingTodoPrRepository } from './coding/todo-prs.ts';

export function neoTodoPolicies(db: Database): readonly NeoTodoPolicy[] {
  return [
    { id: 'core', todos: coreTodoPolicy },
    { id: 'coding', todos: createCodingTodoPolicy(new CodingTodoPrRepository(db)) },
  ];
}
