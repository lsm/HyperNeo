import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { existingTodoTarget } from '../../helpers/todo-check-packs.ts';
import { createTodoCheckPacks, pendingTodoCheck } from '../../helpers/todo-check-packs.ts';
import { describe, expect, spyOn, test } from 'bun:test';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import {
  createNeoAskRecordOperations,
  requireAskSession,
  requireNeoAskGoal,
  requireNeoAskProject,
  requireNeoAskSession,
} from '../../../../src/lib/neo/ask-record-operations.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { listOperationSummaries } from '../../../../src/lib/operations/discovery.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { SessionGoalRepository } from '../../../../src/storage/repositories/session-goal-repository.ts';

const turn = (_messageId: string, _human = true): OperationCaller => ({
  source: 'mcp',
  sessionId: 'neo-a',
  role: 'neo',
});

type Receipt = { ok: true; ask: NeoAsk; todos: NeoTodo[] } | { ok: false; reason: string };

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.exec(
    "INSERT INTO neo_concerns (id, title, summary, context, revision, created_at, updated_at) VALUES ('project-1', 'P', '', '', 1, 1, 1)"
  );
  const store = new NeoAskTodoRepository(db);
  const goals = new SessionGoalRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const started: string[] = [];
  const stopped: string[] = [];
  const refuse = { value: false };
  const stopFails = { value: false };
  const onStop: { value: ((todo: NeoTodo) => void) | null } = { value: null };
  const ops = Object.fromEntries(
    createNeoAskRecordOperations(
      store,
      sessions,
      {
        resolveTarget: existingTodoTarget,
        advance: async () => {
          if (refuse.value) return;
          for (const ask of store.listOpenAsks())
            for (const todo of store.listTodos(ask.id))
              if (todo.state === 'todo' && todo.instruction) {
                started.push(todo.id);
                store.updateTodo(todo, { state: 'doing' }, 2);
              }
        },
        proceed: async () => ({ ok: false, reason: 'unused' }),
        retry: async () => ({ ok: false, reason: 'unused' }),
        stop: async (todo) => {
          stopped.push(todo.id);
          onStop.value?.(todo);
          return stopFails.value ? 'stop_failed: offline' : null;
        },
      },
      (projectId) => (projectId === 'project-1' ? projectId : null),
      (sessionId) => ['neo-a', 'neo-other'].includes(sessionId),
      () => [{ id: 'project-1', title: 'P' }],
      () => createTodoCheckPacks(db),
      (id) => goals.get(id),
      undefined,
      { gateway: gatewayFor(db), changed: () => {} }
    ).map((op) => [op.name, op])
  );
  const call = async (name: string, input: unknown, caller: OperationCaller) =>
    (await ops[name].execute(ops[name].inputSchema.parse(input), caller)) as Receipt;
  return { db, store, goals, sessions, call, started, stopped, refuse, stopFails, onStop, ops };
}

const opening = {
  title: 'Fix login',
  request: 'Fix the login bug and merge it',
  todos: [
    {
      after: [],
      title: 'Fix it',
      doneWhen: 'PR merged',
      check: { pack: 'coding', kind: 'pr_merged' },
      instruction: 'Fix the login bug.',
      target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'dev-1' } },
    },
    { after: [], check: pendingTodoCheck, title: 'Deploy', doneWhen: 'Both daemons run it' },
  ],
};

