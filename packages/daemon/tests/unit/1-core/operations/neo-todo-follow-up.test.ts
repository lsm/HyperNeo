import { describe, expect, test } from 'bun:test';
import { neoTodoFollowUpRefusal } from '../../../../src/lib/neo/todo-follow-up.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const draft = { doneWhen: 'Written', check: null, named: null, instruction: null };

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  const ask = store.openAsk({
    id: 'ask-1',
    title: 'Cache layer',
    request: 'Plan and build the cache layer',
    sessionId: 'neo-a',
    projectId: null,
    originMessageId: null,
    createdAt: 1,
  });
  const plan = store.addTodo(
    'todo-plan',
    ask.id,
    { ...draft, title: 'Write the plan', producesFollowUp: true },
    1
  );
  return { store, ask, plan };
}

describe('neoTodoFollowUpRefusal', () => {
  test('refuses while the marked todo is done and last, and a removed later todo does not count', () => {
    const h = setup();
    h.store.updateTodo(h.plan, { state: 'done' }, 2);
    expect(h.store.getTodo('todo-plan')?.producesFollowUp).toBe(true);
    expect(neoTodoFollowUpRefusal(h.store.listTodos(h.ask.id))).toContain('follow_up_missing');
    const later = h.store.addTodo(
      'todo-build',
      h.ask.id,
      { ...draft, title: 'Build it', dependsOn: [h.plan.id] },
      3
    );
    expect(neoTodoFollowUpRefusal(h.store.listTodos(h.ask.id))).toBeNull();
    h.store.updateTodo(later, { state: 'removed', reason: 'dropped' }, 4);
    expect(neoTodoFollowUpRefusal(h.store.listTodos(h.ask.id))).toContain('follow_up_missing');
  });

  test('refuses when an unrelated later todo hides a removed follow-up', () => {
    const h = setup();
    h.store.updateTodo(h.plan, { state: 'done' }, 2);
    const followUp = h.store.addTodo(
      'todo-build',
      h.ask.id,
      { ...draft, title: 'Build it', dependsOn: [h.plan.id] },
      3
    );
    h.store.updateTodo(followUp, { state: 'removed', reason: 'dropped' }, 4);
    h.store.addTodo('todo-other', h.ask.id, { ...draft, title: 'Other work', dependsOn: [] }, 5);
    expect(neoTodoFollowUpRefusal(h.store.listTodos(h.ask.id))).toContain('follow_up_missing');
  });
});
