import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import {
  neoAskEntryState,
  neoTodoStatusLine,
  projectNeoAskEntries,
} from '../../../../src/lib/neo/ask-entries.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { fitNeoSnapshotBudget } from '../../../../src/lib/neo/snapshot-compact.ts';
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

describe('neoTodoStatusLine', () => {
  test('says each state in one line, the pack line first', () => {
    const next = todo({ id: 'n', title: 'Claude Code 新会话' });
    expect(neoTodoStatusLine(todo({}), [], null)).toBe('没开始');
    expect(neoTodoStatusLine(todo({ state: 'doing' }), [], null)).toBe('在做');
    expect(neoTodoStatusLine(todo({ state: 'doing', report: 'r' }), [], null)).toBe(
      '会话回报了，正在检查'
    );
    expect(neoTodoStatusLine(todo({ state: 'doing' }), [], '#103 开着，等 CI')).toBe(
      '#103 开着，等 CI'
    );
    expect(neoTodoStatusLine(todo({ state: 'done', report: 'r' }), [], null)).toBe('会话说做完了');
    expect(neoTodoStatusLine(todo({ state: 'done', evidence: '#102 已合并' }), [], null)).toBe(
      '#102 已合并'
    );
    expect(
      neoTodoStatusLine(todo({ state: 'failed', reason: '会话停了：测试没过' }), [], 'x')
    ).toBe('会话停了：测试没过');
    expect(
      neoTodoStatusLine(
        todo({ state: 'removed', replacedBy: 'n', reason: 'iOS-2 在 Desktop 里' }),
        [next],
        null
      )
    ).toBe('换成「Claude Code 新会话」——iOS-2 在 Desktop 里');
    expect(neoTodoStatusLine(todo({ state: 'removed', reason: '人说不用了' }), [], null)).toBe(
      '人说不用了'
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
    const [entry] = projectNeoAskEntries([opened], store, sessions, []);
    expect(entry).toMatchObject({
      state: 'doing',
      todos: [{ id: 't1', status: '在做', link: '/session/w1' }],
      questions: [],
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
        },
      ],
      questions: [],
    });
    const snapshot: NeoSnapshot = {
      ok: true,
      sessionId: 'neo',
      projects: [],
      consultations: [],
      work: [],
      cards: [],
      askViews: [],
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
  });
});

describe('NeoTodoSessionRepository.readLink', () => {
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
    expect(sessions.readLink('t')).toBeNull();
    sessions.recordLive('t', 'running', undefined, 'https://imac/session/w');
    expect(sessions.readLink('t')).toBe('https://imac/session/w');
  });
});
