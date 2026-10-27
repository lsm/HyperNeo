import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type {
  NeoPack,
  NeoTodoCheckResult,
  NeoTodoJudgement,
} from '../../../../src/lib/neo/pack-contract.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const check = (url: string) => ({ pack: 'coding', kind: 'pr_merged', params: { urls: [url] } });
const merged: NeoTodoCheckResult = { done: true, evidence: '#1 merged' };
const BROAD_SCAN_MS = 8;

function setup(result: NeoTodoCheckResult = merged, judgement?: NeoTodoJudgement) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  const store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: 'm1',
    title: 'Card',
    request: 'Ship it',
    createdAt: 1,
  });
  let during: (todo: NeoTodo) => void = () => {};
  const pack = {
    id: 'coding',
    describe: 'coding',
    instructions: () => null,
    ...(judgement ? { readFacts: async () => null, judge: () => judgement } : {}),
    todos: {
      schema: () => {},
      check: async (todo: NeoTodo) => {
        during(todo);
        return result;
      },
      statusLine: () => null,
    },
  } satisfies NeoPack;
  const told: string[] = [];
  const runner = createNeoTodoRunner({
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    store,
    sessions: new NeoTodoSessionRepository(db),
    invoke: async () => ({ kind: 'completed', value: null }) as OperationOutcome,
    packs: () => [pack],
    tell: async (_ask, _todo, note) => {
      told.push(note);
    },
    changed: () => {},
  });
  const add = (url = 'https://github.com/o/r/pull/1') => {
    const todo = store.addTodo(
      crypto.randomUUID(),
      'ask',
      {
        title: 'Ship',
        doneWhen: 'Merged',
        check: check(url),
        instruction: 'Ship it.',
        named: null,
      },
      1
    );
    return store.updateTodo(todo, { state: 'doing', startedAt: 1 }, 1);
  };
  return {
    db,
    store,
    runner,
    told,
    add,
    whileChecking: (fn: (todo: NeoTodo) => void) => {
      during = fn;
    },
  };
}

describe('a todo check revalidates the one todo it checked', () => {
  test('a refresh over 231 checked todos stays inside the 250 ms lag budget when a broad scan is slow', async () => {
    const { store, runner, add } = setup({ done: false, evidence: null });
    for (let i = 0; i < 231; i++) add(`https://github.com/o/r/pull/${i}`);
    const listCheckable = store.listCheckable.bind(store);
    store.listCheckable = () => {
      const until = performance.now() + BROAD_SCAN_MS;
      while (performance.now() < until);
      return listCheckable();
    };
    const started = performance.now();
    await runner.refresh(() => {});
    expect(performance.now() - started).toBeLessThan(250);
  });

  test.each(['todo', 'doing', 'blocked', 'failed', 'closed_unverified'] as const)(
    'a passing custom check completes a %s todo on refresh',
    async (state) => {
      const { store, runner, add } = setup();
      const todo = add();
      store.updateTodo(todo, { state }, 2);
      await runner.refresh(() => {});
      expect(store.getTodo(todo.id)).toMatchObject({ state: 'done', evidence: '#1 merged' });
    }
  );

  test.each(['failed', 'closed_unverified'] as const)(
    'an unmet custom check preserves the %s state',
    async (state) => {
      const { store, runner, add } = setup({ done: false, evidence: null });
      const todo = add();
      store.updateTodo(todo, { state }, 2);
      await runner.refresh(() => {});
      expect(store.getTodo(todo.id)?.state).toBe(state);
    }
  );

  test('an unchanged todo takes the result of its check', async () => {
    const { store, runner, add } = setup();
    const todo = add();
    await runner.refresh(() => {});
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'done', evidence: '#1 merged' });
  });

  test.each(['failed', 'closed_unverified'] as const)(
    'non-passing judgements preserve the complete %s todo without a failure notice',
    async (state) => {
      for (const judgement of [
        { state: 'no_opinion' },
        { state: 'failed', reason: 'Closed without replacement' },
        { state: 'blocked', reason: 'Waiting for a replacement' },
      ] satisfies NeoTodoJudgement[]) {
        const { store, runner, told, add } = setup(merged, judgement);
        const todo = add();
        store.updateTodo(todo, { state, reason: 'Original outcome', finishedAt: 2 }, 2);
        const before = store.getTodo(todo.id);
        await runner.refresh((_message, error) => {
          throw error;
        });
        expect(store.getTodo(todo.id)).toEqual(before);
        expect(told).toEqual([]);
      }
    }
  );

  test.each(['failed', 'closed_unverified'] as const)(
    'a passing judgement still completes a %s todo',
    async (state) => {
      const { store, runner, add } = setup(merged, { state: 'done', evidence: 'Merged' });
      const todo = add();
      store.updateTodo(todo, { state }, 2);
      await runner.refresh((_message, error) => {
        throw error;
      });
      expect(store.getTodo(todo.id)).toMatchObject({ state: 'done', evidence: 'Merged' });
    }
  );

  test('a todo removed while its check runs keeps its removal', async () => {
    const { store, runner, told, add, whileChecking } = setup();
    const todo = add();
    whileChecking((checked) =>
      store.updateTodo(store.getTodo(checked.id)!, { state: 'removed', reason: 'Not needed' }, 2)
    );
    await runner.refresh(() => {});
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'removed', evidence: null });
    expect(told).toEqual([]);
  });

  test('a todo whose ask closes while its check runs is not finished', async () => {
    const { db, store, runner, add, whileChecking } = setup();
    const todo = add();
    whileChecking(() => db.prepare("UPDATE neo_asks SET status = 'done' WHERE id = 'ask'").run());
    await runner.refresh(() => {});
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'doing', evidence: null });
  });

  test('a todo whose check is edited while the old check runs ignores the old result', async () => {
    const { db, store, runner, add, whileChecking } = setup();
    const todo = add();
    whileChecking((checked) =>
      db
        .prepare('UPDATE neo_todos SET check_json = ? WHERE id = ?')
        .run(JSON.stringify(check('https://github.com/o/r/pull/2')), checked.id)
    );
    await runner.refresh(() => {});
    expect(store.getTodo(todo.id)).toMatchObject({ state: 'doing', evidence: null });
  });
});