describe('neo.ask.open and neo.ask.settle', () => {
  test('ask retries read each repository scope once and refresh facts on the next operation', async () => {
    const { db, call, store } = setup();
    const base = { title: 'Repository query budget', request: 'Reuse recorded work' };
    const draft = {
      after: [],
      title: 'Recorded work',
      check: pendingTodoCheck,
      named: { repository: 'synthetic/one' },
    };
    const opened = await call('neo.ask.open', { ...base, todos: [draft] }, turn('initial'));
    if (!opened.ok) throw new Error(opened.reason);
    const prepare = db.prepare.bind(db);
    const statements: string[] = [];
    const spy = spyOn(db, 'prepare').mockImplementation((...args) => {
      if (/^SELECT repo FROM (neo_asks|pack_coding_todos)|^SELECT DISTINCT p.repo/.test(args[0]))
        statements.push(args[0]);
      return prepare(...args);
    });
    try {
      for (const repository of ['synthetic/one', 'synthetic/two']) {
        db.prepare('UPDATE pack_coding_todos SET repo = ? WHERE todo_id = ?').run(
          `github.com/${repository}`,
          opened.todos[0].id
        );
        statements.length = 0;
        const retried = await call(
          'neo.ask.open',
          {
            ...base,
            todos: Array.from({ length: 20 }, () => ({ ...draft, named: { repository } })),
          },
          turn('retry')
        );
        expect(retried.ok).toBe(true);
        expect(store.listTodos(opened.ask.id).map((todo) => todo.id)).toEqual([opened.todos[0].id]);
        expect(statements).toHaveLength(3);
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('ask retries keep duplicate matching stable while new sibling repositories are added', async () => {
    const { call, store } = setup();
    const base = { title: 'Synthetic repository work', request: 'Keep the recorded work' };
    const opened = await call(
      'neo.ask.open',
      {
        ...base,
        todos: [
          {
            after: [],
            title: 'Repeated',
            check: pendingTodoCheck,
            named: { repository: 'synthetic/one' },
          },
        ],
      },
      turn('first')
    );
    if (!opened.ok) throw new Error(opened.reason);
    const original = opened.todos[0].id;
    const retried = await call(
      'neo.ask.open',
      {
        ...base,
        todos: [
          {
            after: [],
            title: 'New sibling',
            check: pendingTodoCheck,
            named: { repository: 'synthetic/two' },
          },
          {
            after: [],
            title: 'Repeated',
            check: pendingTodoCheck,
            instruction: 'Keep working',
            target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'worker' } },
          },
        ],
      },
      turn('retry')
    );
    expect(retried.ok).toBe(true);
    const rows = store.listTodos(opened.ask.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.title === 'Repeated').map((row) => row.id)).toEqual([original]);
  });

  test('worker roles discover ask opening in the default operation list', () => {
    const { ops } = setup();
    const registry = createOperationRegistry(Object.values(ops));
    for (const role of ['workflow_worker', 'direct_task_worker', 'long_term_agent'] as const)
      expect(
        listOperationSummaries(registry, { source: 'mcp', sessionId: 'worker-1', role }).map(
          (item) => item.name
        )
      ).toContain('neo.ask.open');
    expect(
      listOperationSummaries(registry, {
        source: 'mcp',
        sessionId: 'worker-1',
        role: 'universal_read',
      }).map((item) => item.name)
    ).not.toContain('neo.ask.outcome');
  });
  test('settling an ask preserves an unverified close instead of treating it as unfinished', async () => {
    const h = setup();
    const opened = await h.call(
      'neo.ask.open',
      {
        title: 'Unverified delivery',
        request: 'Close without a verified outcome',
        todos: [
          { after: [], check: pendingTodoCheck, title: 'Delivery', doneWhen: 'Result checked' },
        ],
      },
      turn('m1')
    );
    if (!opened.ok) throw new Error(opened.reason);
    h.store.updateTodo(
      opened.todos[0],
      { state: 'closed_unverified', reason: 'Outcome not checked' },
      2
    );
    const settled = await h.call(
      'neo.ask.settle',
      {
        askId: opened.ask.id,
        status: 'done',
        outcome: 'Closed with verification still outstanding',
      },
      turn('m2')
    );
    expect(settled).toMatchObject({
      ok: true,
      todos: [{ state: 'closed_unverified', reason: 'Outcome not checked' }],
    });
  });

  test('records a settled discussion decision and links while execution stays open', async () => {
    const h = setup();
    const opened = await h.call(
      'neo.ask.open',
      {
        title: 'Choose positioning',
        request: 'Discuss then implement',
        todos: [
          {
            after: [],
            check: pendingTodoCheck,
            title: 'Implement the chosen option',
            doneWhen: 'PR merged',
          },
        ],
      },
      turn('m1')
    );
    if (!opened.ok) throw new Error(opened.reason);
    h.store.focusAsk(
      opened.ask.id,
      {
        adapter: 'hyperneo',
        id: 'discussion',
        name: 'Discussion',
        label: 'Discussion',
        provider: 'Anthropic',
        link: '/session/discussion',
      },
      2
    );
    const todos = h.store.listTodos(opened.ask.id);
    const outcome =
      'Decision: prioritize beginner gardeners.\nDocument: [Positioning](https://example.test/positioning.md)\nPR: https://github.com/example/project/pull/8';
    expect(
      await h.call('neo.ask.outcome', { askId: opened.ask.id, outcome }, turn('m2'))
    ).toMatchObject({
      ok: true,
      ask: { outcome, status: 'open', settledAt: null, focusedSession: { id: 'discussion' } },
    });
    expect(h.store.listTodos(opened.ask.id)).toEqual(todos);
    expect(h.stopped).toEqual([]);
    expect(h.started).toEqual([]);
    expect(
      await h.call(
        'neo.ask.open',
        {
          title: 'Choose positioning',
          request: 'Discuss then implement',
          todos: [
            {
              after: [],
              check: pendingTodoCheck,
              title: 'Deploy after implementation',
              doneWhen: 'Build readback matches',
            },
          ],
        },
        turn('m4')
      )
    ).toMatchObject({ ok: true, ask: { id: opened.ask.id, outcome } });
    expect(h.store.listTodos(opened.ask.id)).toHaveLength(2);
    expect(
      await h.call(
        'neo.ask.settle',
        { askId: opened.ask.id, status: 'done', outcome: 'Done' },
        turn('m3')
      )
    ).toMatchObject({ ok: false, reason: expect.stringContaining('todos_unfinished:') });
    expect(h.store.getAsk(opened.ask.id)).toMatchObject({ status: 'open', outcome });
  });

  test('refuses recording by a worker, another Neo, or on an unfocused or settled ask', async () => {
    const h = setup();
    const opened = await h.call(
      'neo.ask.open',
      { title: 'Discussion', request: 'Choose a direction' },
      turn('m1')
    );
    if (!opened.ok) throw new Error(opened.reason);
    const input = { askId: opened.ask.id, outcome: 'Claimed approval' };
    expect(await h.call('neo.ask.outcome', input, turn('m2'))).toMatchObject({ ok: false });
    h.store.focusAsk(
      opened.ask.id,
      {
        adapter: 'hyperneo',
        id: 'discussion',
        name: null,
        label: 'Discussion',
        provider: 'Anthropic',
        link: '/session/discussion',
      },
      2
    );
    for (const caller of [
      { source: 'mcp', role: 'worker', sessionId: 'discussion' },
      { source: 'mcp', role: 'neo', sessionId: 'neo-other' },
      { source: 'rpc', principal: 'local' },
    ] as OperationCaller[])
      expect(await h.call('neo.ask.outcome', input, caller)).toMatchObject({ ok: false });
    expect(h.store.getAsk(opened.ask.id)?.outcome).toBeNull();
    h.store.settleAsk(h.store.getAsk(opened.ask.id)!, 'done', 'Finished', 3);
    expect(await h.call('neo.ask.outcome', input, turn('m3'))).toMatchObject({ ok: false });
    expect(h.store.getAsk(opened.ask.id)?.outcome).toBe('Finished');
  });

  test('an ask links any existing goal; retries and repo splits retain that goal', async () => {
    const { store, goals, call, started } = setup();
    const mine = goals.create('neo-a', { title: 'Ship', doneTest: 'Released' }, 1);
    const other = goals.create('neo-other', { title: 'Other', doneTest: 'Released' }, 1);
    expect(await call('neo.ask.open', { ...opening, goalId: 'missing' }, turn('m1'))).toMatchObject(
      {
        ok: false,
        reason: expect.stringContaining('goal_not_found'),
      }
    );
    expect(store.listAsks(undefined, 100)).toEqual([]);
    expect(started).toEqual([]);
    const foreign = await call('neo.ask.open', { ...opening, goalId: other.id }, turn('m1'));
    expect(foreign.ok && foreign.ask.goalId).toBe(other.id);
    const result = await call('neo.ask.open', { ...opening, goalId: mine.id }, turn('m1'));
    if (!result.ok) throw new Error(result.reason);
    expect(result.ask.goalId).toBe(mine.id);
    expect(await call('neo.ask.open', { ...opening, goalId: mine.id }, turn('m1'))).toMatchObject({
      ok: true,
      ask: { id: result.ask.id },
    });
    const independent = await call('neo.ask.open', { ...opening, todos: [] }, turn('m1'));
    expect(independent.ok && independent.ask.id).not.toBe(result.ask.id);
    const child = store.openAsk({
      ...result.ask,
      id: 'historical-child',
      parentId: result.ask.id,
    });
    expect(child.goalId).toBe(mine.id);
    expect(store.listGoalAsks(mine.id).map((ask) => ask.id)).toEqual(
      expect.arrayContaining([result.ask.id, child.id])
    );
  });
  test('opens an ask with its todos once per turn and starts the ones with work', async () => {
    const { call, started } = setup();
    const first = await call('neo.ask.open', opening, turn('m1'));
    if (!first.ok) throw new Error(first.reason);
    expect(first.ask).toMatchObject({
      projectId: null,
      sessionId: 'neo-a',
      originMessageId: null,
      status: 'open',
    });
    expect(first.todos.map((todo) => [todo.title, todo.instruction !== null])).toEqual([
      ['Fix it', true],
      ['Deploy', false],
    ]);
    expect(started).toEqual([first.todos[0].id]);
    const retry = await call('neo.ask.open', opening, turn('m1'));
    expect(retry.ok && retry.ask.id).toBe(first.ask.id);
    expect(retry.ok && retry.todos).toHaveLength(2);
    expect(started).toHaveLength(1);
  });

  test('a queue with no free slot leaves the todos queued and the ask open', async () => {
    const { call, refuse, started, store } = setup();
    refuse.value = true;
    const opened = await call('neo.ask.open', opening, turn('m3'));
    if (!opened.ok) throw new Error(opened.reason);
    expect(store.listTodos(opened.ask.id).map((todo) => todo.state)).toEqual(['todo', 'todo']);
    expect(store.listQuestions(opened.ask.id)).toEqual([]);
    expect(started).toEqual([]);
  });

  test('a todo added in a turn the human did not start still starts', async () => {
    const { call, started } = setup();
    const opened = await call('neo.ask.open', opening, turn('m2', false));
    if (!opened.ok) throw new Error(opened.reason);
    expect(started).toEqual([opened.todos[0].id]);
  });

  test('a start that lands while settle stops other sessions is stopped after the ask settles', async () => {
    const { call, sessions, stopped, onStop } = setup();
    const opened = await call('neo.ask.open', opening, turn('m6'));
    if (!opened.ok) throw new Error(opened.reason);
    const [first, second] = opened.todos;
    onStop.value = (todo) => {
      if (todo.id === second.id) sessions.recordRef(first.id, { adapter: 'hyperneo', id: 'late' });
    };
    const settled = await call(
      'neo.ask.settle',
      { askId: opened.ask.id, status: 'dropped', outcome: 'x' },
      turn('m6')
    );
    expect(settled.ok).toBe(true);
    expect(stopped).toEqual([first.id, second.id, first.id]);
  });

  test.each(['done', 'dropped'] as const)(
    'a %s settle whose stop fails leaves the ask open and says so',
    async (status) => {
      const { call, store, stopFails } = setup();
      const opened = await call('neo.ask.open', opening, turn('m5'));
      if (!opened.ok) throw new Error(opened.reason);
      if (status === 'done')
        for (const todo of store.listTodos(opened.ask.id))
          store.updateTodo(todo, { state: 'done', evidence: 'Observed' }, 2);
      stopFails.value = true;
      const settled = await call(
        'neo.ask.settle',
        { askId: opened.ask.id, status, outcome: 'x' },
        turn('m5')
      );
      expect(settled.ok).toBe(false);
      expect(!settled.ok && settled.reason).toContain('the ask is still open');
      expect(store.getAsk(opened.ask.id)?.status).toBe('open');
      expect(store.listTodos(opened.ask.id).map((todo) => todo.state)).toEqual(
        status === 'done' ? ['done', 'done'] : ['doing', 'todo']
      );
    }
  );

  test.each(['rpc', 'mcp'] as const)(
    '%s cannot mark an ask done with unfinished coding todos',
    async (source) => {
      const { call, store, stopped } = setup();
      const opened = await call('neo.ask.open', opening, turn('early-done'));
      if (!opened.ok) throw new Error(opened.reason);
      const before = store.listTodos(opened.ask.id);
      expect(
        await call(
          'neo.ask.settle',
          {
            askId: opened.ask.id,
            status: 'done',
            outcome: 'Too soon',
          },
          { source, principal: 'local', role: 'neo', sessionId: 'neo' }
        )
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining('todos_unfinished:'),
      });
      expect(store.getAsk(opened.ask.id)?.status).toBe('open');
      expect(store.listTodos(opened.ask.id)).toEqual(before);
      expect(stopped).toEqual([]);
    }
  );

  test('settling stops running sessions, retires open questions and ends the ask', async () => {
    const { call, store, stopped } = setup();
    const opened = await call('neo.ask.open', opening, turn('m3'));
    if (!opened.ok) throw new Error(opened.reason);
    store.askQuestion(
      'q',
      opened.ask.id,
      {
        text: 'Deploy now?',
        kind: 'reply',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: null,
      },
      1
    );
    const settled = await call(
      'neo.ask.settle',
      { askId: opened.ask.id, status: 'dropped', outcome: 'The human dropped it.' },
      { source: 'rpc', principal: 'local' }
    );
    expect(settled.ok && settled.ask).toMatchObject({
      status: 'dropped',
      outcome: 'The human dropped it.',
      settledAt: expect.any(Number),
    });
    expect(stopped).toHaveLength(2);
    expect(store.getQuestion('q')?.state).toBe('retired');
    expect(store.listTodos(opened.ask.id).map((todo) => [todo.state, todo.reason])).toEqual([
      ['removed', 'The ask was settled dropped.'],
      ['removed', 'The ask was settled dropped.'],
    ]);
    expect(
      await call(
        'neo.ask.settle',
        { askId: opened.ask.id, status: 'done', outcome: 'x' },
        turn('m4')
      )
    ).toEqual({ ok: false, reason: 'ask_settled: this ask is dropped.' });
  });
});

