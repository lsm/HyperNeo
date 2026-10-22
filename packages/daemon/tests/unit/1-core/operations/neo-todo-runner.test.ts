import { planNudge } from '../../../../src/lib/neo/nudge.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoPack, NeoTodoCheckResult } from '../../../../src/lib/neo/pack-contract.ts';
import {
  createNeoTodoRunner,
  neoAskIdleNote,
  neoTodoNote,
  planNeoTodoCheck,
  planNeoTodoSettled,
  requireNeoTodoStartable,
} from '../../../../src/lib/neo/todo-runner.ts';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const ref = { adapter: 'hyperneo', id: 'worker-1' };
const receipt = { executionId: ref.id, inputId: 'input-1' };
const observed = (text: string, at: number) => ({
  receipt,
  state: 'observed',
  exchange: [{ at, role: 'agent', text }],
  exchangeCut: false,
});
const completed = (value: unknown): OperationOutcome =>
  ({ kind: 'completed', value }) as OperationOutcome;

function setup(
  packDone: boolean | null = null,
  dbPath = ':memory:',
  beforeInvoke?: (name: string) => void
) {
  const db = new Database(dbPath);
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: 'm1',
    title: 'iOS card',
    request: 'Redo the iOS card',
    createdAt: 1,
  });
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const told: string[] = [];
  const toldKeys: (string | undefined)[] = [];
  let prOpen = false;
  const askNotes: string[] = [];
  const checkedTodos: string[] = [];
  let status: unknown = null;
  let sendResult: unknown;
  let result: NeoTodoCheckResult | null | undefined;
  const pack = {
    id: 'coding',
    describe: 'coding',
    instructions: () => null,
    workerRules: 'Rules for this work: prove it by running it.',
    todos: {
      schema: () => {},
      check: async (todo: NeoTodo) => {
        checkedTodos.push(todo.id);
        if (result !== undefined) return result;
        return packDone === null ? null : { done: packDone, evidence: '#1 已合并' };
      },
      statusLine: () => null,
      topics: () => [],
      event: () => [],
      waiting: () => prOpen,
    },
  } satisfies NeoPack;
  const runner = createNeoTodoRunner({
    store,
    sessions,
    invoke: async (_caller, name, input) => {
      beforeInvoke?.(name);
      calls.push({ name, input });
      if (name === 'work.start')
        return completed({
          ok: true,
          value: { ref, receipt, lastActivityAt: 1_000, link: '/session/w' },
        });
      if (name === 'work.send')
        return completed(sendResult ?? { ok: true, value: { delivered: true, receipt } });
      return completed(status);
    },
    packs: () => [pack],
    tell: async (_ask, _todo, note, key) => {
      told.push(note);
      toldKeys.push(key);
    },
    tellAsk: async (_ask, messageId) => {
      askNotes.push(messageId);
    },
    changed: () => {},
  });
  const add = (check: NeoTodo['check'] = null, instruction: string | null = 'Build the rows.') => {
    const todo = store.addTodo(
      crypto.randomUUID(),
      'ask',
      { title: 'Rows', doneWhen: 'PR merged', check, instruction, named: null },
      1
    );
    sessions.create(todo.id, {
      verb: 'start',
      adapter: 'hyperneo',
      place: { machine: 'laptop', name: 'repo', folder: '/repo' },
    });
    return todo;
  };
  return {
    db,
    store,
    sessions,
    runner,
    calls,
    told,
    toldKeys,
    askNotes,
    checkedTodos,
    add,
    setStatus: (value: unknown) => {
      status = value;
    },
    setPrOpen: (value: boolean) => {
      prOpen = value;
    },
    setSend: (value: unknown) => {
      sendResult = value;
    },
    setResult: (value: NeoTodoCheckResult | null) => {
      result = value;
    },
  };
}

describe('neoAskIdleNote', () => {
  test('names an open ask that nothing moves, and stays quiet while a todo runs or a question waits', () => {
    const { store, add } = setup();
    const ask = store.getAsk('ask')!;
    const todo = add();
    expect(neoAskIdleNote(ask, store.listTodos('ask'), [])).toBe(
      'Ask "iOS card" is open, but no todo is running and no question is open. Todos: "Rows" todo.'
    );
    const doing = store.updateTodo(todo, { state: 'doing' }, 2);
    expect(neoAskIdleNote(ask, [doing], [])).toBeNull();
    const question = store.askQuestion(
      'q',
      'ask',
      {
        text: 'Which?',
        kind: 'reply',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: null,
      },
      3
    );
    expect(neoAskIdleNote(ask, [todo], [question])).toBeNull();
  });
});

describe('idle open asks', () => {
  test('refresh keys the idle note by ask state, so delivery tells it once', async () => {
    const { store, runner, add, askNotes } = setup();
    add();
    await runner.refresh(() => {});
    await runner.refresh(() => {});
    const updatedAt = store.getAsk('ask')!.updatedAt;
    expect(askNotes).toEqual([`neo-ask-idle:ask:${updatedAt}`, `neo-ask-idle:ask:${updatedAt}`]);
  });
});

