import { workerIdentity } from '@hyperneo/shared/types/worker-identity';
import { describe, expect, test } from 'bun:test';
import type {
  NeoAsk,
  NeoAskEntry,
  NeoQuestion,
  NeoTodo,
  NeoTodoEntry,
} from '@hyperneo/shared/types/neo-ask';
import {
  createNeoDoneTodosOperation,
  createNeoAskReadOperation,
  neoAskEntryState,
  neoSnapshotAskEntries,
  neoTodoStatusLine,
  neoWorkCounts,
  projectNeoAskEntries,
} from '../../../../src/lib/neo/ask-entries.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import {
  NeoTodoSessionRepository,
  neoSafeSessionLink,
} from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

import { NEO_TODO_STALLED_CARD_TAIL } from '../../../../src/lib/neo/todo-state.ts';
import { todoEvidenceFile } from '../../../../src/lib/work-locations.ts';

const todo = (patch: Partial<NeoTodo>): NeoTodo =>
  ({
    id: 't',
    title: 'T',
    state: 'todo',
    reason: null,
    report: null,
    evidence: null,
    ...patch,
  }) as NeoTodo;
const ask = (status: NeoAsk['status'] = 'open') => ({ status }) as NeoAsk;
const question = (state: NeoQuestion['state']) => ({ state }) as NeoQuestion;

describe('human-facing completion conditions', () => {
  test('keeps custom wording on a todo with an assigned evidence check', () => {
    const original = todo({
      askId: 'ask',
      doneWhen: 'The human has reviewed the summary.',
      check: { pack: 'core', kind: 'evidence', params: { path: todoEvidenceFile('t') } },
    });
    const [entry] = projectNeoAskEntries(
      [{ id: 'ask', status: 'open' } as NeoAsk],
      { todos: [original], questions: [], links: new Map() },
      []
    );
    expect(entry.todos[0].doneWhen).toBe(original.doneWhen);
  });

  test.each(['assigned', 'external', 'different-todo', 'different-pack', 'no-check'])(
    'projects %s evidence without changing the stored completion',
    (kind) => {
      const path = todoEvidenceFile(kind === 'different-todo' ? 'other' : 't');
      const original = todo({
        askId: 'ask',
        doneWhen: `File ${path} exists.`,
        check:
          kind === 'no-check'
            ? null
            : {
                pack: kind === 'different-pack' ? 'custom' : 'core',
                kind: 'evidence',
                params: { path: kind === 'external' ? '/results/report.md' : path },
              },
      });
      const [entry] = projectNeoAskEntries(
        [{ id: 'ask', status: 'open' } as NeoAsk],
        { todos: [original], questions: [], links: new Map() },
        []
      );
      expect(entry.todos[0].doneWhen).toBe(kind === 'assigned' ? '' : original.doneWhen);
      expect(entry.todos[0].check).toEqual(original.check);
      expect(original.doneWhen).toContain(path);
    }
  );
});

function facts(store: NeoAskTodoRepository, sessions: NeoTodoSessionRepository, asks: NeoAsk[]) {
  const ids = asks.map((ask) => ask.id);
  const todos = store.listTodosForAsks(ids);
  return {
    todos,
    questions: store.listQuestionsForAsks(ids),
    links: sessions.readLinksForTodos(todos.map((todo) => todo.id)),
  };
}

describe('blocked todo cards', () => {
  test('show the reason over the pack line, and only an open question puts the ask in waiting', () => {
    const blocked = todo({ state: 'blocked', blockedReason: 'CI keeps failing' });
    expect(neoTodoStatusLine(blocked, [], { status: '#3 CI failing', statusCodes: [] })).toEqual({
      status: 'Blocked: CI keeps failing',
      statusCodes: [{ code: 'todo.blocked', params: { reason: 'CI keeps failing' } }],
    });
    expect(neoAskEntryState(ask(), [blocked, todo({ state: 'done' })], [])).toBe('doing');
    expect(neoAskEntryState(ask(), [blocked], [question('open')])).toBe('waiting');
  });
});

