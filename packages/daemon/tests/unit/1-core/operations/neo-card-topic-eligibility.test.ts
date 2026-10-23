import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime';
import type { SessionManager } from '../../../../src/lib/session/session-manager';
import { createTestDb, createTestSession } from '../../../helpers/database';

let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
beforeEach(async () => {
  db = await createTestDb();
  db.createSession(createTestSession('root'));
  service = createNeoService(
    db,
    {} as SessionManager,
    { event: () => {} } as unknown as MessageHub,
    createDaemonInternalEventBus()
  );
});
afterEach(() => {
  service.dispose();
  db.close();
});
function seed(count: number) {
  for (let i = 0; i < count; i++) {
    const ask = service.todos.openAsk({
      id: `ask-${i}`,
      sessionId: 'root',
      projectId: null,
      originMessageId: `human-${i}`,
      title: 'Synthetic',
      request: 'Synthetic',
      createdAt: 1,
    });
    const todo = service.todos.addTodo(
      `todo-${i}`,
      ask.id,
      { title: `todo-${i}`, doneWhen: 'Reported', instruction: null, check: null, named: null },
      1
    );
    service.todos.updateTodo(todo, { state: 'doing' }, 2);
    service.cardEvents.subscribe(todo.id, `synthetic/${i}/a`, 3);
    service.cardEvents.subscribe(todo.id, `synthetic/${i}/b`, 3);
  }
}
function readProbe(delayMs = 0) {
  const sql = db.getDatabase();
  const prepare = sql.prepare.bind(sql);
  let count = 0;
  const probe = spyOn(sql, 'prepare').mockImplementation((query: string) => {
    const statement = prepare(query);
    if (!/FROM (neo_todos|neo_asks|pack_coding_todo_prs)\b/i.test(query)) return statement;
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (key === 'get' || key === 'all') {
            count++;
            if (delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
  });
  return { count: () => count, restore: () => probe.mockRestore() };
}

test('a 231-todo sweep uses bounded eligibility reads and keeps topic order', () => {
  seed(231);
  const probe = readProbe();
  try {
    expect(service.endUnfollowedCardTopics(4)).toEqual([]);
    expect(probe.count()).toBeLessThanOrEqual(3);
    expect(service.cardEvents.listActive()).toHaveLength(462);
  } finally {
    probe.restore();
  }
});

test('a 180-todo sweep remains responsive with delayed native SQLite eligibility reads', async () => {
  seed(180);
  const probe = readProbe(8);
  let last = performance.now(),
    maxLag = 0;
  const timer = setInterval(() => {
    const at = performance.now();
    maxLag = Math.max(maxLag, at - last - 5);
    last = at;
  }, 5);
  try {
    await new Promise((done) => setTimeout(done, 15));
    expect(service.endUnfollowedCardTopics(4)).toEqual([]);
    await new Promise((done) => setTimeout(done, 15));
    expect(service.cardEvents.listActive()).toHaveLength(360);
    expect(maxLag).toBeLessThan(250);
  } finally {
    clearInterval(timer);
    probe.restore();
  }
});

test('follow eligibility and merged PR changes are seen on the next sweep', () => {
  seed(8);
  const sql = db.getDatabase();
  sql.exec(
    "UPDATE neo_todos SET state = 'done' WHERE id IN ('todo-1', 'todo-2', 'todo-3', 'todo-4')"
  );
  sql.exec("UPDATE neo_asks SET status = 'done' WHERE id IN ('ask-1', 'ask-2')");
  sql.exec("UPDATE neo_asks SET status = 'dropped' WHERE id = 'ask-3'");
  sql.exec("UPDATE neo_todos SET state = 'failed' WHERE id = 'todo-5'");
  sql.exec("UPDATE neo_todos SET state = 'removed' WHERE id = 'todo-6'");
  sql.exec("UPDATE neo_todos SET state = 'blocked' WHERE id = 'todo-7'");
  for (const id of ['todo-1', 'todo-3', 'todo-4']) {
    sql
      .prepare('INSERT INTO pack_coding_todo_prs (todo_id, prs_json, read_at) VALUES (?, ?, 1)')
      .run(id, JSON.stringify([{ state: 'MERGED' }]));
  }
  const topics = (ids: number[]) =>
    ids.flatMap((i) =>
      ['a', 'b'].map((s) => ({ workId: `todo-${i}`, topic: `synthetic/${i}/${s}` }))
    );
  const probe = readProbe();
  try {
    expect(service.endUnfollowedCardTopics(4)).toEqual(topics([2, 3, 5, 6]));
    expect(probe.count()).toBeLessThanOrEqual(3);
  } finally {
    probe.restore();
  }
  expect(service.cardEvents.listActive()).toEqual(topics([0, 1, 4, 7]));
  sql.exec("UPDATE neo_asks SET status = 'dropped' WHERE id = 'ask-0'");
  sql.exec("UPDATE pack_coding_todo_prs SET prs_json = '[]' WHERE todo_id = 'todo-1'");
  sql.exec("UPDATE neo_todos SET state = 'removed' WHERE id = 'todo-7'");
  expect(service.endUnfollowedCardTopics(5)).toEqual(topics([0, 1, 7]));
  expect(service.cardEvents.listActive()).toEqual(topics([4]));
});

test('an empty sweep does not read todo, ask or PR eligibility', () => {
  const probe = readProbe();
  try {
    expect(service.endUnfollowedCardTopics(4)).toEqual([]);
    expect(probe.count()).toBe(0);
  } finally {
    probe.restore();
  }
});
