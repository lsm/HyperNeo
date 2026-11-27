import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDriverOutcome } from '../../../../src/lib/neo/driver-work.ts';
import { planTurnTodo } from '../../../../src/lib/neo/turn-todo.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { WorkDeliveryInputRepository } from '../../../../src/storage/repositories/work-delivery-input-repository.ts';
import { recordWorkerStarted } from '../../../../src/storage/repositories/work-started-sessions-worker.ts';
import { readTurnTodoFacts } from '../../../../src/storage/repositories/work-turn-todo-read.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const worker = { adapter: 'codex-desktop', id: 'worker' };
const place = { machine: 'mini', folder: '/repo', name: 'repo' };
const turn = (id: string, inputs: string[] = []) => ({ id, inputs });

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function open(path = ':memory:') {
  const db = new Database(path);
  runMigrations(db, () => {});
  createTables(db);
  return db;
}

function setup(path?: string) {
  const db = open(path);
  const store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: null,
    title: 'ask',
    request: 'ask',
    createdAt: 1,
  });
  for (const id of ['a', 'b', 'c'])
    store.addTodo(
      id,
      'ask',
      { title: id, doneWhen: 'Observed', check: null, instruction: 'Go', named: null },
      1
    );
  const inputs = new WorkDeliveryInputRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const deliver = async (
    todoId: string,
    value: unknown,
    target: object = { verb: 'send', ref: worker }
  ) => {
    const id = await inputs.accept(todoId, 'neo', target as never, 'work', Date.now());
    if (value !== undefined)
      await inputs.recordOutcome(
        id,
        readDriverOutcome(target as never, { kind: 'completed', value }) as never,
        Date.now()
      );
    return id;
  };
  const start = (todoId: string, ref = worker) =>
    recordWorkerStarted(db, ref, {
      startedBy: 'neo',
      todoId,
      machine: 'mini',
      harness: ref.adapter,
    });
  const todoOf = (t: ReturnType<typeof turn>, ref = worker) =>
    planTurnTodo(t, readTurnTodoFacts(db, ref));
  return { db, store, inputs, sessions, deliver, start, todoOf };
}