describe('neoTodoStatusLine', () => {
  const next = todo({ id: 'n', title: 'Claude Code 新会话' });
  const coded = (status: string, code: string, params: Record<string, string> = {}) => ({
    status,
    statusCodes: [{ code, params }],
  });
  const text = (status: string) => ({ status, statusCodes: [] });
  const packLine = coded('#103 open, waiting on CI', 'todo.pr.waitingCi', { pr: '#103' });

  test('a todo not started yet', () => {
    expect(neoTodoStatusLine(todo({}), [], null)).toEqual(coded('Not started', 'todo.notStarted'));
  });

  test('a todo being worked on', () => {
    expect(neoTodoStatusLine(todo({ state: 'doing' }), [], null)).toEqual(
      coded('In progress', 'todo.doing')
    );
  });

  test('a session that stopped without a check', () => {
    expect(neoTodoStatusLine(todo({ state: 'doing', report: 'r', check: null }), [], null)).toEqual(
      coded('Turn finished; waiting for Neo to check', 'todo.awaitingNeo')
    );
  });

  test('a session that reported, with a check running', () => {
    expect(
      neoTodoStatusLine(
        todo({
          state: 'doing',
          report: 'r',
          check: { pack: 'coding', kind: 'pr_merged', params: {} },
        }),
        [],
        null
      )
    ).toEqual(coded('Session reported; checking', 'todo.checking'));
  });

  test('a todo blocked on its check reads as waiting, without the words written for Neo', () => {
    const blocked = {
      state: 'blocked' as const,
      blockedReason: 'check_unmet: "Merged" has not passed.',
    };
    expect(neoTodoStatusLine(todo({ ...blocked, blockedBy: 'check' }), [], null)).toEqual(
      coded('Waiting for its result', 'todo.waitingResult')
    );
    expect(
      neoTodoStatusLine(todo({ ...blocked, blockedBy: 'needs-human' }), [], null).status
    ).toContain('check_unmet');
  });

  test('the pack line wins over the core state', () => {
    expect(neoTodoStatusLine(todo({ state: 'doing' }), [], packLine)).toEqual(packLine);
  });

  test('a done todo the session reported', () => {
    expect(neoTodoStatusLine(todo({ state: 'done', report: 'r' }), [], null)).toEqual(
      coded('Session says it is done', 'todo.reportedDone')
    );
  });

  test('a done todo with nothing reported', () => {
    expect(neoTodoStatusLine(todo({ state: 'done' }), [], null)).toEqual(
      coded('Done', 'todo.done')
    );
  });

  test('stored evidence stays as written, with no code', () => {
    expect(neoTodoStatusLine(todo({ state: 'done', evidence: '#102 已合并' }), [], null)).toEqual(
      text('#102 已合并')
    );
  });

  test('a failed todo keeps its reason, or says not done', () => {
    expect(
      neoTodoStatusLine(todo({ state: 'failed', reason: '会话停了：测试没过' }), [], packLine)
    ).toEqual(text('会话停了：测试没过'));
    expect(neoTodoStatusLine(todo({ state: 'failed' }), [], null)).toEqual(
      coded('Not done', 'todo.failed')
    );
  });

  test('a replaced todo names its replacement, with the reason when there is one', () => {
    expect(
      neoTodoStatusLine(
        todo({ state: 'removed', replacedBy: 'n', reason: 'iOS-2 在 Desktop 里' }),
        [next],
        null
      )
    ).toEqual(
      coded('Replaced by "Claude Code 新会话": iOS-2 在 Desktop 里', 'todo.replaced.reason', {
        title: 'Claude Code 新会话',
        reason: 'iOS-2 在 Desktop 里',
      })
    );
    expect(neoTodoStatusLine(todo({ state: 'removed', replacedBy: 'n' }), [next], null)).toEqual(
      coded('Replaced by "Claude Code 新会话"', 'todo.replaced', { title: 'Claude Code 新会话' })
    );
  });

  test('a removed todo keeps its reason, or says removed', () => {
    expect(neoTodoStatusLine(todo({ state: 'removed', reason: '人说不用了' }), [], null)).toEqual(
      text('人说不用了')
    );
    expect(neoTodoStatusLine(todo({ state: 'removed' }), [], null)).toEqual(
      coded('Removed', 'todo.removed')
    );
  });
});