describe('neo todo runner', () => {
  test('refuses the external effect if accepting its durable input fails', async () => {
    const h = setup();
    try {
      const todo = h.add();
      h.db.exec(
        "CREATE TRIGGER reject_input BEFORE INSERT ON work_delivery_inputs BEGIN SELECT RAISE(ABORT, 'synthetic storage refusal'); END"
      );
      await expect(h.runner.start(todo.id)).rejects.toThrow('synthetic storage refusal');
      expect(
        h.calls.filter((call) => call.name === 'work.start' || call.name === 'work.send')
      ).toEqual([]);
      expect(h.sessions.inputs.list(todo.id)).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('a dispatch exception retains an unresolved input with its original deadline', async () => {
    const h = setup(null, ':memory:', (name) => {
      if (name === 'work.start') throw new Error('synthetic lost reply');
    });
    try {
      const todo = h.add();
      await expect(h.runner.start(todo.id)).rejects.toThrow('synthetic lost reply');
      const inputs = h.sessions.inputs.list(todo.id);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({
        todoId: todo.id,
        originSessionId: 'neo',
        outcome: null,
        observedAt: null,
      });
      expect(h.sessions.inputs.due(inputs[0].deadlineAt - 1)).toEqual([]);
      expect(h.sessions.inputs.due(inputs[0].deadlineAt)).toEqual(inputs);
      expect(h.sessions.inputs.due(inputs[0].deadlineAt + 100000)).toEqual(inputs);
    } finally {
      h.db.close();
    }
  });

  test('every dispatched input has a durable intent before the tool sees it', async () => {
    const seen: unknown[] = [];
    const h = setup(null, ':memory:', (name) => {
      if (name !== 'work.start' && name !== 'work.send') return;
      const exists = h.db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'work_delivery_inputs'")
        .get();
      seen.push(
        exists ? h.db.prepare('SELECT * FROM work_delivery_inputs ORDER BY rowid').all() : []
      );
    });
    try {
      const todo = h.add();
      await h.runner.start(todo.id);
      h.setStatus({
        ok: true,
        value: { ref, status: 'done', lastActivityAt: 1000, recentInputs: [] },
      });
      h.setSend({ ok: true, value: { delivered: false, queuedSubmissionId: 'queue-next' } });
      await h.runner.proceed(todo.id, 'A separate next instruction');
      expect(seen).toMatchObject([
        [{ todo_id: todo.id, origin_session_id: 'neo', outcome: null }],
        [{ todo_id: todo.id }, { todo_id: todo.id, origin_session_id: 'neo', outcome: null }],
      ]);
      const inputs = h.db.prepare('SELECT * FROM work_delivery_inputs ORDER BY rowid').all() as {
        id: string;
        message: string;
        accepted_at: number;
        deadline_at: number;
        outcome: string;
      }[];
      expect(new Set(inputs.map((row) => row.id)).size).toBe(2);
      expect(inputs[0].message).toContain('Build the rows.');
      expect(inputs[1].message).toContain('A separate next instruction');
      for (const row of inputs) expect(row.deadline_at - row.accepted_at).toBe(30000);
      expect(JSON.parse(inputs[1].outcome)).toMatchObject({
        ref,
        delivery: { delivered: false, queuedSubmissionId: 'queue-next' },
      });
      h.store.updateTodo(h.store.getTodo(todo.id)!, { state: 'failed' }, Date.now());
      expect(h.db.prepare('SELECT count(*) AS n FROM work_delivery_inputs').get()).toEqual({
        n: 2,
      });
    } finally {
      h.db.close();
    }
  });

  test('accepted inbox input retains its baseline anchor without claiming consumption after reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'todo-dispatch-'));
    const dbPath = join(dir, 'synthetic.db');
    const delivery = {
      delivered: false,
      unconfirmed: true,
      receipt: { executionId: 'worker-1', inputId: 'input-1' },
    };
    let id = '';
    try {
      const h = setup(null, dbPath);
      try {
        const todo = h.add();
        id = todo.id;
        h.db
          .prepare('UPDATE neo_todo_sessions SET target = ? WHERE todo_id = ?')
          .run(JSON.stringify({ verb: 'send', ref }), id);
        h.setStatus({
          ok: true,
          value: { ref, status: 'done', lastActivityAt: 1000, recentInputs: [] },
        });
        h.setSend({ ok: true, value: delivery });
        await h.runner.start(id);
      } finally {
        h.db.close();
      }
      const db = new Database(dbPath);
      try {
        const sessions = new NeoTodoSessionRepository(db);
        expect(sessions.readSent(id)).toMatchObject({ delivery, receipt: delivery.receipt });
        expect(sessions.readStartedAt(id)).toBe(1000);
        db.prepare('UPDATE neo_todo_sessions SET sent_receipt = ? WHERE todo_id = ?').run(
          JSON.stringify({ ref: JSON.stringify(ref), receipt: delivery.receipt }),
          id
        );
        expect(sessions.readSent(id)).toMatchObject({ receipt: delivery.receipt });
        expect(sessions.readSent(id)).not.toHaveProperty('delivery');
        db.prepare('UPDATE neo_todo_sessions SET sent_receipt = ? WHERE todo_id = ?').run(
          JSON.stringify({
            ref: JSON.stringify(ref),
            receipt: delivery.receipt,
            delivery: { delivered: 'not a boolean' },
          }),
          id
        );
        expect(sessions.readSent(id)).toMatchObject({ receipt: delivery.receipt });
        expect(sessions.readSent(id)).not.toHaveProperty('delivery');
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    { delivered: false, queuedSubmissionId: 'queue-1' },
    {
      delivered: false,
      unconfirmed: true,
      receipt: { executionId: 'worker-1', inputId: 'input-1' },
    },
    { delivered: true, steeredIntoTurnId: 'turn-1' },
  ])('retains the latest dispatch facts through start and continue: %j', async (delivery) => {
    const h = setup();
    try {
      const todo = h.add();
      h.db
        .prepare('UPDATE neo_todo_sessions SET target = ? WHERE todo_id = ?')
        .run(JSON.stringify({ verb: 'send', ref }), todo.id);
      h.setStatus({
        ok: true,
        value: { ref, status: 'done', lastActivityAt: 1000, recentInputs: [] },
      });
      h.setSend({ ok: true, value: delivery });
      await h.runner.start(todo.id);
      expect(new NeoTodoSessionRepository(h.db).readSent(todo.id)).toMatchObject({ delivery });
      expect(h.sessions.readStartedAt(todo.id)).toBe(
        'queuedSubmissionId' in delivery ? null : 1000
      );
      const next = { delivered: false, queuedSubmissionId: 'queue-2' };
      h.setSend({ ok: true, value: next });
      await h.runner.proceed(todo.id, 'Next synthetic instruction');
      expect(h.sessions.readStartedAt(todo.id)).toBeNull();
      expect(new NeoTodoSessionRepository(h.db).readSent(todo.id)).toMatchObject({
        delivery: next,
      });
      h.sessions.recordRef(todo.id, { adapter: 'hyperneo', id: 'different-worker' });
      expect(h.sessions.readSent(todo.id)).not.toHaveProperty('delivery');
    } finally {
      h.db.close();
    }
  });

  test('follows a stopped todo session for a later PR report without writing legacy work', async () => {
    const { db, store, sessions, runner, add, setStatus, calls, told } = setup();
    const todo = add({ pack: 'coding', kind: 'pr_merged', params: {} });
    await runner.start(todo.id);
    store.updateTodo(
      store.getTodo(todo.id)!,
      { state: 'blocked', blockedBy: 'worker', report: 'Initial report' },
      2000
    );
    sessions.recordFollowAnchor(todo.id, 2000);
    setStatus({
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: 4000,
        inputEvidence: observed('Later PR https://github.com/a/b/pull/9', 3000),
        exchange: [
          { at: 1000, role: 'user', text: String(calls[0].input.message) },
          { at: 3000, role: 'agent', text: 'Later PR https://github.com/a/b/pull/9' },
        ],
      },
    });
    await runner.refresh(() => {});
    const report = store.getTodo(todo.id)?.report;
    expect(report).toContain('https://github.com/a/b/pull/9');
    expect(report).toContain('Initial report');
    expect(store.getTodo(todo.id)?.state).toBe('doing');
    expect(sessions.readFollowAnchor(todo.id)).toBe(4000);
    runner.recheck([todo.id]);
    await runner.refresh(() => {});
    expect(store.getTodo(todo.id)).toMatchObject({
      state: 'doing',
      report: expect.stringContaining('https://github.com/a/b/pull/9'),
    });
    expect(told).toEqual([]);
    db.close();
  });
  test.each(['', '  Final worker message 🔬\n'.repeat(400)])(
    'relays a terminal message verbatim as a report without changing the todo result: %s',
    async (message) => {
      const h = setup(false);
      try {
        const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
        await h.runner.start(todo.id);
        const dispatch = h.sessions.inputs.list(todo.id)[0];
        const prior = 'Keep the stored result';
        h.store.updateTodo(h.store.getTodo(todo.id)!, { report: prior }, Date.now());
        h.setStatus({
          ok: true,
          value: {
            status: 'done',
            lastActivityAt: dispatch.acceptedAt + 100,
            lastReply: 'Unverified prose says complete',
            turnEnds: [{ id: 'turn-1', at: dispatch.acceptedAt + 100, message }],
          },
        });
        await h.runner.refresh(() => {});
        expect(h.told).toContain(
          `Worker turn report (todo ${todo.id}, dispatch ${dispatch.id}):\n\n${message || 'worker ended its turn with no reply'}`
        );
        expect(h.toldKeys).toContain(`neo-todo-turn:${todo.id}:${dispatch.id}:turn-1`);
        expect(h.store.getTodo(todo.id)).toMatchObject({ state: 'doing', report: prior });
      } finally {
        h.db.close();
      }
    }
  );

  test('does not relay a turn that predates this dispatch or belongs to the replaced worker', async () => {
    const h = setup(false);
    try {
      const todo = h.add({ pack: 'coding', kind: 'pr_merged', params: {} });
      await h.runner.start(todo.id);
      const dispatch = h.sessions.inputs.list(todo.id)[0];
      h.setStatus({
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: dispatch.acceptedAt - 1,
          turnEnds: [{ id: 'old', at: dispatch.acceptedAt - 1, message: 'Old worker turn' }],
        },
      });
      await h.runner.refresh(() => {});
      expect(h.told).toEqual([]);
      h.sessions.recordRef(todo.id, { ...ref, id: 'replacement' });
      h.setStatus({
        ok: true,
        value: {
          status: 'done',
          lastActivityAt: dispatch.acceptedAt + 1,
          turnEnds: [
            { id: 'wrong-worker', at: dispatch.acceptedAt + 1, message: 'Wrong worker turn' },
          ],
        },
      });
      await h.runner.refresh(() => {});
      expect(h.told).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('starts a todo in its session, settles its report and lets the pack tick it done', async () => {
    const { store, sessions, runner, calls, told, add, setStatus } = setup(true);
    const todo = add({ pack: 'coding', kind: 'pr_merged', params: {} });
    const started = await runner.start(todo.id);
    expect(started.ok && started.todo).toMatchObject({
      state: 'doing',
      startedAt: expect.any(Number),
    });
    expect(calls[0]).toMatchObject({
      name: 'work.start',
      input: { adapter: 'hyperneo', title: 'Rows' },
    });
    expect(String(calls[0].input.message)).toContain('Build the rows.');
    expect(sessions.readRef(todo.id)).toEqual(ref);
    expect(await runner.start(todo.id)).toEqual({
      ok: false,
      reason: 'already_started: this todo is doing.',
    });

    setStatus({
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: 2_000,
        lastReply: 'Opened the PR',
        inputEvidence: observed('Opened https://github.com/a/b/pull/1', 2000),
        exchange: [
          { at: 1_500, role: 'user', text: String(calls[0].input.message) },
          { at: 2_000, role: 'agent', text: 'Opened https://github.com/a/b/pull/1' },
        ],
      },
    });
    await runner.refresh(() => {});
    expect(store.getTodo(todo.id)).toMatchObject({
      state: 'done',
      report: expect.stringContaining('pull/1'),
      evidence: '#1 已合并',
    });
    expect(told).toEqual(['Todo "Rows" is done: #1 已合并']);
  });

  test('a todo that starts in another repo moves to that repo’s child card first', async () => {
    const { store, sessions, runner } = setup();
    const todo = store.addTodo(
      'moving',
      'ask',
      { title: 'Rows', doneWhen: 'PR merged', check: null, instruction: 'Go.', named: null },
      1,
      'github.com/lsm/hyperneo'
    );
    sessions.create(todo.id, {
      verb: 'start',
      adapter: 'hyperneo',
      place: {
        machine: 'laptop',
        name: 'ops',
        folder: '/ops',
        remotes: ['git@github.com:lsm/ops.git'],
      },
    });
    const started = await runner.start(todo.id);
    const child = store.getAsk(started.ok ? started.todo.askId : '')!;
    expect(child).toMatchObject({
      title: 'iOS card · ops',
      parentId: 'ask',
      repo: 'github.com/lsm/ops',
    });
    expect(store.getTodo('moving')).toMatchObject({ state: 'doing', repo: 'github.com/lsm/ops' });
  });

  test("a todo checked by a pack sends that pack's worker rules after its instruction", async () => {
    const { runner, calls, add } = setup();
    await runner.start(add({ pack: 'coding', kind: 'pr_merged', params: {} }).id);
    await runner.start(add().id);
    expect(
      calls.filter((call) => call.name === 'work.start').map((call) => call.input.message)
    ).toEqual([
      expect.stringMatching(/Build the rows\.[\s\S]*Rules for this work: prove it by running it\./),
      expect.not.stringContaining('Rules for this work'),
    ]);
  });

  test('lets the packs track a todo without a check, and never finishes it from them', async () => {
    const { runner, store, sessions, add, checkedTodos } = setup(true);
    const todo = store.updateTodo(add(null), { state: 'doing' }, 2);
    sessions.recordRef(todo.id, { adapter: 'hyperneo', id: 'w' });
    await runner.refresh(() => {});
    expect(checkedTodos).toEqual([todo.id]);
    expect(store.getTodo(todo.id)?.state).toBe('doing');
  });

  test('a start that lands after its ask settled stops its session', async () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const store = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    const ask = store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'T',
      request: 'T',
      createdAt: 1,
    });
    const todo = store.addTodo(
      't',
      'ask',
      { title: 'Rows', doneWhen: 'Done', check: null, instruction: 'Do', named: null },
      1
    );
    sessions.create(todo.id, { verb: 'send', ref });
    const calls: string[] = [];
    const runner = createNeoTodoRunner({
      store,
      sessions,
      invoke: async (_caller, name) => {
        calls.push(name);
        if (name === 'work.send') {
          store.settleAsk(ask, 'dropped', 'Dropped', 2);
          return completed({ ok: true, value: { ref } });
        }
        return completed({ ok: true, value: { status: 'running' } });
      },
      packs: () => [],
      tell: async () => {},
      tellAsk: async () => {},
      changed: () => {},
    });
    await runner.start(todo.id);
    expect(calls.at(-1)).toBe('work.stop');
  });

  test('a start a restart interrupted fails the todo on the next refresh', async () => {
    const { store, runner, told, add } = setup();
    const todo = add();
    store.claimStart(todo, 2);
    await runner.refresh(() => {});
    expect(store.getTodo(todo.id)).toMatchObject({
      state: 'failed',
      reason: 'Start was interrupted; a session may have started without being recorded.',
    });
    expect(told).toEqual([expect.stringContaining('Start was interrupted')]);
    expect(await runner.retry(todo.id)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('start_uncertain'),
    });
  });

  test('a start the driver refuses fails the todo with its reason', async () => {
    const { db, store, add, told } = setup();
    const todo = add();
    const failing = createNeoTodoRunner({
      store,
      sessions: new NeoTodoSessionRepository(db),
      invoke: async () => completed({ ok: false, reason: 'unavailable', detail: 'login expired' }),
      packs: () => [],
      tell: async (_ask, _todo, note) => {
        told.push(note);
      },
      tellAsk: async () => {},
      changed: () => {},
    });
    const result = await failing.start(todo.id);
    expect(result.ok && result.todo).toMatchObject({
      state: 'failed',
      reason: 'Could not start: unavailable: login expired',
    });
    expect(told).toEqual(['Todo "Rows" failed: Could not start: unavailable: login expired']);
  });

  test('a refused dispatch records failure after a concurrent report write', async () => {
    const h = setup();
    const todo = h.add();
    try {
      const runner = createNeoTodoRunner({
        store: h.store,
        sessions: h.sessions,
        packs: () => [],
        invoke: async () => {
          const current = h.store.getTodo(todo.id)!;
          h.store.updateTodo(current, { report: 'Concurrent start report' }, current.updatedAt + 1);
          return completed({ ok: false, reason: 'unavailable', detail: 'Synthetic refusal' });
        },
        tell: async () => {},
        tellAsk: async () => {},
        changed: () => {},
      });
      expect(await runner.start(todo.id)).toMatchObject({
        ok: true,
        todo: { state: 'failed', report: 'Concurrent start report' },
      });
    } finally {
      h.db.close();
    }
  });

  test('a start whose input was accepted but now waits on a prompt keeps its session', async () => {
    const { db, store, add } = setup();
    const todo = add();
    const accepted = createNeoTodoRunner({
      store,
      sessions: new NeoTodoSessionRepository(db),
      invoke: async () =>
        completed({
          ok: true,
          value: {
            ref: { adapter: 'copilot', id: 's1' },
            title: 'Rows',
            place: { machine: 'laptop', name: 'repo' },
            status: 'needs_you',
            lastActivityAt: 1,
            receipt: { executionId: 's1', inputId: 'in-1' },
          },
        }),
      packs: () => [],
      tell: async () => {},
      tellAsk: async () => {},
      changed: () => {},
    });
    const result = await accepted.start(todo.id);
    expect(result.ok && result.todo).toMatchObject({ state: 'doing', blockedBy: null });
    expect(new NeoTodoSessionRepository(db).doingTodoOn({ adapter: 'copilot', id: 's1' })?.id).toBe(
      todo.id
    );
  });

  test('a start that needs the human blocks the todo with its plain hint, and retry starts it again', async () => {
    const { db, store, runner, add, told } = setup();
    const todo = add();
    const hint =
      'Claude Desktop did not import the new session. The task was not started. Open Claude Desktop, then ask Neo to start it again.';
    const waiting = createNeoTodoRunner({
      store,
      sessions: new NeoTodoSessionRepository(db),
      invoke: async () =>
        completed({
          ok: true,
          value: {
            ref: { adapter: 'claude-desktop', id: 'local_u1' },
            title: 'Rows',
            place: { machine: 'laptop', name: 'repo' },
            status: 'needs_you',
            lastActivityAt: 1,
            watchHint: hint,
          },
        }),
      packs: () => [],
      tell: async (_ask, _todo, note) => {
        told.push(note);
      },
      tellAsk: async () => {},
      changed: () => {},
    });
    const result = await waiting.start(todo.id);
    expect(result.ok && result.todo).toMatchObject({
      state: 'blocked',
      blockedBy: 'failure',
      blockedReason: `Could not start: ${hint}`,
      nextAction: 'Ask the human to open Claude Desktop, then retry this todo.',
    });
    expect(told).toEqual([expect.stringContaining(hint)]);
    expect(await runner.retry(todo.id)).toMatchObject({ ok: true });
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'doing', blockedBy: null });
  });
});

