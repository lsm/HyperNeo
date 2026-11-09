import { planNeoTrackerStarts } from '../../../../src/lib/neo/tracker-start-gate.ts';
import { sweepNeoTrackerMirrors } from '../../../../src/lib/neo/tracker-mirror.ts';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { NeoTrackerMirrorRepository } from '../../../../src/storage/repositories/neo-tracker-mirror.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import type { NeoTrackerAdapter } from '../../../../src/lib/neo/pack-contract.ts';

let db: Database, store: NeoAskTodoRepository, sessions: NeoTodoSessionRepository;
let mirrors: NeoTrackerMirrorRepository, gateway: DbGateway;
let enabled: boolean, sends: string[], notes: string[];
let runner: ReturnType<typeof createNeoTodoRunner>;
let tracker: NeoTrackerAdapter;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  store = new NeoAskTodoRepository(db);
  sessions = new NeoTodoSessionRepository(db);
  mirrors = new NeoTrackerMirrorRepository(db);
  gateway = new DbGateway(':memory:', db);
  enabled = true;
  sends = [];
  notes = [];
  tracker = {
    id: 'synthetic',
    enabled: () => enabled,
    home: () => 'example/repo',
    find: async () => null,
    create: async () => ({ ref: 'example/repo#1' }),
    link: async () => true,
    close: async () => true,
  };
  runner = createNeoTodoRunner({
    store,
    sessions,
    write: (op, args) => gateway.run(op, args),
    packs: () => [
      { id: 'synthetic', describe: 'Synthetic tracker', instructions: () => null, tracker },
    ],
    limits: () => ({ running: 9, perGroup: 9 }),
    changed: () => {},
    tell: async (_ask, _todo, note) => {
      notes.push(note);
    },
    invoke: async (_caller, name) => {
      if (name === 'work.send' || name === 'work.start') sends.push(name);
      return {
        kind: 'completed',
        value: {
          ok: true,
          value: { status: 'done', delivered: true, ref: { adapter: 'hyperneo', id: 'worker' } },
        },
      };
    },
  });
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'synthetic',
    originMessageId: null,
    title: 'Plan',
    request: 'Work',
    createdAt: 1,
  });
  store.addTodo(
    'todo',
    'ask',
    {
      title: 'Step',
      instruction: 'Work',
      named: null,
      check: null,
      doneWhen: 'Done',
      approvedAt: 1,
      dependsOn: [],
    },
    2
  );
  sessions.create('todo', { verb: 'send', ref: { adapter: 'hyperneo', id: 'worker' } });
});
afterEach(async () => {
  await gateway.close();
  db.close();
});
const row = (failures: number, ref: string | null = null) =>
  mirrors.put({
    ownerKind: 'todo',
    ownerId: 'todo',
    tracker: 'synthetic',
    home: 'example/repo',
    ref,
    parentRef: null,
    state: ref ? 'bound' : 'creating',
    failures,
    updatedAt: 3,
  });

test.each(['start', 'send'])('an unbound mirror holds every start path (%s)', async (verb) => {
  db.prepare('UPDATE neo_todo_sessions SET target=? WHERE todo_id=?').run(
    JSON.stringify(
      verb === 'start'
        ? { verb, adapter: 'hyperneo' }
        : { verb, ref: { adapter: 'hyperneo', id: 'worker' } }
    ),
    'todo'
  );
  await runner.fill();
  expect(sends).toEqual([]);
  expect(store.getTodo('todo')?.state).toBe('todo');
  expect(await runner.start('todo')).toMatchObject({
    ok: false,
    reason: expect.stringContaining('tracker_pending:'),
  });
  expect(sends).toEqual([]);
  row(0, 'example/repo#1');
  await runner.fill();
  expect(sends).toEqual([`work.${verb}`]);
});

test('three failures release the hold and say so', async () => {
  row(2);
  expect(await runner.start('todo')).toMatchObject({
    ok: false,
    reason: expect.stringContaining('tracker_pending:'),
  });
  row(3);
  await runner.fill();
  expect(sends).toEqual(['work.send']);
  expect(notes.some((note) => note.includes('Tracker item is missing'))).toBe(true);
});

test('no tracker never holds', async () => {
  enabled = false;
  await runner.fill();
  expect(sends).toEqual(['work.send']);
  expect(notes).toEqual([]);
});

