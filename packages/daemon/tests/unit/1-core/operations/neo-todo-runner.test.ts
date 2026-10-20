import { describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoPack, NeoTodoCheckResult } from '../../../../src/lib/neo/packs/types.ts';
import {
  createNeoTodoRunner,
  neoAskIdleNote,
  neoTodoNote,
  planNeoTodoCheck,
  planNeoTodoIdle,
  planNeoTodoSettled,
  requireNeoTodoStartable,
} from '../../../../src/lib/neo/todo-runner.ts';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const ref = { adapter: 'hyperneo', id: 'worker-1' };
const completed = (value: unknown): OperationOutcome =>
  ({ kind: 'completed', value }) as OperationOutcome;

function setup(packDone: boolean | null = null) {
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
    title: 'iOS card',
    request: 'Redo the iOS card',
    createdAt: 1,
  });
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const told: string[] = [];
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
    },
  } satisfies NeoPack;
  const runner = createNeoTodoRunner({
    store,
    sessions,
    invoke: async (_caller, name, input) => {
      calls.push({ name, input });
      if (name === 'work.start')
        return completed({ ok: true, value: { ref, lastActivityAt: 1_000, link: '/session/w' } });
      if (name === 'work.send')
        return completed(sendResult ?? { ok: true, value: { delivered: true } });
      return completed(status);
    },
    packs: () => [pack],
    tell: async (_ask, _todo, note) => {
      told.push(note);
    },
    tellAsk: async (_ask, messageId) => {
      askNotes.push(messageId);
    },
    changed: () => {},
  });
  const add = (check: NeoTodo['check'] = null) => {
    const todo = store.addTodo(
      crypto.randomUUID(),
      'ask',
      { title: 'Rows', doneWhen: 'PR merged', check, instruction: 'Build the rows.', named: null },
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
    askNotes,
    checkedTodos,
    add,
    setStatus: (value: unknown) => {
      status = value;
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
    check: NeoTodo['check'] = { pack: 'coding', kind: 'pr_merged', params: {} }
  ) {
    const harness = setup();
    const todo = harness.add(check);
    await harness.runner.start(todo.id);
    harness.setStatus({
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: 2_000,
        exchange: [
          { at: 1_500, role: 'user', text: String(harness.calls[0].input.message) },
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

  test('a worker that stops before done is reminded at 30 and 60 minutes, then blocked once for Neo', async () => {
    const h = await stopped();
    expect(h.store.getTodo(h.todo.id)?.state).toBe('doing');
    expect(h.told).toEqual([]);
    for (const minutes of [29, 30, 45, 60, 75]) await h.at(minutes);
    expect(h.sends()).toEqual([
      expect.stringContaining('your session has been stopped for 30 min'),
      expect.stringContaining('your session has been stopped for 60 min'),
    ]);
    expect(h.store.getTodo(h.todo.id)?.state).toBe('doing');
    await h.at(90);
    await h.at(120);
    expect(h.store.getTodo(h.todo.id)).toMatchObject({
      state: 'blocked',
      blockedBy: 'worker',
      blockedReason: 'Its session stopped 90 min ago and did not continue after 2 reminders.',
    });
    expect(h.told).toEqual([expect.stringContaining('did not continue after 2 reminders')]);
    h.clock.mockRestore();
    h.db.close();
  });

  test('a todo nothing checks reminds Neo, not the worker, at 30 and 60 minutes, then blocks', async () => {
    const h = await stopped(null);
    expect(h.told).toEqual([expect.stringContaining('nothing checks it')]);
    for (const minutes of [29, 30, 45, 60, 75]) await h.at(minutes);
    expect(h.sends()).toEqual([]);
    expect(h.told.slice(1)).toEqual([
      'Todo "Rows" stopped 30 min ago and nobody ticked it (done when: PR merged). Tick it done with evidence, continue it with neo.todo.continue, or close it.',
      'Todo "Rows" stopped 60 min ago and nobody ticked it (done when: PR merged). Tick it done with evidence, continue it with neo.todo.continue, or close it.',
    ]);
    expect(h.store.getTodo(h.todo.id)?.state).toBe('doing');
    await h.at(90);
    await h.at(120);
    expect(h.store.getTodo(h.todo.id)).toMatchObject({
      state: 'blocked',
      blockedBy: 'worker',
      blockedReason: 'Its session stopped 90 min ago and nobody ticked it after 2 reminders.',
    });
    expect(h.told).toHaveLength(4);
    h.clock.mockRestore();
    h.db.close();
  });

  test('a worker that cannot be reached is blocked at the first reminder', async () => {
    const h = await stopped();
    h.setSend({ ok: false, reason: 'unreachable', detail: 'gone' });
    await h.at(30);
    expect(h.store.getTodo(h.todo.id)?.blockedReason).toBe(
      'Its session stopped 30 min ago and could not be reached.'
    );
    h.clock.mockRestore();
    h.db.close();
  });
});

describe('planNeoTodoIdle', () => {
  test('reminds at D and 2D, blocks at 3D, then stays quiet', () => {
    const at = (minutes: number, nudges: number) =>
      planNeoTodoIdle({ since: 0, nudges }, minutes * 60_000);
    expect(at(29, 0)).toBeNull();
    expect(at(30, 0)).toEqual({ kind: 'remind', nudges: 1 });
    expect(at(59, 1)).toBeNull();
    expect(at(60, 1)).toEqual({ kind: 'remind', nudges: 2 });
    expect(at(90, 2)).toEqual({ kind: 'block' });
    expect(at(300, 3)).toBeNull();
  });
});