describe('neo todo runner follow-ups', () => {
  test('continue sends the next step and reopens the todo; retry goes again only before a session', async () => {
    const { store, runner, calls, add, setStatus } = setup();
    const todo = add();
    expect(await runner.proceed(todo.id, 'next')).toEqual({
      ok: false,
      reason: 'not_started: this todo is todo and has no session to continue.',
    });
    await runner.start(todo.id);
    store.updateTodo(store.getTodo(todo.id)!, { state: 'done', report: 'Done' }, 3);
    setStatus({ ok: true, value: { delivered: true } });
    const continued = await runner.proceed(todo.id, 'Now add tests.');
    expect(continued.ok && continued.todo).toMatchObject({ state: 'doing', report: null });
    expect(calls.at(-1)).toMatchObject({ name: 'work.send', input: { ref } });
    expect(String(calls.at(-1)?.input.message)).toContain('Now add tests.');
    expect(await runner.retry(todo.id)).toEqual({
      ok: false,
      reason: 'not_retryable: only a todo that failed before its session started goes again.',
    });
  });
});

describe('a todo session waiting on the human', () => {
  const warn = () => {};

  test('tells Neo once with the link, holds sends, and clears when the session runs again', async () => {
    const { runner, told, calls, add, setStatus } = setup();
    const todo = add();
    await runner.start(todo.id);
    const waiting = {
      ok: true,
      value: {
        status: 'needs_you',
        lastActivityAt: 2_000,
        waitingFor: 'permission prompt',
        link: 'claude://claude.ai/epitaxy/local_x',
      },
    };
    setStatus(waiting);
    await runner.refresh(warn);
    await runner.refresh(warn);
    const notes = told.filter((note) => note.includes('waiting on the human'));
    expect(notes).toEqual([
      'Todo "Rows": its session is waiting on the human (permission prompt). Ask the human once to answer it there: claude://claude.ai/epitaxy/local_x. Do not send to it until it runs again.',
    ]);
    const sends = calls.filter((call) => call.name === 'work.send').length;
    expect(await runner.proceed(todo.id, 'next')).toEqual({
      ok: false,
      reason:
        'needs_you: its session is waiting on the human; ask them to answer it there, then continue.',
    });
    expect(calls.filter((call) => call.name === 'work.send')).toHaveLength(sends);
    setStatus({ ok: true, value: { status: 'running', lastActivityAt: 3_000 } });
    await runner.refresh(warn);
    setStatus(waiting);
    await runner.refresh(warn);
    expect(told.filter((note) => note.includes('waiting on the human'))).toHaveLength(2);
  });

  test('continue reads the session fresh, so a todo closed while it waited is not stuck', async () => {
    const { store, runner, add, setStatus } = setup();
    const todo = add();
    await runner.start(todo.id);
    setStatus({ ok: true, value: { status: 'needs_you', lastActivityAt: 2_000 } });
    await runner.refresh(warn);
    store.updateTodo(store.getTodo(todo.id)!, { state: 'done', report: 'Closed' }, 3);
    setStatus({ ok: true, value: { status: 'done', lastActivityAt: 4_000 } });
    expect(await runner.proceed(todo.id, 'next')).toMatchObject({ ok: true });
  });

  test('a worker-blocked todo whose session waits on the human tells Neo too', async () => {
    const { store, runner, told, add, setStatus } = setup();
    const todo = add();
    await runner.start(todo.id);
    store.updateTodo(
      store.getTodo(todo.id)!,
      { state: 'blocked', blockedBy: 'worker', report: 'Stopped', blockedReason: 'x' },
      3
    );
    setStatus({ ok: true, value: { status: 'needs_you', lastActivityAt: 4_000 } });
    await runner.refresh(warn);
    expect(told.filter((note) => note.includes('waiting on the human'))).toHaveLength(1);
  });
});