describe('neoAskEntryState', () => {
  test('waiting beats doing, all done is done, and the ask status wins', () => {
    const doing = [todo({ state: 'doing' })];
    expect(neoAskEntryState(ask(), doing, [question('open')])).toBe('waiting');
    expect(neoAskEntryState(ask(), doing, [question('answered')])).toBe('doing');
    expect(neoAskEntryState(ask(), [todo({ state: 'done' }), todo({ state: 'removed' })], [])).toBe(
      'done'
    );
    expect(neoAskEntryState(ask(), [todo({}), todo({ state: 'done' })], [])).toBe('todo');
    expect(neoAskEntryState(ask(), [], [])).toBe('todo');
    expect(neoAskEntryState(ask('dropped'), doing, [question('open')])).toBe('dropped');
  });
});

describe('projectNeoAskEntries', () => {
  test('projects todos with their links and questions per ask', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    db.exec(
      "INSERT INTO neo_concerns (id, title, summary, context, revision, created_at, updated_at) VALUES ('p', 'P', '', '', 1, 1, 1)"
    );
    const store = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    const opened = store.openAsk({
      id: 'ask',
      projectId: 'p',
      sessionId: 'neo',
      originMessageId: null,
      title: 'iOS card',
      request: 'Redo the iOS card',
      createdAt: 1,
    });
    const row = store.addTodo(
      't1',
      'ask',
      { title: 'Rows', doneWhen: 'Merged', check: null, instruction: 'Do', named: null },
      1
    );
    sessions.create(row.id, { verb: 'send', ref: { adapter: 'hyperneo', id: 'w1' } });
    sessions.recordRef(row.id, { adapter: 'hyperneo', id: 'w1' });
    store.claimStart(row, 2);
    expect(store.listAsks('p', 10).map((item) => item.id)).toEqual(['ask']);
    expect(store.listAsks('other', 10)).toEqual([]);
    expect([store.countAsks('p'), store.countAsks('other'), store.countAsks(undefined)]).toEqual([
      1, 0, 1,
    ]);
    const [entry] = projectNeoAskEntries([opened], facts(store, sessions, [opened]), []);
    expect(entry).toMatchObject({
      state: 'doing',
      todos: [
        {
          id: 't1',
          status: 'In progress',
          statusCodes: [{ code: 'todo.doing', params: {} }],
          link: '/session/w1',
          remoteLink: null,
        },
      ],
      questions: [],
    });
  });

  test('a generated start question carries a code; Neo-written text stays as written', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const store = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    const opened = store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'iOS card',
      request: 'Redo the iOS card',
      createdAt: 1,
    });
    const draft = { doneWhen: 'Merged', check: null, instruction: 'Do', named: null };
    store.addTodo('t1', 'ask', { ...draft, title: 'Rows' }, 1);
    store.addTodo('t2', 'ask', { ...draft, title: 'Icons' }, 1);
    const ask = (id: string, startTodos: string[], text: string) =>
      store.askQuestion(
        id,
        'ask',
        {
          text,
          kind: 'start',
          options: null,
          multiple: false,
          noLabel: null,
          yesLabel: null,
          startTodos,
        },
        1
      );
    ask('q1', ['t1'], 'Start "Rows"?');
    ask('q2', ['t1', 't2'], 'Start these 2?');
    ask('q3', ['t2'], '要不要先把图标做了？');
    store.askQuestion(
      'q4',
      'ask',
      {
        text: 'Which layout?',
        kind: 'choice',
        options: ['List', 'Cards', 'Table'],
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: null,
      },
      1
    );
    const [entry] = projectNeoAskEntries([opened], facts(store, sessions, [opened]), []);
    expect(entry.questions[3]).toMatchObject({ id: 'q4', optionLabels: ['A', 'B', 'C'] });
    expect(entry.questions[0]).not.toHaveProperty('optionLabels');
    expect(entry.questions.slice(0, 3)).toMatchObject([
      {
        id: 'q1',
        text: 'Start "Rows"?',
        textCodes: [{ code: 'question.startOne', params: { title: 'Rows' } }],
      },
      {
        id: 'q2',
        text: 'Start these 2?',
        textCodes: [{ code: 'question.startMany', params: { count: '2' } }],
      },
      { id: 'q3', text: '要不要先把图标做了？' },
    ]);
    expect(entry.questions[2]).not.toHaveProperty('textCodes');
    store.updateTodo(store.getTodo('t2')!, { state: 'removed', reason: 'Not needed' }, 2);
    const [pruned] = projectNeoAskEntries([opened], facts(store, sessions, [opened]), []);
    expect(pruned.questions.find((question) => question.id === 'q2')).toMatchObject({
      startTodos: ['t1'],
      text: 'Start "Rows"?',
      textCodes: [{ code: 'question.startOne', params: { title: 'Rows' } }],
    });
  });
});

