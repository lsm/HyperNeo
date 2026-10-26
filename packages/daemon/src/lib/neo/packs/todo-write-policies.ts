import type { Database } from '../../../storage/sqlite-compat.ts';
import type { NeoTodoPolicy } from '../todo-operations.ts';
import { createCodingTodoPolicy, CodingTodoPrRepository } from './coding/todo-prs.ts';

export function neoTodoWritePolicies(db: Database): readonly NeoTodoPolicy[] {
  return [{ id: 'coding', todos: createCodingTodoPolicy(new CodingTodoPrRepository(db)) }];
}