describe('neo todo runner uncertainty', () => {
  test('a start that may have opened a session is not retried, and a running session is stopped', async () => {
    const { db, store, add, calls } = setup();
    const todo = add();
    const sessions = new NeoTodoSessionRepository(db);
    const flaky = createNeoTodoRunner({
      store,
      sessions,
      invoke: async (_caller, name, input) => {
        calls.push({ name, input });
        return { kind: 'failed', code: 'execution_failed', message: 'socket hang up' } as never;
      },
      packs: () => [],
      tell: async () => {},
      tellAsk: async () => {},
      changed: () => {},
    });
    const result = await flaky.start(todo.id);
    expect(result.ok && result.todo.state).toBe('failed');
    expect(await flaky.retry(todo.id)).toEqual({
      ok: false,
      reason:
        'start_uncertain: the start failed after the driver may have opened a session; find it with work.find before starting again.',
    });
    const running = add();
    sessions.recordRef(running.id, ref);
    sessions.recordLive(running.id, 'running', undefined);
    await flaky.stop(store.updateTodo(running, { state: 'done', report: 'Claimed done' }, 5));
    expect(calls.at(-1)).toMatchObject({ name: 'work.stop', input: { ref } });
    const resumed = add();
    sessions.recordRef(resumed.id, ref);
    sessions.recordLive(resumed.id, 'done', undefined);
    const before = calls.length;
    await flaky.stop(store.updateTodo(resumed, { state: 'done' }, 6));
    expect(calls).toHaveLength(before);
    await flaky.stop(store.updateTodo(resumed, { state: 'doing' }, 7));
    expect(calls.at(-1)).toMatchObject({ name: 'work.stop', input: { ref } });
    const unsupported = createNeoTodoRunner({
      store,
      sessions,
      invoke: async () =>
        completed({ ok: false, reason: 'unsupported', detail: 'This adapter cannot stop.' }),
      packs: () => [],
      tell: async () => {},
      tellAsk: async () => {},
      changed: () => {},
    });
    expect(await unsupported.stop(store.getTodo(resumed.id)!)).toBeNull();
    const refusing = createNeoTodoRunner({
      store,
      sessions,
      invoke: async () => completed({ ok: false, reason: 'unavailable', detail: 'Offline.' }),
      packs: () => [],
      tell: async () => {},
      tellAsk: async () => {},
      changed: () => {},
    });
    expect(await refusing.stop(store.getTodo(resumed.id)!)).toBe('stop_failed: Offline.');
  });
});