describe('projectNeoAskEntries todo order and done todos', () => {
  function seed(states: NeoTodo['state'][]) {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const store = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    const opened = store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Sidebar',
      request: 'Sort the sidebar',
      createdAt: 1,
    });
    const draft = { doneWhen: 'Merged', check: null, instruction: null, named: null };
    states.forEach((state, index) => {
      const row = store.addTodo(`t${index}`, 'ask', { ...draft, title: `T${index}` }, 1);
      if (state !== 'todo')
        store.updateTodo(
          row,
          { state, ...(state === 'blocked' ? { blockedReason: 'Stuck' } : {}) },
          2
        );
    });
    return { store, sessions, opened };
  }

  test('lists blocked, failed, doing, not started, done, then removed, and counts done todos', () => {
    const { store, sessions, opened } = seed([
      'done',
      'todo',
      'removed',
      'doing',
      'failed',
      'blocked',
      'done',
    ]);
    const [entry] = projectNeoAskEntries([opened], facts(store, sessions, [opened]), []);
    expect(entry.todos.map((todo) => todo.id)).toEqual(['t5', 't4', 't3', 't1', 't0', 't6', 't2']);
    expect(entry.doneCount).toBe(2);
    expect(entry.state).toBe('doing');
  });

  test('up to twenty done todos stay on the snapshot card while clients learn to page them', () => {
    const twenty = seed(['doing', ...Array.from({ length: 20 }, () => 'done' as const)]);
    const kept = neoSnapshotAskEntries(
      projectNeoAskEntries(
        [twenty.opened],
        facts(twenty.store, twenty.sessions, [twenty.opened]),
        []
      ),
      20
    );
    expect(kept.todoAsks[0].todos).toHaveLength(21);
    expect(kept.todoAsks[0].doneCount).toBe(20);
  });

  test('more than twenty done todos leave the snapshot card, keep their pack rows, and stay for restart', () => {
    const { store, sessions, opened } = seed([
      'doing',
      ...Array.from({ length: 21 }, () => 'done' as const),
    ]);
    const entries = projectNeoAskEntries([opened], facts(store, sessions, [opened]), []);
    expect(entries[0].todos).toHaveLength(22);
    const shown = neoSnapshotAskEntries(entries, 20);
    expect(shown.todoAsks[0].todos.map((todo) => todo.id)).toEqual(['t0']);
    expect(shown.todoAsks[0].doneCount).toBe(21);
    expect(shown.todoAsks[0].state).toBe('doing');
    expect(shown.pinned).toHaveLength(22);
    store.settleAsk(opened, 'done', 'Shipped', 3);
    const settledAsks = [store.getAsk('ask')!];
    const settled = projectNeoAskEntries(settledAsks, facts(store, sessions, settledAsks), []);
    expect(neoSnapshotAskEntries(settled).pinned).toEqual([]);
  });

  test('neo.ask.read returns an exact card and refuses missing or denied reads', async () => {
    const { store } = seed(['failed', 'done']);
    let allowed = true;
    const op = createNeoAskReadOperation(
      store,
      () => [],
      (caller) => (allowed ? { value: caller } : { reason: { ok: false, reason: 'denied' } }),
      async (todos) => [...todos]
    );
    const read = (askId: string) => op.execute(op.inputSchema.parse({ askId }), { source: 'rpc' });
    const result = await read('ask');
    expect(result).toMatchObject({ ok: true, entry: { ask: { id: 'ask' }, doneCount: 1 } });
    if (!result.ok) throw new Error(result.reason);
    expect(result.entry.todos.map((todo) => [todo.id, todo.state])).toEqual([
      ['t0', 'failed'],
      ['t1', 'done'],
    ]);
    expect(await read('missing')).toEqual({ ok: false, reason: 'not_found: no such ask.' });
    allowed = false;
    expect(await read('ask')).toEqual({ ok: false, reason: 'denied' });
  });

  test('neo.ask.doneTodos pages the done todos in list order', async () => {
    const { store, sessions } = seed(['done', 'done', 'doing', 'done', 'done']);
    const op = createNeoDoneTodosOperation(
      store,
      sessions,
      () => [],
      (caller) => ({ value: caller })
    );
    type Page =
      | { ok: true; todos: NeoTodoEntry[]; doneCount: number; nextOffset: number | null }
      | { ok: false; reason: string };
    const read = async (input: unknown) =>
      (await op.execute(op.inputSchema.parse(input), {
        source: 'mcp',
        sessionId: 'neo',
        role: 'neo',
      })) as Page;
    const first = await read({ askId: 'ask', limit: 3 });
    expect(first).toMatchObject({ ok: true, doneCount: 4, nextOffset: 3 });
    expect(first.ok && first.todos.map((todo) => [todo.id, todo.status])).toEqual([
      ['t0', 'Done'],
      ['t1', 'Done'],
      ['t3', 'Done'],
    ]);
    const second = await read({ askId: 'ask', offset: 3, limit: 3 });
    expect(second).toMatchObject({ ok: true, doneCount: 4, nextOffset: null });
    expect(second.ok && second.todos.map((todo) => todo.id)).toEqual(['t4']);
    expect(await read({ askId: 'missing' })).toEqual({
      ok: false,
      reason: 'not_found: no such ask.',
    });
  });
});

