import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoAskEntry, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import {
  neoAskEntryState,
  neoTodoStatusLine,
  projectNeoAskEntries,
} from '../../../../src/lib/neo/ask-entries.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import {
  NeoTodoSessionRepository,
  neoSafeSessionLink,
} from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import {
  fitNeoSnapshotBudget,
  neoSnapshotOmitted,
} from '../../../../src/lib/neo/snapshot-compact.ts';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';

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

describe('blocked todo cards', () => {
  test('show the reason over the pack line and put the ask in waiting', () => {
    const blocked = todo({ state: 'blocked', blockedReason: 'CI keeps failing' });
    expect(neoTodoStatusLine(blocked, [], { status: '#3 CI failing', statusCodes: [] })).toEqual({
      status: 'Blocked: CI keeps failing',
      statusCodes: [{ code: 'todo.blocked', params: { reason: 'CI keeps failing' } }],
    });
    expect(neoAskEntryState(ask(), [blocked, todo({ state: 'done' })], [])).toBe('waiting');
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
    const [entry] = projectNeoAskEntries([opened], store, sessions, []);
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
    const [entry] = projectNeoAskEntries([opened], store, sessions, []);
    expect(entry.questions).toMatchObject([
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
    const [pruned] = projectNeoAskEntries([opened], store, sessions, []);
    expect(pruned.questions.find((question) => question.id === 'q2')).toMatchObject({
      startTodos: ['t1'],
      text: 'Start "Rows"?',
      textCodes: [{ code: 'question.startOne', params: { title: 'Rows' } }],
    });
  });
});

describe('fitNeoSnapshotBudget with todoAsks', () => {
  test('drops settled asks and trims todo text instead of dropping the field', () => {
    const entry = (id: string, status: NeoAsk['status']) => ({
      ask: {
        id,
        projectId: null,
        sessionId: 'neo',
        originMessageId: null,
        title: id,
        request: 'r'.repeat(2000),
        status,
        outcome: null,
        createdAt: 1,
        updatedAt: 1,
        settledAt: null,
      },
      state: 'doing' as const,
      todos: [
        {
          ...todo({ id: `${id}-t`, state: 'doing' }),
          askId: id,
          position: 0,
          doneWhen: 'Merged',
          check: null,
          instruction: 'i'.repeat(4000),
          named: null,
          replacedBy: null,
          addedAfterStart: false,
          createdAt: 1,
          updatedAt: 1,
          startedAt: 1,
          finishedAt: null,
          status: '在做',
          link: null,
          remoteLink: null,
        },
      ],
      questions: [],
    });
    const snapshot: NeoSnapshot = {
      ok: true,
      sessionId: 'neo',
      projects: [],
      todoAsks: [
        ...Array.from({ length: 20 }, (_, index) => entry(`open-${index}`, 'open')),
        entry('settled', 'done'),
      ],
    };
    const fitted = fitNeoSnapshotBudget(snapshot, 40_000);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(40_000);
    expect(fitted.todoAsks?.length).toBeGreaterThan(0);
    expect(fitted.todoAsks?.some((item) => item.ask.id === 'settled')).toBe(false);
    expect(fitted.todoAsks?.[0].todos[0].instruction?.length).toBeLessThanOrEqual(300);
    const dropped = 21 - (fitted.todoAsks?.length ?? 0);
    expect(neoSnapshotOmitted(fitted, snapshot).omitted).toEqual({ asks: dropped });
    if (dropped > 1) expect(fitted.trimmed).toContain('this is not every open ask');
  });

  test('omitted also counts the asks the listing left out', () => {
    const listed: NeoSnapshot = {
      ok: true,
      sessionId: 'neo',
      projects: [],
      todoAsks: [],
      omitted: { asks: 4 },
    };
    expect(neoSnapshotOmitted(listed, listed).omitted).toEqual({ asks: 4 });
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
    expect(sessions.readLinks('t')).toEqual({ link: null, remoteLink: null });
    sessions.recordLive('t', 'running', undefined, 'https://imac/session/w');
    expect(sessions.readLinks('t')).toEqual({
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
    expect(sessions.readLinks('t')).toEqual({
      link: 'claude://resume?session=local_1',
      remoteLink: null,
    });
    sessions.recordLive(
      't',
      'running',
      'claude://resume?session=local_1',
      'https://claude.ai/code/session_01abc'
    );
    expect(sessions.readLinks('t')).toEqual({
      link: 'claude://resume?session=local_1',
      remoteLink: 'https://claude.ai/code/session_01abc',
    });
    sessions.recordLive('t', 'running', undefined, 'claude://other');
    expect(sessions.readLinks('t').remoteLink).toBeNull();
  });
});

describe('fitNeoSnapshotBudget with packRows', () => {
  test('halves pack rows to fit instead of dropping the asks', () => {
    const snapshot: NeoSnapshot = {
      ok: true,
      sessionId: 'neo',
      projects: [],
      packRows: [
        {
          pack: 'coding',
          rows: Array.from({ length: 100 }, (_, index) => ({
            pr: `lsm/hyperneo#${index}`,
            title: 't'.repeat(400),
            state: 'waiting_review',
          })),
        },
      ],
    };
    snapshot.packRows?.push({ ...snapshot.packRows[0], pack: 'other' });
    const fitted = fitNeoSnapshotBudget(snapshot, 20_000);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(20_000);
    expect(fitted.packRows?.[1].rows.length).toBe(fitted.packRows?.[0].rows.length);
    expect(fitted.packRows?.[0].rows.length).toBeGreaterThan(0);
    expect(fitted.packRows?.[0].rows.length).toBeLessThan(100);
    expect(fitted.packRows?.[0].rows[0].pr).toBe('lsm/hyperneo#0');
  });

  test("keeps an open todo's PR rows while it halves the other rows and the asks", () => {
    const rows = (count: number, todoId?: string) =>
      Array.from({ length: count }, (_, index) => ({
        pr: `lsm/hyperneo#${todoId ? 1000 + index : index}`,
        title: 't'.repeat(80),
        state: 'waiting_review',
        ...(todoId ? { todoId } : {}),
      }));
    const ask = (n: number) =>
      ({
        ask: { id: `ask-${n}`, title: 'Ship', request: 'r'.repeat(5_000), status: 'open' },
        state: 'doing',
        todos: Array.from({ length: 20 }, (_, index) => ({
          id: `todo-${n}-${index}`,
          title: 'Fix',
          doneWhen: 'Merged',
          status: 's'.repeat(2_000),
        })),
        questions: [],
      }) as unknown as NeoAskEntry;
    const snapshot: NeoSnapshot = {
      ok: true,
      sessionId: 'neo',
      projects: [],
      todoAsks: Array.from({ length: 40 }, (_, n) => ask(n)),
      packRows: [{ pack: 'coding', rows: [...rows(3, 'todo-0-0'), ...rows(100)] }],
    };
    const halved = fitNeoSnapshotBudget({ ...snapshot, todoAsks: [ask(0)] }, 20_000);
    expect(halved.packRows?.[0].rows.filter((row) => row.todoId).length).toBe(3);
    expect(halved.packRows?.[0].rows.length).toBeLessThan(103);
    const trimmed = fitNeoSnapshotBudget(snapshot, 20_000);
    expect(trimmed.todoAsks?.length).toBeLessThan(40);
    expect(trimmed.packRows?.[0].rows.filter((row) => row.todoId).map((row) => row.pr)).toEqual([
      'lsm/hyperneo#1000',
      'lsm/hyperneo#1001',
      'lsm/hyperneo#1002',
    ]);
  });
});