describe('requireNeoTodoStartable', () => {
  test('refuses daemon-checked todos and read targets', () => {
    const todo = { state: 'todo', instruction: null } as NeoTodo;
    const ask = { status: 'open' } as never;
    expect(requireNeoTodoStartable({ todo, ask, target: null })).toEqual({
      reason: {
        ok: false,
        reason: 'no_session: this todo has no instruction and target; the daemon checks it.',
      },
    });
    expect(
      requireNeoTodoStartable({
        todo: { ...todo, instruction: 'x' },
        ask,
        target: { verb: 'read', operation: 'x', input: {} } as never,
      })
    ).toEqual({
      reason: { ok: false, reason: 'unsupported_target: a todo cannot read a session.' },
    });
    expect(
      requireNeoTodoStartable({
        todo: { ...todo, instruction: 'x' },
        ask,
        target: { verb: 'adopt', ref: { adapter: 'hyperneo', id: 'w' } },
      })
    ).toEqual({
      reason: { ok: false, reason: 'unsupported_target: a todo cannot adopt a session.' },
    });
  });
});

describe('planNeoTodoSettled', () => {
  test('a stopped session keeps a todo doing with its report; a failure fails it, and the same failure twice blocks it', () => {
    const doing = { state: 'doing', check: { pack: 'coding' }, reason: null } as NeoTodo;
    expect(planNeoTodoSettled(doing, { status: 'reported', report: 'Opened #12' }, 5)).toEqual({
      report: 'Opened #12',
    });
    expect(
      planNeoTodoSettled({ ...doing, check: null }, { status: 'reported', report: 'Done' }, 5)
    ).toEqual({ report: 'Done' });
    expect(planNeoTodoSettled(doing, { status: 'failed', report: 'It stopped.' }, 5)).toEqual({
      state: 'failed',
      reason: 'It stopped.',
      finishedAt: 5,
    });
    expect(
      planNeoTodoSettled(
        { ...doing, reason: 'It stopped.' },
        { status: 'failed', report: 'It stopped.' },
        5
      )
    ).toMatchObject({
      state: 'blocked',
      blockedBy: 'failure',
      blockedReason: 'Failed twice: It stopped.',
    });
  });
});