describe('which todo a turn belongs to', () => {
  test('receipts, started turn ids and steered turn ids give their todo', async () => {
    const h = setup();
    await h.deliver('a', {
      ok: true,
      value: { delivered: true, receipt: { executionId: 'w', inputId: 'desktop-pending:120:abc' } },
    });
    await h.deliver('b', { ok: true, value: { delivered: true, startedTurnId: 't-started' } });
    await h.deliver('c', { ok: true, value: { delivered: true, steeredIntoTurnId: 't-steered' } });
    expect(h.todoOf(turn('t1', ['desktop-pending:abc']))?.todo).toBe('a');
    expect(h.todoOf(turn('t-started'))?.todo).toBe('b');
    expect(h.todoOf(turn('t-steered', ['someone-else']))?.todo).toBe('c');
  });

  test('a turn matching two todos has none', async () => {
    const h = setup();
    await h.deliver('a', {
      ok: true,
      value: { delivered: true, receipt: { executionId: 'w', inputId: 'in-a' } },
    });
    await h.deliver('b', { ok: true, value: { delivered: true, steeredIntoTurnId: 't1' } });
    expect(h.todoOf(turn('t1', ['in-a']))).toBeNull();
  });

  test('a Claude Desktop relay send without an input id gives no todo by its receipt', async () => {
    const h = setup();
    const desktop = { adapter: 'claude-desktop', id: 'relay' };
    await h.deliver('a', { ok: true, value: { delivered: true } }, { verb: 'send', ref: desktop });
    expect(h.todoOf(turn('t1', ['some-input']), desktop)).toBeNull();
  });

  test("a started worker's turns, a human's too, keep its todo while no other todo names it", async () => {
    const h = setup();
    h.start('a');
    await h.deliver(
      'a',
      { ok: true, value: { ref: worker } },
      { verb: 'start', adapter: worker.adapter, place }
    );
    expect(h.todoOf(turn('t1', ['typed-by-human']))).toEqual({ todo: 'a', role: 'do' });
  });

  test("a pending or failed send of another todo takes the starting todo's credit, earlier turns too", async () => {
    for (const outcome of [undefined, { ok: false, reason: 'not_delivered', detail: 'lost' }]) {
      const h = setup();
      h.start('a');
      expect(h.todoOf(turn('early'))?.todo).toBe('a');
      await h.deliver('b', outcome);
      expect(h.todoOf(turn('early'))).toBeNull();
      expect(h.todoOf(turn('late'))).toBeNull();
    }
  });

  test('a notSent failure of another todo leaves the starting todo its credit', async () => {
    const h = setup();
    h.start('a');
    await h.deliver('b', { ok: false, reason: 'not_delivered', detail: 'refused', notSent: true });
    expect(h.todoOf(turn('t1'))?.todo).toBe('a');
  });

  test("another todo's adoption takes the credit, also after it rebinds, is unclaimed or deleted", async () => {
    for (const after of ['rebind', 'unclaim', 'delete'] as const) {
      const h = setup();
      h.start('a');
      h.sessions.bind('b', worker, Date.now());
      if (after === 'rebind')
        h.sessions.bind('b', { adapter: 'codex-desktop', id: 'other' }, Date.now());
      if (after === 'unclaim') h.sessions.unclaimWorker('b', worker);
      if (after === 'delete') h.db.prepare("DELETE FROM neo_todos WHERE id = 'b'").run();
      expect(h.todoOf(turn('t1'))).toBeNull();
    }
    const created = setup();
    created.start('a');
    created.sessions.create('c', { verb: 'adopt', ref: worker });
    expect(created.todoOf(turn('t1'))).toBeNull();
  });

  test("an adopted session's turns without a receipt have no todo", () => {
    const h = setup();
    h.sessions.bind('a', worker, Date.now());
    expect(h.todoOf(turn('t1', ['typed']))).toBeNull();
  });

  test('a worker started before adoptions were recorded gets no starting-todo credit', () => {
    const h = setup();
    h.start('a');
    const { at } = h.db
      .prepare("SELECT applied_at AS at FROM migration_markers WHERE key = 'migration_541'")
      .get() as { at: number };
    h.db.prepare('UPDATE work_started_sessions SET started_at = ?').run(at - 1);
    expect(h.todoOf(turn('t1'))).toBeNull();
  });

  test('a reviewer keeps its role', () => {
    const h = setup();
    h.start('a');
    h.db
      .prepare(
        "INSERT INTO neo_todo_roles (todo_id, role, adapter, id, at) VALUES ('a', 'do', ?, ?, 1), ('a', 'review', ?, ?, 2)"
      )
      .run(worker.adapter, worker.id, worker.adapter, worker.id);
    expect(h.todoOf(turn('t1'))).toEqual({ todo: 'a', role: 'review' });
  });

  test('a turn read after reopen, redispatch, retry and restart keeps its todo', async () => {
    dir = mkdtempSync(join(tmpdir(), 'turn-todo-'));
    const path = join(dir, 'daemon.db');
    const h = setup(path);
    await h.deliver('a', {
      ok: true,
      value: { delivered: true, receipt: { executionId: 'w', inputId: 'in-a' } },
    });
    h.db.prepare("DELETE FROM neo_todo_sessions WHERE todo_id = 'a'").run();
    h.store.updateTodo(h.store.getTodo('a')!, { state: 'todo', startedAt: null }, Date.now());
    await h.deliver('a', {
      ok: true,
      value: { delivered: true, receipt: { executionId: 'w', inputId: 'in-retry' } },
    });
    h.db.close();
    const reopened = open(path);
    const facts = readTurnTodoFacts(reopened, worker);
    expect(planTurnTodo(turn('t1', ['in-a']), facts)?.todo).toBe('a');
    expect(planTurnTodo(turn('t2', ['in-retry']), facts)?.todo).toBe('a');
    reopened.close();
  });
});