describe('requireNeoAskProject', () => {
  test('keeps no project by default and refuses an unknown id', () => {
    const resolve = (id: string) => (id === 'old' ? 'kept' : null);
    expect(requireNeoAskProject({}, resolve)).toEqual({ value: null });
    expect(requireNeoAskProject({ projectId: null }, resolve)).toEqual({ value: null });
    expect(requireNeoAskProject({ projectId: 'old' }, resolve)).toEqual({ value: 'kept' });
    expect(requireNeoAskProject({ projectId: 'nope' }, resolve)).toEqual({
      reason: { ok: false, reason: 'unknown_project: no project nope.' },
    });
  });

  test('caps the listed projects at 50', () => {
    const known = () => Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, title: `T${i}` }));
    const refused = requireNeoAskProject({ projectId: 'x' }, () => null, known);
    const reason = 'reason' in refused ? refused.reason.reason : '';
    expect(reason).toContain('p49 (T49)');
    expect(reason).not.toContain('p50 (T50)');
  });

  test('lists the known projects when an id matches none', () => {
    const known = () => [
      { id: 'project:a', title: 'Alpha' },
      { id: 'b', title: 'Beta' },
    ];
    expect(requireNeoAskProject({ projectId: 'nope' }, () => null, known)).toEqual({
      reason: {
        ok: false,
        reason: 'unknown_project: no project nope. Projects: project:a (Alpha); b (Beta).',
      },
    });
  });
});