describe('planNeoTodoCheck', () => {
  const blocked = {
    reason: 'No progress for 2 hours',
    nextAction: 'Ask the worker what is stuck.',
  };
  test('a passing check finishes an unfinished todo; a failing one fails it', () => {
    const doing = { state: 'doing', reason: null } as NeoTodo;
    expect(planNeoTodoCheck(doing, { done: true, evidence: 'ok' }, 1, true)).toMatchObject({
      state: 'done',
      evidence: 'ok',
      finishedAt: 1,
    });
    expect(planNeoTodoCheck(doing, { done: false, evidence: null }, 1, true)).toBeNull();
    expect(
      planNeoTodoCheck(doing, { done: false, evidence: null, failed: '#2 closed' }, 1, true)
    ).toMatchObject({ state: 'failed', reason: '#2 closed', finishedAt: 1 });
    expect(
      planNeoTodoCheck({ state: 'done' } as NeoTodo, { done: true, evidence: 'ok' }, 1, true)
    ).toBeNull();
  });

  test('a pack block blocks once and its clearing unblocks; other blockers stay', () => {
    const doing = { state: 'doing', reason: null } as NeoTodo;
    const patch = planNeoTodoCheck(doing, { done: false, evidence: null, blocked }, 1, true);
    expect(patch).toEqual({
      state: 'blocked',
      blockedBy: 'check',
      blockedReason: blocked.reason,
      nextAction: blocked.nextAction,
    });
    const held = { ...doing, ...patch } as NeoTodo;
    expect(planNeoTodoCheck(held, { done: false, evidence: null, blocked }, 2, true)).toBeNull();
    expect(planNeoTodoCheck(held, { done: false, evidence: null }, 2, false)).toEqual({
      state: 'todo',
    });
    expect(planNeoTodoCheck(held, { done: false, evidence: null }, 2, true)).toEqual({
      state: 'doing',
    });
    expect(
      planNeoTodoCheck({ ...held, blockedBy: 'worker' }, { done: false, evidence: null }, 2, true)
    ).toBeNull();
    expect(
      planNeoTodoCheck(
        { ...held, blockedBy: 'worker' },
        { done: false, evidence: null, blocked },
        2,
        true
      )
    ).toBeNull();
  });
});

describe('neoTodoNote', () => {
  test('passes on the report of a doing todo nothing checks, asking Neo to tick it', () => {
    expect(
      neoTodoNote({
        title: 'T',
        state: 'doing',
        doneWhen: 'Lane merged',
        check: null,
        report: 'Waiting on CI',
      } as NeoTodo)
    ).toBe(
      'Todo "T" reported, and nothing checks it: tick it done with evidence once "Lane merged" holds, or let it go on.\nIts report:\nWaiting on CI'
    );
  });

  test('says a failure with its reason', () => {
    expect(neoTodoNote({ title: 'T', state: 'failed', reason: 'gone' } as NeoTodo)).toBe(
      'Todo "T" failed: gone'
    );
  });

  test('says a blocked todo with its reason, next action and last report', () => {
    expect(
      neoTodoNote({
        title: 'T',
        state: 'blocked',
        blockedReason: 'Its session finished its turn; nothing confirms the todo is done yet.',
        nextAction: 'Close it.',
        report: 'Waiting on CI',
      } as NeoTodo)
    ).toBe(
      'Todo "T" is blocked: Its session finished its turn; nothing confirms the todo is done yet.\nNext: Close it.\nIts last report:\nWaiting on CI'
    );
  });
});

describe('a todo sent to an existing session', () => {
  test('starts when its own message is confirmed there, not at the session’s last activity', async () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const store = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: 'm1',
      title: 'Two sends',
      request: 'Send twice',
      createdAt: 1,
    });
    const claude = { adapter: 'claude-desktop', id: 'local_fs3' };
    const lastActivity = Date.parse('2026-10-17T20:14:36Z');
    let confirmedAt = 0;
    const runner = createNeoTodoRunner({
      store,
      sessions,
      invoke: async (_caller, name) =>
        name === 'work.send'
          ? completed({
              ok: true,
              value: {
                delivered: true,
                receipt: { executionId: 'cli-fs3', inputId: `in-${confirmedAt}` },
                confirmedAt,
              },
            })
          : completed({ ok: true, value: { status: 'done', lastActivityAt: lastActivity } }),
      packs: () => [],
      tell: async () => {},
      tellAsk: async () => {},
      changed: () => {},
    });
    const sent = (id: string) => {
      const todo = store.addTodo(
        id,
        'ask',
        { title: id, doneWhen: 'Done', check: null, instruction: `Do ${id}`, named: null },
        1
      );
      sessions.create(todo.id, { verb: 'send', ref: claude });
      return todo;
    };
    for (const [id, at] of [
      ['first', Date.parse('2026-10-17T20:30:00Z')],
      ['second', Date.parse('2026-10-17T21:18:25Z')],
    ] as const) {
      confirmedAt = at;
      await runner.start(sent(id).id);
      expect(sessions.readStartedAt(id)).toBe(at);
    }
    confirmedAt = Date.parse('2026-10-17T21:40:00Z');
    expect(await runner.proceed('second', 'Next step')).toMatchObject({ ok: true });
    expect(sessions.readStartedAt('second')).toBe(confirmedAt);
  });
});

