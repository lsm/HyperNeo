import { describe, expect, test } from 'bun:test';
import { NeoTodoDraftSchema, planNeoTodoEdit } from '../../../../src/lib/neo/todo-operations.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

function store() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const todos = new NeoAskTodoRepository(db);
  todos.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: 'm1',
    title: 'Ship it',
    request: 'Ship it',
    createdAt: 1,
  });
  return { db, todos };
}

const draft = { title: 'Rows', doneWhen: 'done', check: null, instruction: null, named: null };

describe('todo priority', () => {
  test('a todo is normal unless Neo sets a priority, and the priority can change later', () => {
    const { db, todos } = store();
    try {
      const parsed = NeoTodoDraftSchema.parse({
        title: 'Rows',
        check: { pack: 'core', kind: 'evidence', params: {} },
      });
      expect(parsed.priority).toBe('normal');
      expect(todos.addTodo('plain', 'ask', draft, 1).priority).toBe('normal');
      const urgent = todos.addTodo('urgent', 'ask', { ...draft, priority: 'urgent' }, 2);
      expect(urgent.priority).toBe('urgent');
      const edit = planNeoTodoEdit(urgent, { todoId: urgent.id, priority: 'low' });
      if ('reason' in edit) throw new Error('edit refused');
      expect(todos.updateTodo(urgent, edit.value.patch, 3).priority).toBe('low');
    } finally {
      db.close();
    }
  });
});