describe('requireNeoAskSession', () => {
  test('needs a Neo session', () => {
    const refused = {
      reason: { ok: false, reason: 'no_session: only a Neo session opens an ask.' },
    };
    expect(requireNeoAskSession({ source: 'rpc' }, () => true)).toEqual(refused);
    expect(requireNeoAskSession({ source: 'mcp', sessionId: 'worker-1' }, () => false)).toEqual(
      refused
    );
  });
});

describe('requireAskSession and requireNeoAskGoal', () => {
  test('any agent session opens an ask and may name a goal another session owns', () => {
    expect(
      requireAskSession({ source: 'mcp', role: 'direct_task_worker', sessionId: 'worker-1' })
    ).toEqual({ value: 'worker-1' });
    expect(requireAskSession({ source: 'mcp', sessionId: 'worker-1' })).toMatchObject({
      reason: { ok: false, reason: 'no_session: opening an ask needs an agent session.' },
    });
    expect(
      requireAskSession({ source: 'mcp', role: 'universal_read', sessionId: 'chat-1' })
    ).toMatchObject({
      reason: { ok: false, reason: 'no_session: opening an ask needs an agent session.' },
    });
    expect(requireAskSession({ source: 'rpc', principal: 'local' })).toMatchObject({
      reason: { ok: false, reason: 'no_session: opening an ask needs an agent session.' },
    });
    const goal = { ownerSessionId: 'neo:root' } as unknown as Parameters<
      typeof requireNeoAskGoal
    >[2];
    expect(requireNeoAskGoal('goal-1', 'worker-1', goal)).toEqual({ value: 'goal-1' });
  });
});