test('an unbound mirror does not hide an unworked todo', () => {
  store.updateTodo(store.getTodo('todo')!, { instruction: null }, 4);
  db.prepare('DELETE FROM neo_todo_sessions WHERE todo_id=?').run('todo');
  expect(sessions.queueFacts({ todo: 'tracker_pending: waiting' }).unworked).toEqual(['todo']);
});

test('an enabled adapter without a home reaches the same retry cap', async () => {
  tracker.home = () => null;
  let calls = 0;
  tracker.find = async () => {
    calls++;
    return null;
  };
  tracker.create = async () => {
    calls++;
    return { ref: 'unexpected' };
  };
  await runner.fill();
  expect(sends).toEqual([]);
  for (let failures = 1; failures <= 3; failures++) {
    await sweepNeoTrackerMirrors(db, [tracker]);
    expect(mirrors.facts().mirrors.find((row) => row.ownerId === 'todo')).toMatchObject({
      failures,
      home: '',
      state: 'creating',
    });
    if (failures < 3) {
      await runner.fill();
      expect(sends).toEqual([]);
    }
  }
  await runner.fill();
  expect(sends).toEqual(['work.send']);
  expect(notes.some((note) => note.includes('Tracker item is missing'))).toBe(true);
  await sweepNeoTrackerMirrors(db, [tracker]);
  expect(mirrors.facts().mirrors.find((row) => row.ownerId === 'todo')?.failures).toBe(3);
  expect(calls).toBe(0);
});

test('a home resolved before the cap binds and persists for recovery', async () => {
  tracker.home = () => null;
  await sweepNeoTrackerMirrors(db, [tracker]);
  expect(mirrors.facts().mirrors.find((row) => row.ownerId === 'todo')?.failures).toBe(1);
  tracker.home = () => 'example/repo';
  await sweepNeoTrackerMirrors(db, [tracker]);
  expect(mirrors.facts().mirrors.find((row) => row.ownerId === 'todo')).toMatchObject({
    home: 'example/repo',
    ref: 'example/repo#1',
    state: 'bound',
    failures: 0,
  });
  await runner.fill();
  expect(sends).toEqual(['work.send']);
});

test('the start planner uses recorded enablement without adapter callbacks', () => {
  const plan = planNeoTrackerStarts(mirrors.facts(), [{ todoId: 'todo', tracker: 'synthetic' }]);
  expect(plan.holds.todo).toContain('tracker_pending:');
  expect(plan.missing).toEqual([]);
});

test.each(['removed', 'done', 'closed_unverified', 'dropped'] as const)(
  'a blank-home placeholder is retired without tracker calls when its owner is %s',
  async (state) => {
    tracker.home = () => null;
    await sweepNeoTrackerMirrors(db, [tracker]);
    if (state === 'dropped')
      db.prepare("UPDATE neo_asks SET status='dropped' WHERE id='ask'").run();
    else store.updateTodo(store.getTodo('todo')!, { state }, 5);
    tracker.home = () => 'example/repo';
    let calls = 0;
    tracker.find = async (marker) => {
      if (marker.endsWith(':todo')) calls++;
      return null;
    };
    tracker.create = async (item) => {
      if (item.marker.endsWith(':todo')) calls++;
      return { ref: 'example/repo#1' };
    };
    await sweepNeoTrackerMirrors(db, [tracker]);
    expect(
      db
        .prepare(
          "SELECT state, ref FROM neo_tracker_mirrors WHERE owner_kind='todo' AND owner_id='todo'"
        )
        .get()
    ).toMatchObject({ state: 'closed', ref: null });
    expect(calls).toBe(0);
    db.prepare("UPDATE neo_todos SET state='todo' WHERE id='todo'").run();
    db.prepare("UPDATE neo_asks SET status='open' WHERE id='ask'").run();
    expect(
      planNeoTrackerStarts(mirrors.facts(), [{ todoId: 'todo', tracker: 'synthetic' }]).holds.todo
    ).toBeNull();
  }
);

test('a final owner with a recorded home still recovers an uncertain create', async () => {
  row(1);
  store.updateTodo(store.getTodo('todo')!, { state: 'removed' }, 5);
  const found: string[] = [];
  tracker.find = async (marker) => {
    found.push(marker);
    return marker.endsWith(':todo') ? 'example/repo#2' : null;
  };
  await sweepNeoTrackerMirrors(db, [tracker]);
  expect(found).toContain('hyperneo:todo:todo');
  expect(mirrors.facts().mirrors.find((row) => row.ownerId === 'todo')).toMatchObject({
    ref: 'example/repo#2',
    state: 'bound',
  });
});
