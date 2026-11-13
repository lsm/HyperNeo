import { existingTodoTarget } from '../../helpers/todo-check-packs.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { wireNeoTodoMutations } from '../../../../src/lib/neo/todo-mutation-operation.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTodoCheckPacks } from '../../helpers/todo-check-packs.ts';

type Receipt = { ok: false; reason: string } | { ok: true; todo: NeoTodo; records?: string[] };
describe('Writer-backed todo operation activation', () => {
  let db: Database;
  let store: NeoAskTodoRepository;
  let gateway: DbGateway;
  let order: string[];
  let duringStop: () => void;
  let stopFailure: string | null;
  let checkDone: boolean;
  let workerRemotes: string[] | undefined;
  let advance: () => Promise<unknown>;
  let call: (name: string, input: object, role?: 'neo' | 'direct_task_worker') => Promise<Receipt>;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    store = new NeoAskTodoRepository(db);
    gateway = new DbGateway(':memory:', db);
    order = [];
    duringStop = () => {};
    stopFailure = null;
    checkDone = true;
    workerRemotes = undefined;
    gateway.onChanges = () => {
      order.push('commit');
    };
    const packs = createTodoCheckPacks(db);
    packs.find((pack) => pack.id === 'coding')!.todos!.check = async () => ({
      done: checkDone,
      evidence: null,
    });
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Atomic operations',
      request: 'Commit first',
      createdAt: 1,
    });
    for (const id of ['first', 'peer'])
      store.addTodo(
        id,
        'ask',
        {
          approvedAt: 1,
          title: id,
          doneWhen: 'Merged',
          check: { pack: 'coding', kind: 'pr_merged', params: { urls: [] } },
          instruction: id === 'peer' ? 'Next task' : null,
          named: null,
        },
        1
      );
    const stop = async () => {
      order.push('stop');
      duringStop();
      return stopFailure;
    };
    const start = async (id: string) => {
      order.push(`start:${id}`);
      expect(store.getTodo('first')!.state).toBe('done');
      store.updateTodo(store.getTodo(id)!, { state: 'doing', startedAt: 3 }, 3);
      return { ok: true as const, todo: store.getTodo(id)! };
    };
    advance = () => start('peer');
    const legacy = createNeoTodoOperations(
      store,
      new NeoTodoSessionRepository(db),
      {
        resolveTarget: existingTodoTarget,
        recompute: async () => {
          throw new Error('Legacy mutation write was called');
        },
        advance: async () => {},
        stop,
        proceed: async () => ({ ok: false as const, reason: 'unused' }),
        retry: async () => ({ ok: false as const, reason: 'unused' }),
      },
      () => packs,
      () => null
    );
    const registry = createOperationRegistry(
      wireNeoTodoMutations(legacy, {
        gateway,
        write: gateway.run.bind(gateway),
        packs: () => packs,
        artifact: () => null,
        stop,
        resolveTarget: async (ref) => ({ value: ref, workerRemotes }),
        advance: () => advance(),
        changed: () => {
          order.push('announce');
        },
        project: async (todos) => todos.map((todo) => ({ ...todo, worker: null })),
      })
    );
    call = async (name, input, role = 'neo') => {
      const result = await invokeOperation(registry, name, input, {
        source: 'mcp',
        sessionId: 'neo',
        role,
      });
      if (result.kind !== 'completed') throw new Error(result.message);
      expect(result.kind).toBe('completed');
      return result.value as Receipt;
    };
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });

  test('an edit introducing a coding check refuses an unknown worker repository before commit', async () => {
    const current = store.updateTodo(
      store.getTodo('first')!,
      {
        check: { pack: 'core', kind: 'evidence', params: { path: '/synthetic/pending' } },
      },
      2
    );
    order.length = 0;
    expect(
      await call('neo.todo.edit', {
        todoId: current.id,
        check: {
          pack: 'coding',
          kind: 'pr_merged',
          params: { urls: ['https://github.com/example/repo/pull/1'] },
        },
        instruction: 'Implement the change',
        target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'worker' } },
      })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/^worker_repository_mismatch:/) });
    expect(store.getTodo(current.id)).toEqual(current);
    expect(new NeoTodoSessionRepository(db).get(current.id)).toBeNull();
    expect(order).toEqual([]);
  });

  test('a repo-less edit inherits its sibling repository and requires a start place', async () => {
    db.prepare('UPDATE pack_coding_todos SET repo = ? WHERE todo_id = ?').run(
      'github.com/example/repo',
      'peer'
    );
    const before = store.getTodo('first');
    expect(
      await call('neo.todo.edit', {
        todoId: 'first',
        instruction: 'Implement the change',
        target: { verb: 'start', adapter: 'hyperneo' },
      })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/^place_required:/) });
    expect(store.getTodo('first')).toEqual(before);
    expect(new NeoTodoSessionRepository(db).get('first')).toBeNull();
    expect(order).toEqual([]);
  });

  test('edited check clues take precedence over a historical ask repository', async () => {
    db.prepare('UPDATE neo_asks SET repo = ? WHERE id = ?').run('github.com/example/old', 'ask');
    workerRemotes = ['https://github.com/example/new.git'];
    advance = async () => undefined;
    expect(
      await call('neo.todo.edit', {
        todoId: 'first',
        instruction: 'Implement the change',
        check: {
          pack: 'coding',
          kind: 'pr_merged',
          params: { urls: ['https://github.com/example/new/pull/1'] },
        },
        target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'worker' } },
      })
    ).toMatchObject({ ok: true });
    expect(new NeoTodoSessionRepository(db).get('first')).toMatchObject({ verb: 'send' });
  });

  test('edit uses the atomic command and returns the entire committed report', async () => {
    const text = 'Complete report 🦊\n'.repeat(20000).trim();
    expect(
      await call('neo.todo.edit', { todoId: 'first', done: 'reported', evidence: text })
    ).toMatchObject({ ok: true, todo: { state: 'done', report: text } });
    expect(order.slice(0, 2)).toEqual(['commit', 'announce']);
  });

  test('a todo change returns only the changed todo', async () => {
    const result = await call('neo.todo.hold', { todoId: 'first', reason: 'Human said wait.' });
    expect(result).toMatchObject({ ok: true, todo: { id: 'first', state: 'blocked' } });
    expect(JSON.stringify(result)).not.toContain('Next task');
    expect('todos' in result).toBe(false);
  });

  test('hold holds and releases through the atomic command', async () => {
    expect(
      await call('neo.todo.hold', { todoId: 'peer', reason: 'Human said wait.' })
    ).toMatchObject({
      ok: true,
      todo: { id: 'peer', state: 'blocked', blockedBy: 'held', blockedReason: 'Human said wait.' },
    });
    expect(await call('neo.todo.hold', { todoId: 'peer', reason: null })).toMatchObject({
      ok: true,
      todo: { id: 'peer', state: 'todo', blockedBy: null },
    });
    expect(order).toEqual(['commit', 'announce', 'commit', 'announce']);
  });

  test('close stops first, commits, then lets the queue start the successor', async () => {
    const result = await call('neo.todo.close', { todoId: 'first', reason: 'Finished' });
    expect(result).toMatchObject({ ok: true, todo: { state: 'done' } });
    expect(order).toEqual(['stop', 'commit', 'announce', 'start:peer']);
    expect(store.getTodo('peer')?.state).toBe('doing');
  });

  test('close refuses a never-started todo whose check has not passed and points to remove', async () => {
    checkDone = false;
    const before = store.getTodo('first')!;
    const result = await call('neo.todo.close', { todoId: 'first', reason: 'Never started' });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('neo.todo.remove') });
    expect(store.getTodo('first')).toEqual(before);
    expect(order).toEqual([]);
  });

  test('done marks a never-started todo with an unmet check done, with no reason, and its dependent starts', async () => {
    checkDone = false;
    const result = await call('neo.todo.done', { todoId: 'first' });
    expect(result).toMatchObject({
      ok: true,
      todo: { id: 'first', state: 'done', startedAt: null, evidence: null, blockedBy: null },
    });
    expect(order).toEqual(['stop', 'commit', 'announce', 'start:peer']);
    expect(store.getTodo('peer')?.state).toBe('doing');
  });

  test('done is not refused by an open card or a block on the human; its own card retires and a shared card stays open', async () => {
    checkDone = false;
    const card = {
      kind: 'reply' as const,
      options: null,
      multiple: false,
      yesLabel: null,
      noLabel: null,
      startTodos: null,
    };
    expect(
      store.askQuestion('shared', 'ask', { ...card, text: 'Which release?' }, 2).todos
    ).toEqual(['first', 'peer']);
    store.askQuestion('own', 'ask', { ...card, text: 'Answer first', todoId: 'first' }, 2);
    store.updateTodo(store.getTodo('first')!, { state: 'doing', startedAt: 2 }, 2);
    store.updateTodo(
      store.getTodo('first')!,
      { state: 'blocked', blockedBy: 'needs-human', blockedReason: 'Answer first' },
      3
    );
    expect(store.getTodo('first')).toMatchObject({ state: 'blocked', blockedBy: 'needs-human' });
    expect(
      await call('neo.todo.done', { todoId: 'first', reason: 'No longer needed' })
    ).toMatchObject({
      ok: true,
      todo: { state: 'done', evidence: 'No longer needed', blockedBy: null },
    });
    expect(store.getQuestion('own')?.state).toBe('retired');
    expect(store.getQuestion('shared')?.state).toBe('open');
    expect(order.slice(0, 2)).toEqual(['stop', 'commit']);
  });

  test('a block on the human under an open ask-level card still holds the legacy close, and done clears it', async () => {
    store.askQuestion(
      'shared',
      'ask',
      {
        kind: 'reply',
        text: 'Which release?',
        options: null,
        multiple: false,
        yesLabel: null,
        noLabel: null,
        startTodos: null,
      },
      2
    );
    store.updateTodo(store.getTodo('first')!, { state: 'doing', startedAt: 2 }, 2);
    store.updateTodo(
      store.getTodo('first')!,
      { state: 'blocked', blockedBy: 'needs-human', blockedReason: 'Answer first' },
      3
    );
    expect(await call('neo.todo.close', { todoId: 'first', reason: 'Finished' })).toMatchObject({
      ok: true,
      todo: { state: 'blocked', blockedBy: 'needs-human' },
    });
    expect(await call('neo.todo.done', { todoId: 'first' })).toMatchObject({
      ok: true,
      todo: { state: 'done', blockedBy: null },
    });
    expect(store.getQuestion('shared')?.state).toBe('open');
  });

  test('done leaves a removed todo as it is', async () => {
    await call('neo.todo.remove', { todoId: 'first', reason: 'Cancelled' });
    order.length = 0;
    expect(await call('neo.todo.done', { todoId: 'first' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('todo_not_live:'),
    });
    expect(store.getTodo('first')!.state).toBe('removed');
    expect(order).toEqual([]);
  });

  test('close of a started todo whose check has not passed still waits on the check', async () => {
    checkDone = false;
    store.updateTodo(store.getTodo('first')!, { state: 'doing', startedAt: 2 }, 2);
    expect(await call('neo.todo.close', { todoId: 'first', reason: 'Finished' })).toMatchObject({
      ok: true,
      todo: { state: 'blocked', blockedBy: 'check' },
    });
  });

  test('remove cancels a never-started todo whose check has not passed', async () => {
    checkDone = false;
    expect(
      await call('neo.todo.remove', { todoId: 'first', reason: 'Never started' })
    ).toMatchObject({ ok: true, todo: { state: 'removed', reason: 'Never started' } });
  });

  test('a new human card during stop prevents the final completion write', async () => {
    duringStop = () => {
      store.askQuestion(
        'reply',
        'ask',
        {
          kind: 'reply',
          todoId: 'first',
          text: 'Answer first',
          options: null,
          multiple: false,
          yesLabel: null,
          noLabel: null,
        },
        2
      );
    };
    expect(await call('neo.todo.close', { todoId: 'first', reason: 'Finished' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('card_unanswered:'),
    });
    expect(store.getTodo('first')!.state).toBe('todo');
    expect(order).toEqual(['stop']);
  });

  test('a check changed during stop cannot use the prior passed completion', async () => {
    duringStop = () => {
      store.updateTodo(
        store.getTodo('first')!,
        { check: { pack: 'core', kind: 'evidence', params: { path: '/synthetic/new-check' } } },
        2
      );
    };
    expect(await call('neo.todo.close', { todoId: 'first', reason: 'Finished' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('todo_changed:'),
    });
    expect(order).toEqual(['stop']);
  });

  test('a failed stop leaves the todo unchanged without announcing or dispatching', async () => {
    stopFailure = 'stop_failed: driver offline';
    expect(await call('neo.todo.remove', { todoId: 'first', reason: 'Replaced' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('stop_failed:'),
    });
    expect(store.getTodo('first')!.state).toBe('todo');
    expect(order).toEqual(['stop']);
  });

  test('remove commits the retired todo only after its stop succeeds', async () => {
    store.updateTodo(store.getTodo('first')!, { state: 'done' }, 2);
    expect(await call('neo.todo.remove', { todoId: 'peer', reason: 'Replaced' })).toMatchObject({
      ok: true,
      todo: { state: 'removed', reason: 'Replaced' },
    });
    expect(order).toEqual(['stop', 'commit', 'announce']);
  });

  test('a settled ask stays a successful no-op without stop, announce or dispatch', async () => {
    store.settleAsk(store.getAsk('ask')!, 'done', 'Human settled it', 2);
    expect(await call('neo.todo.close', { todoId: 'first', reason: 'Ignored' })).toMatchObject({
      ok: true,
      todo: { worker: null },
      records: [expect.stringContaining('ask_settled:')],
    });
    expect(order).toEqual([]);
  });

  test('a SQL failure never announces a successful mutation', async () => {
    db.exec(
      "CREATE TRIGGER refuse_ask_touch BEFORE UPDATE ON neo_asks BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END"
    );
    await expect(call('neo.todo.edit', { todoId: 'first', title: 'Ignored' })).rejects.toThrow();
    expect(store.getTodo('first')!.title).toBe('first');
    expect(order).toEqual([]);
  });
});