describe('neoSafeSessionLink', () => {
  test('keeps app and same-origin links and refuses scripts and other hosts', () => {
    expect(neoSafeSessionLink('/session/w', false)).toBe('/session/w');
    expect(neoSafeSessionLink('codex://threads/1', false)).toBe('codex://threads/1');
    expect(neoSafeSessionLink('https://imac/session/w', true)).toBe('https://imac/session/w');
    for (const link of ['javascript:alert(1)', '//evil.com/x', '/a\\b', 'https://imac/x'])
      expect(neoSafeSessionLink(link, false)).toBeNull();
    expect(neoSafeSessionLink('/session/w', true)).toBeNull();
  });
});

describe('NeoTodoSessionRepository.readLinks', () => {
  test('never offers a local session path for a session on another daemon', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const store = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    store.openAsk({
      id: 'a',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'a',
      request: 'a',
      createdAt: 1,
    });
    store.addTodo(
      't',
      'a',
      { title: 't', doneWhen: 'd', check: null, instruction: 'i', named: null },
      1
    );
    sessions.create('t', { verb: 'send', ref: { adapter: 'hyperneo', id: 'w', daemon: 'imac' } });
    sessions.recordRef('t', { adapter: 'hyperneo', id: 'w', daemon: 'imac' }, 1, '/session/w');
    expect(sessions.readLinks('t')).toMatchObject({ link: null, remoteLink: null });
    sessions.recordLive('t', 'running', undefined, 'https://imac/session/w');
    expect(sessions.readLinks('t')).toMatchObject({
      link: 'https://imac/session/w',
      remoteLink: 'https://imac/session/w',
    });
  });

  test('sends a Claude Desktop session its claude:// link and its https link apart', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const store = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    store.openAsk({
      id: 'a',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'a',
      request: 'a',
      createdAt: 1,
    });
    store.addTodo(
      't',
      'a',
      { title: 't', doneWhen: 'd', check: null, instruction: 'i', named: null },
      1
    );
    const ref = { adapter: 'claude-desktop', id: 'local_1' };
    sessions.create('t', { verb: 'send', ref });
    sessions.recordRef('t', ref, 1, 'claude://resume?session=local_1');
    expect(sessions.readLinks('t')).toMatchObject({
      link: 'claude://resume?session=local_1',
      remoteLink: null,
    });
    sessions.recordLive(
      't',
      'running',
      'claude://resume?session=local_1',
      'https://claude.ai/code/session_01abc'
    );
    expect(sessions.readLinks('t')).toMatchObject({
      link: 'claude://resume?session=local_1',
      remoteLink: 'https://claude.ai/code/session_01abc',
    });
    sessions.recordLive('t', 'running', undefined, 'claude://other');
    expect(sessions.readLinks('t').remoteLink).toBeNull();
  });
});

