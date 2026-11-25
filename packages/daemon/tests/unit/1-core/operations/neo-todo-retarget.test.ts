import { afterEach, describe, expect, test } from 'bun:test';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import type { WorkRef } from '../../../../src/lib/drivers/types.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { recordedWorkInvoke } from '../../helpers/recorded-work-invoke.ts';
import { neoTodoMoveWrites } from '../../../../src/storage/repositories/neo-todo-move-worker.ts';

const old = { adapter: 'hyperneo', id: 'old' };
const next = { adapter: 'hyperneo', id: 'next' };
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(handoff = false) {
  const db = new Database(':memory:');
  databases.push(db);
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  store.openAsk({
    id: 'ask',
    title: 'Move',
    request: 'Move',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    createdAt: 1,
  });
  const todo = store.addTodo(
    'todo',
    'ask',
    {
      title: 'Work',
      doneWhen: 'Done',
      instruction: 'Continue work',
      check: handoff ? { pack: 'coding', kind: 'pr', params: {} } : null,
      named: null,
      approvedAt: 1,
    },
    1
  );
  const target = {
    verb: 'start' as const,
    adapter: 'hyperneo',
    model: 'stored-model',
    place: { machine: 'test', name: 'repo', folder: '/synthetic' },
  };
  sessions.create(todo.id, target);
  sessions.recordRef(todo.id, old, 1);
  store.updateTodo(todo, { state: 'doing', startedAt: 1 }, 1);
  let status = 'running';
  let stopResult = { ok: true, value: { stopped: true } } as unknown;
  let beforeStop = async () => {};
  let beforeStart = async () => {};
  let liveAfterStop = false;
  let unreadable = false;
  let capacity = 6;
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const notices: string[] = [];
  const changed: { state: string | undefined; ref: WorkRef | null }[] = [];
  const boot = () =>
    createNeoTodoRunner({
      store,
      sessions,
      write: gatewayFor(db).run.bind(gatewayFor(db)),
      limits: () => ({ running: capacity, perGroup: 3 }),
      packs: () =>
        handoff
          ? [
              {
                id: 'coding',
                describe: 'Coding',
                instructions: () => null,
                workerStartBrief: (message, parameters) =>
                  `${message}\nInherited: ${JSON.stringify(parameters?.replacedWorker)}`,
              },
            ]
          : [],
      changed: () => {
        changed.push({ state: store.getTodo('todo')?.state, ref: sessions.readRef('todo') });
      },
      tell: async (_ask, _todo, text) => {
        notices.push(text);
      },
      attend: async (event) => {
        notices.push(String(event.facts.text));
      },
      invoke: recordedWorkInvoke(sessions.inputs, async (_caller, name, input) => {
        calls.push({ name, input });
        if (name === 'work.stop') {
          await beforeStop();
          if ((stopResult as { ok: boolean }).ok && !liveAfterStop) status = 'stopped';
          return { kind: 'completed', value: stopResult };
        }
        if (name === 'work.start') {
          await beforeStart();
          return {
            kind: 'completed',
            value: {
              ok: true,
              value: { ref: next, receipt: { executionId: next.id, inputId: 'new-input' } },
            },
          };
        }
        if (name === 'work.status' && unreadable) throw new Error('Synthetic status read failed');
        return {
          kind: 'completed',
          value: {
            ok: true,
            value: {
              ref: input.ref,
              title: 'Worker',
              place: target.place,
              status,
              lastActivityAt: 1,
            },
          },
        };
      }),
    });
  const pending = () =>
    db
      .prepare(
        "SELECT value_json FROM pack_facts WHERE todo_id = 'todo' AND pack = 'core' AND key = 'move'"
      )
      .get();
  const seed = (fromRef: WorkRef = old, at = 1) =>
    db
      .prepare(
        "INSERT OR REPLACE INTO pack_facts (todo_id,pack,key,value_json) VALUES ('todo','core','move',?)"
      )
      .run(JSON.stringify({ fromRef, at }));
  return {
    db,
    store,
    sessions,
    target,
    calls,
    notices,
    changed,
    boot,
    pending,
    seed,
    capacity: (value: number) => {
      capacity = value;
    },
    stop: (run: () => Promise<void>) => {
      beforeStop = run;
    },
    start: (run: () => Promise<void>) => {
      beforeStart = run;
    },
    refuse: (value: unknown) => {
      stopResult = value;
    },
    keepLive: () => {
      liveAfterStop = true;
    },
    unreadable: () => {
      unreadable = true;
    },
  };
}