describe('ask topics', () => {
  test('neo.ask.open records a trimmed topic and leaves it null when omitted', async () => {
    const h = setup();
    const labelled = await h.call(
      'neo.ask.open',
      { title: 'Screen time', request: 'Limit the tablet', topic: '  家长控制 ' },
      turn('m1')
    );
    const plain = await h.call(
      'neo.ask.open',
      { title: 'Inbox', request: 'Sort the inbox' },
      turn('m2')
    );
    if (!labelled.ok || !plain.ok) throw new Error('open refused');
    expect(labelled.ask.topic).toBe('家长控制');
    expect(plain.ask.topic).toBeNull();
    expect(h.store.getAsk(labelled.ask.id)?.topic).toBe('家长控制');
    for (const topic of ['', '   ', 'Thirteen char'])
      expect(() => h.ops['neo.ask.open'].inputSchema.parse({ ...opening, topic })).toThrow();
  });

  test('neo.ask.topic sets and changes an open ask topic and refuses a settled ask', async () => {
    const h = setup();
    const opened = await h.call(
      'neo.ask.open',
      { title: 'Apply', request: 'Apply to universities' },
      turn('m1')
    );
    if (!opened.ok) throw new Error(opened.reason);
    const set = await h.call(
      'neo.ask.topic',
      { askId: opened.ask.id, topic: ' 大学申请 ' },
      turn('m2')
    );
    expect(set).toMatchObject({ ok: true, ask: { id: opened.ask.id, topic: '大学申请' } });
    await h.call('neo.ask.topic', { askId: opened.ask.id, topic: 'OAP' }, turn('m3'));
    expect(h.store.getAsk(opened.ask.id)?.topic).toBe('OAP');
    expect(
      await h.call(
        'neo.ask.topic',
        { askId: opened.ask.id, topic: 'Mail' },
        { source: 'mcp', role: 'neo', sessionId: 'neo-other' }
      )
    ).toMatchObject({ ok: false });
    h.store.settleAsk(h.store.getAsk(opened.ask.id)!, 'done', 'Sent', 4);
    expect(
      await h.call('neo.ask.topic', { askId: opened.ask.id, topic: '邮件' }, turn('m4'))
    ).toEqual({ ok: false, reason: 'ask_settled: this ask is done.' });
    expect(h.store.getAsk(opened.ask.id)?.topic).toBe('OAP');
    expect(h.ops['neo.ask.topic'].policy?.roles).toEqual(['neo']);
  });
});