describe('neoWorkCounts', () => {
  test('counts a todo waiting on a cancelled prerequisite once', () => {
    const stalled = {
      id: 'both',
      askId: 'a',
      state: 'blocked',
      blockedBy: 'stalled',
      startedAt: 5,
    } as const;
    expect(neoWorkCounts([stalled], [], [{ id: 'both' }, { id: 'waiting' }])).toEqual({
      needsYou: 0,
      neoUnhandled: 2,
    });
  });

  test('counts open asks by who holds them, across projects and past the list limit', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const store = new NeoAskTodoRepository(db);
    const draft = { doneWhen: 'Merged', check: null, instruction: 'Do', named: null };
    const ask = (
      id: string,
      blockedBy: NeoTodo['blockedBy'],
      cards: number,
      cardTodo: string | null = null,
      text = 'Which one?'
    ) => {
      store.openAsk({
        id,
        projectId: null,
        sessionId: 'neo',
        originMessageId: null,
        title: id,
        request: id,
        createdAt: 1,
      });
      const row = store.addTodo(`${id}-t`, id, { ...draft, title: id }, 1);
      if (blockedBy) store.updateTodo(row, { state: 'blocked', blockedBy }, 2);
      for (let card = 0; card < cards; card += 1)
        store.askQuestion(
          `${id}-q${card}`,
          id,
          {
            text,
            kind: 'reply',
            options: null,
            multiple: false,
            noLabel: null,
            yesLabel: null,
            startTodos: null,
            todoId: cardTodo,
          },
          2
        );
    };
    ask('two-cards', null, 2);
    ask('carded', 'needs-human', 1, 'carded-t');
    ask('needs-neo', 'needs-human', 0);
    ask('stalled', 'stalled', 0);
    ask('environment', 'environment', 0);
    ask('stalled-carded', 'stalled', 1, 'stalled-carded-t', `T${NEO_TODO_STALLED_CARD_TAIL}`);
    ask('held', 'held', 0);
    ask('check', 'check', 0);
    ask('running', null, 0);
    ask('settled', 'needs-human', 1);
    store.addTodo('other-todo', 'carded', { ...draft, title: 'Other' }, 1);
    store.updateTodo(
      store.getTodo('other-todo')!,
      { state: 'blocked', blockedBy: 'needs-human' },
      2
    );
    store.settleAsk(store.getAsk('settled')!, 'dropped', 'Not needed', 3);
    const { openWork } = store.snapshot(undefined, 1, true);
    expect(neoWorkCounts(openWork.todos, openWork.questions, openWork.awaitingNeo)).toEqual({
      needsYou: 3,
      neoUnhandled: 4,
    });
    const scoped = store.snapshot('another-project', 1, true).openWork;
    expect(neoWorkCounts(scoped.todos, scoped.questions, scoped.awaitingNeo)).toEqual({
      needsYou: 3,
      neoUnhandled: 4,
    });
  });
});

describe('worker labels', () => {
  test.each([
    ['codex-desktop', 'Codex'],
    ['claude-code', 'Claude'],
    ['claude-desktop', 'Claude'],
    ['copilot-cli', 'Copilot'],
    ['copilot', 'Copilot'],
    ['opencode', 'OpenCode'],
    ['hyperneo', 'HyperNeo'],
    ['space', 'Space'],
    ['future-adapter', 'future-adapter'],
    ['__proto__', '__proto__'],
  ])('%s uses its adapter, irrespective of the name', (adapter, engine) => {
    expect(workerIdentity({ adapter, id: 'stable' }, 'Claude something')).toEqual({
      adapter,
      id: 'stable',
      name: 'Claude something',
      label: `${engine} · Claude something`,
    });
    expect(workerIdentity({ adapter, id: 'stable' }, null).label).toBe(`${engine} · stable`);
  });
});
