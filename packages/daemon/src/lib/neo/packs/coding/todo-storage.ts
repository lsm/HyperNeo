import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../../../../storage/reactive-database.ts';
import {
  NeoAskTodoRepository,
  type NeoTodoDraft,
} from '../../../../storage/repositories/neo-ask-todo-repository.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { prepareCodingTodoStorage } from './schema/coding-tables.ts';

class CodingTodoStorage {
  constructor(
    private readonly db: Database,
    private readonly changes?: Pick<ReactiveDatabase, 'notifyChange'>
  ) {}

  prepare(): void {
    prepareCodingTodoStorage(this.db);
    this.changes?.notifyChange('pack_coding_todos');
  }

  project(todo: NeoTodo): NeoTodo {
    const row = this.db
      .prepare('SELECT repo FROM pack_coding_todos WHERE todo_id = ?')
      .get(todo.id) as { repo: string | null } | null;
    return row ? { ...todo, repo: row.repo } : todo;
  }

  facts(askId: string): { legacy: string | null; repositories: string[] } {
    const ask = this.db.prepare('SELECT repo FROM neo_asks WHERE id = ?').get(askId) as {
      repo: string | null;
    } | null;
    const peers = this.db
      .prepare(`SELECT DISTINCT p.repo FROM pack_coding_todos p
        JOIN neo_todos t ON t.id = p.todo_id WHERE t.ask_id = ?
        AND p.repo IS NOT NULL AND p.repo <> '' ORDER BY p.repo`)
      .all(askId) as { repo: string }[];
    return { legacy: ask?.repo ?? null, repositories: peers.map((peer) => peer.repo) };
  }

  record(todoId: string, repo: string | null): void {
    this.db
      .prepare(`INSERT INTO pack_coding_todos (todo_id, repo) VALUES (?, ?)
        ON CONFLICT(todo_id) DO UPDATE SET repo = excluded.repo`)
      .run(todoId, repo);
    this.changes?.notifyChange('pack_coding_todos');
  }

  create(input: {
    id: string;
    askId: string;
    draft: NeoTodoDraft;
    now: number;
    repo: string | null;
  }): NeoTodo {
    const todo = new NeoAskTodoRepository(this.db).addTodo(
      input.id,
      input.askId,
      input.draft,
      input.now
    );
    this.record(todo.id, input.repo);
    this.changes?.notifyChange('neo_todos');
    this.changes?.notifyChange('neo_asks');
    return this.project(todo);
  }
}

export const codingTodoStorageReads = defineRepositoryOp(
  'coding.todoStorageReads',
  'read',
  CodingTodoStorage,
  ['project', 'facts']
);

export const codingTodoStorageWrites = defineRepositoryOp(
  'coding.todoStorageWrites',
  'write',
  CodingTodoStorage,
  ['prepare', 'record', 'create']
);
