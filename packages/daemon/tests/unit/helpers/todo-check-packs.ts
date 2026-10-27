import type { Database } from '../../../src/storage/sqlite-compat.ts';
import type { WorkRef } from '../../../src/lib/drivers/types.ts';

import { createCoreTodoPack } from '../../../src/lib/neo/core-todo-checks.ts';
import {
  CodingTodoPrRepository,
  createCodingTodoPack,
} from '../../../src/lib/neo/packs/coding/todo-prs.ts';

export async function existingTodoTarget(ref: WorkRef) {
  return { value: ref };
}

export const pendingTodoCheck = {
  pack: 'core',
  kind: 'evidence',
  params: { path: '/synthetic/pending' },
};
export function createTodoCheckPacks(db: Database) {
  const todos = createCodingTodoPack(new CodingTodoPrRepository(db), async () => []);
  todos.schema(db);
  return [
    createCoreTodoPack(db, async () => false),
    {
      id: 'coding',
      describe: 'Coding',
      instructions: () => null,
      todos,
    },
  ];
}