describe('neo.todo.retarget', () => {
  test('passes the replaced worker to the new worker brief', async () => {
    const h = setup(true);
    await h.boot().retarget('todo', old);
    const message = String(h.calls.find((call) => call.name === 'work.start')?.input.message);
    expect(message).toContain('"adapter":"hyperneo"');
    expect(message).toContain('"id":"old"');
  });

  test('a later start after reopening is ordinary, as for deferred or retried starts', async () => {
    const h = setup(true);
    h.seed();
    expect(
      await gatewayFor(h.db).call(neoTodoMoveWrites, 'reopen', {
        todoId: 'todo',
        fromRef: old,
        at: 1,
      })
    ).toBe(true);
    await h.boot().start('todo');
    const message = String(h.calls.find((call) => call.name === 'work.start')?.input.message);
    expect(message).toContain('Inherited: undefined');
  });

  test('an unknown todo is refused', async () => {
    const h = setup();
    expect(await h.boot().retarget('missing', old)).toMatchObject({
      ok: false,
      reason: 'not_found: no such todo.',
    });
  });
  test('a todo deleted during stop is omitted from the typed result', async () => {
    const h = setup();
    h.stop(async () => {
      h.db.prepare("DELETE FROM neo_todos WHERE id = 'todo'").run();
    });
    const result = await h.boot().retarget('todo', old);
    expect(result.ok).toBe(true);
    expect('todo' in result ? result.todo : undefined).toBeUndefined();
    expect(h.calls.filter((call) => call.name === 'work.start')).toHaveLength(0);
  });
  test('claims before stopping, reopens at the stored target and ignores an old fromRef', async () => {
    const h = setup();
    h.stop(async () => {
      expect(h.pending()).not.toBeNull();
    });
    const runner = h.boot();
    expect((await runner.retarget('todo', old)).ok).toBe(true);
    expect(h.sessions.readRef('todo')).toEqual(next);
    expect(h.sessions.get('todo')).toEqual(h.target);
    expect(h.pending()).toBeNull();
    await runner.retarget('todo', old);
    expect(h.calls.filter((call) => call.name === 'work.start')).toHaveLength(1);
  });

  test('reopening publishes the cleared worker before a capacity-held restart', async () => {
    const h = setup();
    h.seed();
    h.capacity(0);
    const visible: { state: string | undefined; ref: WorkRef | null }[] = [];
    const tables: string[] = [];
    gatewayFor(h.db).onChanges = (events) => {
      tables.push(...events.map((event) => event.table));
      if (events.some((event) => event.table === 'neo_todos'))
        visible.push({ state: h.store.getTodo('todo')?.state, ref: h.sessions.readRef('todo') });
    };
    expect(
      await gatewayFor(h.db).call(neoTodoMoveWrites, 'reopen', {
        todoId: 'todo',
        fromRef: old,
        at: 1,
      })
    ).toBe(true);
    expect(visible).toEqual([{ state: 'todo', ref: null }]);
    expect(tables).toContain('neo_todo_sessions');
    await h.boot().fill();
    expect(h.store.getTodo('todo')?.state).toBe('todo');
    expect(h.calls.filter((call) => call.name === 'work.start')).toHaveLength(0);
  });

  test.each(['request', 'recovery'])(
    'the %s announces reopen when the normal start is refused without a write',
    async (mode) => {
      const h = setup();
      h.capacity(0);
      const prerequisite = h.store.addTodo(
        'prerequisite',
        'ask',
        {
          title: 'Prerequisite',
          doneWhen: 'Done',
          instruction: null,
          check: null,
          named: null,
        },
        1
      );
      h.store.updateTodo(h.store.getTodo('todo')!, { dependsOn: [prerequisite.id] }, 2);
      const runner = h.boot();
      if (mode === 'recovery') {
        h.seed();
        await runner.recoverMoves();
      } else await runner.retarget('todo', old);
      expect(h.store.getTodo('todo')?.state).toBe('todo');
      expect(h.sessions.readRef('todo')).toBeNull();
      expect(h.calls.filter((call) => call.name === 'work.start')).toHaveLength(0);
      expect(h.changed).toEqual([{ state: 'todo', ref: null }]);
    }
  );

  test.each([
    'unsupported',
    'still_live',
    'unreadable',
    'adopted',
    'send',
    'shared',
    'reserved_send',
    'outstanding',
  ])('%s refuses without changing the todo or starting a worker', async (mode) => {
    const h = setup();
    if (mode === 'unsupported') h.refuse({ ok: false, reason: 'unsupported' });
    if (mode === 'still_live') h.keepLive();
    if (mode === 'unreadable') h.unreadable();
    if (mode === 'adopted' || mode === 'send')
      h.db
        .prepare('UPDATE neo_todo_sessions SET target = ? WHERE todo_id = ?')
        .run(JSON.stringify({ verb: mode === 'adopted' ? 'adopt' : 'send', ref: old }), 'todo');
    if (mode === 'shared') {
      const sibling = h.store.addTodo(
        'sibling',
        'ask',
        { title: 'Other', doneWhen: 'Done', instruction: 'Other', check: null, named: null },
        1
      );
      h.sessions.bind(sibling.id, old, 1);
    }
    if (mode === 'reserved_send') {
      h.store.addTodo(
        'reserved',
        'ask',
        { title: 'Reserved', doneWhen: 'Done', instruction: 'Other', check: null, named: null },
        1
      );
      h.sessions.create('reserved', { verb: 'send', ref: old });
    }
    if (mode === 'outstanding')
      await h.sessions.inputs.accept(
        null,
        'neo',
        { verb: 'send', ref: old },
        'Pending',
        Date.now()
      );
    expect((await h.boot().retarget('todo', old)).ok).toBe(false);
    expect(h.store.getTodo('todo')?.state).toBe('doing');
    expect(h.sessions.readRef('todo')).toEqual(old);
    expect(h.pending()).toBeNull();
    expect(h.calls.filter((call) => call.name === 'work.start')).toHaveLength(0);
    if (mode === 'adopted' || mode === 'send')
      expect(h.calls.filter((call) => call.name === 'work.stop')).toHaveLength(0);
    if (mode === 'unsupported' || mode === 'still_live') expect(h.notices).toHaveLength(1);
  });

  test('two calls past their claims stop only the old ref and start once', async () => {
    const h = setup();
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let n = 0;
    h.stop(async () => {
      if (++n === 1) {
        entered();
        await held;
      }
    });
    const runner = h.boot();
    const first = runner.retarget('todo', old);
    await waiting;
    await runner.retarget('todo', old);
    release();
    await first;
    expect(h.sessions.readRef('todo')).toEqual(next);
    expect(h.calls.filter((call) => call.name === 'work.start')).toHaveLength(1);
    expect(
      h.calls
        .filter((call) => call.name === 'work.stop')
        .every((call) => JSON.stringify(call.input.ref) === JSON.stringify(old))
    ).toBe(true);
  });

  test.each(['done', 'removed'] as const)('a %s sibling does not prevent a move', async (state) => {
    const h = setup();
    const sibling = h.store.addTodo(
      'sibling',
      'ask',
      {
        title: 'Previous',
        doneWhen: 'Done',
        instruction: 'Previous work',
        check: null,
        named: null,
      },
      1
    );
    h.sessions.bind(sibling.id, old, 1);
    h.store.updateTodo(sibling, { state, finishedAt: 2 }, 2);
    expect((await h.boot().retarget('todo', old)).ok).toBe(true);
    expect(h.sessions.readRef('todo')).toEqual(next);
    expect(h.calls.filter((call) => call.name === 'work.start')).toHaveLength(1);
  });

  test.each(['claim', 'stop', 'reopen'])(
    'the real recovery pass completes after a crash at %s, at any age',
    async (phase) => {
      const h = setup();
      h.seed(old, Date.now() - 2 * 60 * 60_000);
      if (phase === 'stop') expect(await h.boot().stop(h.store.getTodo('todo')!)).toBeNull();
      if (phase === 'reopen') {
        h.db.prepare("DELETE FROM pack_facts WHERE key = 'move'").run();
        h.db
          .prepare("UPDATE neo_todos SET state = 'todo', started_at = NULL WHERE id = 'todo'")
          .run();
        h.db.prepare("UPDATE neo_todo_sessions SET ref = NULL WHERE todo_id = 'todo'").run();
      }
      await h.boot().recoverMoves();
      expect(h.sessions.readRef('todo')).toEqual(next);
      expect(h.pending()).toBeNull();
      expect(h.calls.filter((call) => call.name === 'work.start')).toHaveLength(1);
    }
  );

  test('the replacement gets the latest report without rewriting the instruction', async () => {
    const h = setup();
    h.store.updateTodo(h.store.getTodo('todo')!, { report: 'Continue from the saved branch' }, 2);
    await h.boot().retarget('todo', old);
    expect(h.calls.find((call) => call.name === 'work.start')?.input.message).toContain(
      'Latest worker report:\nContinue from the saved branch'
    );
    expect(h.store.getTodo('todo')?.instruction).toBe('Continue work');
  });

  test.each(['done', 'removed'] as const)(
    'a todo that becomes %s during stop is not restarted',
    async (state) => {
      const h = setup();
      h.stop(async () => {
        h.store.updateTodo(h.store.getTodo('todo')!, { state }, 2);
      });
      await h.boot().retarget('todo', old);
      expect(h.store.getTodo('todo')?.state).toBe(state);
      expect(h.pending()).toBeNull();
      expect(h.calls.filter((call) => call.name === 'work.start')).toHaveLength(0);
    }
  );

  test('stale facts are cleaned without moving the current worker or touching stall state', async () => {
    const h = setup();
    h.seed({ adapter: 'hyperneo', id: 'past' });
    h.sessions.recordNudge('todo', { since: 1, nudges: 0, redispatched: true });
    await h.boot().recoverMoves();
    expect(h.pending()).toBeNull();
    expect(h.sessions.readRef('todo')).toEqual(old);
    expect(h.calls.filter((call) => call.name === 'work.stop')).toHaveLength(0);
    await h.boot().retarget('todo', old);
    expect(h.sessions.readRef('todo')).toEqual(next);
    expect(h.sessions.readNudge('todo')?.redispatched).toBe(true);
  });

  test('a second move and recovery cannot duplicate an outstanding replacement start', async () => {
    const h = setup();
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.start(async () => {
      entered();
      await held;
    });
    const runner = h.boot();
    const first = runner.retarget('todo', old);
    await waiting;
    await runner.retarget('todo', old);
    await runner.recoverMoves();
    release();
    await first;
    expect(h.calls.filter((call) => call.name === 'work.start')).toHaveLength(1);
  });

  test('a delayed move off A cannot erase the newer move off B', async () => {
    const h = setup();
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.stop(async () => {
      entered();
      await held;
    });
    const runner = h.boot();
    const first = runner.retarget('todo', old);
    await waiting;
    h.sessions.recordRef('todo', next, 2);
    h.seed(next, 2);
    release();
    await first;
    expect(h.pending()).toMatchObject({ value_json: JSON.stringify({ fromRef: next, at: 2 }) });
    h.stop(async () => {});
    await runner.recoverMoves();
    expect(h.pending()).toBeNull();
    expect(h.calls.filter((call) => call.name === 'work.start')).toHaveLength(1);
  });

  test.each(['release', 'active', 'reopen'] as const)(
    'old-pair %s never erases a newer fact',
    async (method) => {
      const h = setup();
      h.seed(old, 2);
      await gatewayFor(h.db).call(neoTodoMoveWrites, method, {
        todoId: 'todo',
        fromRef: old,
        at: 1,
      });
      expect(h.pending()).toMatchObject({ value_json: JSON.stringify({ fromRef: old, at: 2 }) });
      expect(h.sessions.readRef('todo')).toEqual(old);
    }
  );

  test.each(['done', 'removed'] as const)(
    'recovery cleans a move whose todo is already %s',
    async (state) => {
      const h = setup();
      h.seed();
      h.store.updateTodo(h.store.getTodo('todo')!, { state }, 2);
      await h.boot().recoverMoves();
      expect(h.pending()).toBeNull();
      expect(
        h.calls.filter((call) => call.name === 'work.stop' || call.name === 'work.start')
      ).toHaveLength(0);
    }
  );

  test('an unusable stall worker resumed without a move fact is not moved by recovery', async () => {
    const h = setup();
    h.db
      .prepare(
        "INSERT INTO work_started_sessions (adapter,id,started_at,unusable_at) VALUES ('hyperneo','old',1,2)"
      )
      .run();
    h.sessions.recordNudge('todo', { since: 1, nudges: 0, redispatched: true });
    await h.boot().recoverMoves();
    expect(h.sessions.readRef('todo')).toEqual(old);
    expect(
      h.calls.filter((call) => call.name === 'work.start' || call.name === 'work.stop')
    ).toHaveLength(0);
  });

  test('a move preserves the refusal of a second automatic stall redispatch', async () => {
    const h = setup();
    h.sessions.recordNudge('todo', { since: 1, nudges: 0, redispatched: true });
    const runner = h.boot();
    expect((await runner.retarget('todo', old)).ok).toBe(true);
    h.store.updateTodo(h.store.getTodo('todo')!, { startedAt: 1 }, Date.now());
    h.sessions.recordNudge('todo', {
      since: 1,
      nudges: 2,
      redispatched: true,
    });
    await runner.refresh(() => {});
    expect(h.sessions.readNudge('todo')?.redispatched).toBe(true);
    expect(h.calls.filter((call) => call.name === 'work.start')).toHaveLength(1);
    expect(h.calls.filter((call) => call.name === 'work.stop')).toHaveLength(1);
    expect(h.sessions.readRef('todo')).toEqual(next);
    expect(h.store.getTodo('todo')).toMatchObject({ state: 'blocked', blockedBy: 'stalled' });
  });
});