describe('blocked todos', () => {
  const blocked = {
    reason: 'No progress for 2 hours',
    nextAction: 'Ask the worker what is stuck.',
  };
  const warn = () => {};

  test('a pack block is stored once, survives a restart and clears on progress', async () => {
    const { db, store, runner, told, add, setResult } = setup();
    const todo = add({ pack: 'coding', kind: 'pr_merged', params: {} });
    await runner.start(todo.id);
    store.updateTodo(store.getTodo(todo.id)!, { startedAt: null }, 2);
    setResult({ done: false, evidence: null, blocked });
    await runner.checkNow([todo.id], warn);
    await runner.checkNow([todo.id], warn);
    expect(told).toEqual([
      expect.stringContaining('Todo "Rows" is blocked: No progress for 2 hours'),
    ]);
    expect(new NeoAskTodoRepository(db).getTodo(todo.id)).toMatchObject({
      state: 'blocked',
      blockedBy: 'check',
      blockedReason: blocked.reason,
      nextAction: blocked.nextAction,
    });
    setResult({ done: false, evidence: null });
    await runner.checkNow([todo.id], warn);
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'doing', blockedReason: null });
    expect(told).toHaveLength(1);
  });

  test('the same failure twice blocks instead of failing, and continuing unblocks it', async () => {
    const { store, runner, told, add, setResult, setStatus } = setup();
    const todo = add({ pack: 'coding', kind: 'pr_merged', params: {} });
    await runner.start(todo.id);
    setResult({ done: false, evidence: null, failed: 'CI keeps failing' });
    await runner.checkNow([todo.id], warn);
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'failed', reason: 'CI keeps failing' });
    setStatus({ ok: true, value: { delivered: true } });
    expect(await runner.proceed(todo.id, 'Fix the test.')).toMatchObject({ ok: true });
    await runner.checkNow([todo.id], warn);
    expect(store.getTodo(todo.id)).toMatchObject({
      state: 'blocked',
      blockedBy: 'failure',
      blockedReason: 'Failed twice: CI keeps failing',
    });
    expect(told.at(-1)).toContain('Todo "Rows" is blocked: Failed twice: CI keeps failing');
    await runner.proceed(todo.id, 'Try another approach.');
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'doing', blockedBy: null });
  });

  test('a session that stops again after a follow-up keeps the todo doing and reports again', async () => {
    const { store, runner, told, add, setStatus, calls } = setup();
    const todo = add();
    await runner.start(todo.id);
    const opening = { at: 1_500, role: 'user', text: String(calls[0].input.message) };
    setStatus({
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: 2_000,
        lastReply: 'Opened the PR',
        inputEvidence: observed('Opened the PR', 2000),
        exchange: [opening, { at: 2_000, role: 'agent', text: 'Opened the PR' }],
      },
    });
    await runner.refresh(warn);
    store.updateTodo(store.getTodo(todo.id)!, { state: 'doing', report: 'Pushed a fix' }, 3);
    await runner.refresh(warn);
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'doing', blockedBy: null });
    expect(told.filter((note) => note.includes('nothing checks it'))).toHaveLength(2);
  });

  test('a todo held by its start question still starts, and starting clears the hold', async () => {
    const { store, runner, add } = setup();
    const todo = store.updateTodo(
      add(),
      {
        state: 'blocked',
        blockedBy: 'question',
        blockedReason: 'Waiting for the human to start it.',
      },
      2
    );
    expect(await runner.start(todo.id)).toMatchObject({ ok: true });
    expect(store.getTodo(todo.id)).toMatchObject({
      state: 'doing',
      blockedBy: null,
      blockedReason: null,
    });
  });

  test('settling the ask removes a blocked todo with the rest', () => {
    const { store, add } = setup();
    const todo = add();
    store.updateTodo(todo, { state: 'blocked', blockedBy: 'worker', blockedReason: 'Stopped' }, 2);
    store.settleAsk(store.getAsk('ask')!, 'dropped', 'Not needed', 3);
    expect(store.getTodo(todo.id)).toMatchObject({
      state: 'removed',
      blockedBy: null,
      blockedReason: null,
    });
  });

  test('a start that fails the same way twice is blocked, and retry starts it again', async () => {
    const { db, store, runner, add, told } = setup();
    const todo = add();
    const failing = createNeoTodoRunner({
      store,
      sessions: new NeoTodoSessionRepository(db),
      invoke: async () => completed({ ok: false, reason: 'unavailable', detail: 'login expired' }),
      packs: () => [],
      tell: async (_ask, _todo, note) => {
        told.push(note);
      },
      tellAsk: async () => {},
      changed: () => {},
    });
    await failing.start(todo.id);
    await failing.retry(todo.id);
    expect(store.getTodo(todo.id)).toMatchObject({
      state: 'blocked',
      blockedBy: 'failure',
      blockedReason: 'Failed twice: Could not start: unavailable: login expired',
    });
    expect(await runner.retry(todo.id)).toMatchObject({ ok: true });
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'doing', blockedBy: null });
  });

  test('a blocked todo closed or ticked done keeps no block', () => {
    const { store, add } = setup();
    const todo = store.updateTodo(
      add(),
      { state: 'blocked', blockedBy: 'worker', blockedReason: 'Stopped', nextAction: 'Close it' },
      2
    );
    expect(store.updateTodo(todo, { state: 'done', evidence: 'Closed' }, 3)).toMatchObject({
      state: 'done',
      blockedBy: null,
      blockedReason: null,
      nextAction: null,
    });
  });

  test('unblocking a todo that never started sends no note', async () => {
    const { store, runner, told, add, setResult } = setup();
    const todo = add({ pack: 'coding', kind: 'pr_merged', params: {} });
    setResult({ done: false, evidence: null, blocked });
    await runner.checkNow([todo.id], warn);
    setResult({ done: false, evidence: null });
    await runner.checkNow([todo.id], warn);
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'todo', blockedBy: null });
    expect(told).toEqual([expect.stringContaining('is blocked: No progress for 2 hours')]);
  });
});

describe('stopped worker ladder', () => {
  const MIN = 60_000;

  async function stopped(
    check: NeoTodo['check'] = { pack: 'coding', kind: 'pr_merged', params: {} },
    instruction: string | null = 'Build the rows.'
  ) {
    const harness = setup();
    const todo = harness.add(check, instruction);
    if (instruction) await harness.runner.start(todo.id);
    else {
      harness.sessions.recordRef(todo.id, { adapter: 'hyperneo', id: 'w' }, 1_000);
      harness.store.updateTodo(todo, { state: 'doing', startedAt: 1_000, report: 'Working.' }, 1);
    }
    harness.setStatus({
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: 2_000,
        inputEvidence: observed('Pushed the first half.', 2000),
        exchange: [
          { at: 1_500, role: 'user', text: String(harness.calls[0]?.input.message ?? 'Hi') },
          { at: 2_000, role: 'agent', text: 'Pushed the first half.' },
        ],
      },
    });
    await harness.runner.refresh(() => {});
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now');
    const at = async (minutes: number) => {
      clock.mockReturnValue(base + minutes * MIN);
      harness.runner.recheck([todo.id]);
      await harness.runner.refresh(() => {});
    };
    const sends = () =>
      harness.calls
        .filter((call) => call.name === 'work.send')
        .map((call) => String(call.input.message));
    return { ...harness, todo, at, sends, clock };
  }

  test('a stopped worker is reminded at 20 and 40, escalated at 60, and never blocked', async () => {
    const h = await stopped();
    try {
      for (const minutes of [19, 20, 39, 40, 59, 60, 90]) await h.at(minutes);
      expect(h.sends()).toEqual([
        expect.stringContaining('stopped for 20 min'),
        expect.stringContaining('stopped for 40 min'),
      ]);
      expect(h.store.getTodo(h.todo.id)?.state).toBe('doing');
      expect(h.told).toEqual([expect.stringContaining('two reminders without progress')]);
    } finally {
      h.clock.mockRestore();
      h.db.close();
    }
  });

  test('a todo without a check uses the same worker reminders and never blocks', async () => {
    const h = await stopped(null);
    try {
      for (const minutes of [20, 40, 60, 120]) await h.at(minutes);
      expect(h.sends()).toHaveLength(2);
      expect(h.store.getTodo(h.todo.id)?.state).toBe('doing');
      expect(h.told.filter((note) => note.includes('without progress'))).toHaveLength(1);
    } finally {
      h.clock.mockRestore();
      h.db.close();
    }
  });

  test('open PRs use ledger reminders only', async () => {
    const h = await stopped(null);
    try {
      h.setPrOpen(true);
      const count = h.told.length;
      for (const minutes of [20, 40, 60, 120]) await h.at(minutes);
      expect(h.sends()).toHaveLength(0);
      expect(h.told).toHaveLength(count);
      expect(h.store.getTodo(h.todo.id)?.state).toBe('doing');
    } finally {
      h.clock.mockRestore();
      h.db.close();
    }
  });

  test('a human-owned session gets no worker reminder', async () => {
    const h = await stopped(null, null);
    try {
      for (const minutes of [20, 40, 60, 120]) await h.at(minutes);
      expect(h.sends()).toEqual([]);
      expect(h.store.getTodo(h.todo.id)?.state).toBe('doing');
    } finally {
      h.clock.mockRestore();
      h.db.close();
    }
  });
});

