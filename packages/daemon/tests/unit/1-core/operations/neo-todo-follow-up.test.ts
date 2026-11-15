import { describe, expect, test } from 'bun:test';
import {
  neoTodoFollowUpRefusal,
  wakeNeoFollowUpGaps,
} from '../../../../src/lib/neo/todo-follow-up.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const draft = { doneWhen: 'Written', check: null, named: null, instruction: null };

function setup(flagged = true) {
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
    { ...draft, title: 'Write the plan', ...(flagged ? { producesFollowUp: true } : {}) },
    1
  );
  const wakes: { key: string; text: string }[] = [];
  const wake = async (key: string, text: string) => {
    wakes.push({ key, text });
    return true;
  };
  return { store, ask, plan, wakes, wake };
}

describe('wakeNeoFollowUpGaps', () => {
  test('wakes Neo with one stable key once a todo that produces work is done with nothing after it', async () => {
    const h = setup();
    await wakeNeoFollowUpGaps(h.store, h.wake);
    expect(h.wakes).toEqual([]);
    h.store.updateTodo(h.plan, { state: 'done' }, 2);
    await wakeNeoFollowUpGaps(h.store, h.wake);
    await wakeNeoFollowUpGaps(h.store, h.wake);
    expect(h.wakes).toHaveLength(2);
    expect(h.wakes[0].key).toBe(h.wakes[1].key);
    expect(h.wakes[0].text).toContain('Write the plan');
    expect(h.wakes[0].text).toContain('ask-1');
  });

  test('stays quiet once a later todo exists, even an unstarted one', async () => {
    const h = setup();
    h.store.updateTodo(h.plan, { state: 'done' }, 2);
    h.store.addTodo('todo-build', h.ask.id, { ...draft, title: 'Build it' }, 3);
    await wakeNeoFollowUpGaps(h.store, h.wake);
    expect(h.wakes).toEqual([]);
  });

  test('stays quiet for a done todo without the marker, and for a settled ask', async () => {
    const plain = setup(false);
    plain.store.updateTodo(plain.plan, { state: 'done' }, 2);
    await wakeNeoFollowUpGaps(plain.store, plain.wake);
    expect(plain.wakes).toEqual([]);
    const settled = setup();
    settled.store.updateTodo(settled.plan, { state: 'done' }, 2);
    settled.store.settleAsk(settled.ask, 'dropped', 'Not needed', 3);
    await wakeNeoFollowUpGaps(settled.store, settled.wake);
    expect(settled.wakes).toEqual([]);
  });
});

describe('neoTodoFollowUpRefusal', () => {
  test('refuses while the marked todo is done and last, and a removed later todo does not count', () => {
    const h = setup();
    h.store.updateTodo(h.plan, { state: 'done' }, 2);
    expect(h.store.getTodo('todo-plan')?.producesFollowUp).toBe(true);
    expect(neoTodoFollowUpRefusal(h.store.listTodos(h.ask.id))).toContain('follow_up_missing');
    const later = h.store.addTodo('todo-build', h.ask.id, { ...draft, title: 'Build it' }, 3);
    expect(neoTodoFollowUpRefusal(h.store.listTodos(h.ask.id))).toBeNull();
    h.store.updateTodo(later, { state: 'removed', reason: 'dropped' }, 4);
    expect(neoTodoFollowUpRefusal(h.store.listTodos(h.ask.id))).toContain('follow_up_missing');
  });
});