describe('planNudge', () => {
  test('the single ladder reminds at 20/40, escalates at 60 and remains quiet', () => {
    const at = (minutes: number, nudges: number) =>
      planNudge({ since: 0, nudges }, minutes * 60_000);
    expect(at(19, 0)).toBeNull();
    expect(at(20, 0)).toEqual({ kind: 'remind', nudges: 1 });
    expect(at(39, 1)).toBeNull();
    expect(at(40, 1)).toEqual({ kind: 'remind', nudges: 2 });
    expect(at(60, 2)).toEqual({ kind: 'escalate', nudges: 3 });
    expect(at(300, 3)).toBeNull();
  });
});

describe('current explicit removal behavior before recompute', () => {
  const remove = (h: ReturnType<typeof setup>, todoId: string) => {
    const operation = createNeoTodoOperations(
      h.store,
      h.sessions,
      h.runner,
      () => [],
      () => null
    ).find((operation) => operation.name === 'neo.todo.remove')!;
    return operation.execute(operation.inputSchema.parse({ todoId, reason: 'Synthetic removal' }), {
      source: 'mcp',
      sessionId: 'neo',
      role: 'neo',
    });
  };

  test('removal prunes only its pending start choice and cannot be applied twice', async () => {
    const h = setup();
    try {
      const removed = h.add(),
        remaining = h.add();
      h.store.joinStartQuestion(removed, Date.now());
      h.store.joinStartQuestion(remaining, Date.now());
      const question = h.store.listQuestions('ask').find((question) => question.kind === 'start')!;
      expect(question.startTodos).toEqual([removed.id, remaining.id]);
      expect(await remove(h, removed.id)).toMatchObject({ ok: true, todo: { state: 'removed' } });
      expect(h.store.getQuestion(question.id)).toMatchObject({
        state: 'open',
        startTodos: [remaining.id],
      });
      expect(h.store.listTodos('ask').map(({ id, state }) => ({ id, state }))).toEqual([
        { id: removed.id, state: 'removed' },
        { id: remaining.id, state: 'todo' },
      ]);
      expect(await remove(h, removed.id)).toMatchObject({ ok: false });
      expect(h.store.getQuestion(question.id)?.startTodos).toEqual([remaining.id]);
    } finally {
      h.db.close();
    }
  });

  test('a stop refusal leaves the working todo and its complete report unchanged', async () => {
    const h = setup();
    try {
      const todo = h.add();
      await h.runner.start(todo.id);
      const report = 'Complete worker result 🦊\n'.repeat(4000);
      h.store.updateTodo(h.store.getTodo(todo.id)!, { report }, Date.now());
      const before = h.store.getTodo(todo.id);
      h.setStatus({ ok: false, reason: 'synthetic_stop_refused' });
      expect(await remove(h, todo.id)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('synthetic_stop_refused'),
      });
      expect(h.store.getTodo(todo.id)).toEqual(before);
      expect(h.calls.filter((call) => call.name === 'work.stop')).toHaveLength(1);
    } finally {
      h.db.close();
    }
  });

  test('reused worker activity and restart cannot revive a removed todo or discard its report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neo-todo-removal-pin-'));
    const path = join(dir, 'synthetic.db');
    const h = setup(null, path);
    let closed = false;
    try {
      const todo = h.add();
      await h.runner.start(todo.id);
      const report = 'Complete previous result 🦊\n'.repeat(4000);
      h.store.updateTodo(h.store.getTodo(todo.id)!, { report }, Date.now());
      expect(await remove(h, todo.id)).toMatchObject({ ok: true });
      const removed = h.store.getTodo(todo.id);
      const sibling = h.add();
      await h.runner.start(sibling.id);
      expect(h.sessions.readRef(sibling.id)).toEqual(h.sessions.readRef(todo.id));
      h.setStatus({ ok: true, value: { status: 'running', lastActivityAt: Date.now() } });
      await h.runner.refresh(() => {});
      expect(h.store.getTodo(todo.id)).toEqual(removed);
      h.db.close();
      closed = true;
      const db = new Database(path);
      try {
        const store = new NeoAskTodoRepository(db),
          sessions = new NeoTodoSessionRepository(db);
        const effects: string[] = [];
        const runner = createNeoTodoRunner({
          store,
          sessions,
          packs: () => [],
          invoke: async (_caller, name) => {
            effects.push(name);
            return completed({
              ok: true,
              value: { status: 'running', lastActivityAt: Date.now() },
            });
          },
          tell: async () => {},
          tellAsk: async () => {},
          changed: () => {},
        });
        await runner.refresh(() => {});
        await runner.refresh(() => {});
        expect(await runner.start(todo.id)).toMatchObject({ ok: false });
        expect(await runner.proceed(todo.id, 'Stale continuation')).toMatchObject({ ok: false });
        expect(await runner.retry(todo.id)).toMatchObject({ ok: false });
        expect(store.getTodo(todo.id)).toEqual(removed);
        expect(store.getTodo(todo.id)?.report).toBe(report);
        expect(store.getTodo(sibling.id)?.state).toBe('doing');
        expect(
          effects.filter((name) => ['work.start', 'work.send', 'work.stop'].includes(name))
        ).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      if (!closed) h.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
