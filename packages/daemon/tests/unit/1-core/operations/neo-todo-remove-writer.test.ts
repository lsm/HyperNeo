import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoPack } from '../../../../src/lib/neo/pack-contract.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

describe('Neo todo removal commits through the writer', () => {
  let directory: string;
  let main: Database;
  let writer: Database;
  let gateway: DbGateway;
  let store: NeoAskTodoRepository;
  let sessions: NeoTodoSessionRepository;
  let stopping: () => Promise<void>;
  let refused: boolean;
  let stops: string[];
  let announcements: number;
  let onChanged: () => void;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'neo-finalize-'));
    const file = join(directory, 'synthetic.db');
    writer = new Database(file);
    runMigrations(writer, () => {});
    createTables(writer);
    createCodingPackTables(writer);
    main = new Database(file);
    gateway = new DbGateway(':memory:', writer);
    bindGateway(main, gateway);
    store = new NeoAskTodoRepository(writer);
    sessions = new NeoTodoSessionRepository(writer);
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Finish',
      request: 'Atomic close/remove',
      createdAt: 1,
    });
    stopping = async () => {};
    refused = false;
    stops = [];
    announcements = 0;
    onChanged = () => {};
  });
  afterEach(async () => {
    await gateway.close();
    main.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const add = (id: string) => {
    const todo = store.addTodo(
      id,
      'ask',
      {
        title: id,
        doneWhen: 'Merged',
        check: {
          pack: 'coding',
          kind: 'pr_merged',
          params: { urls: ['https://github.com/synthetic/finalize/pull/1'] },
        },
        instruction: 'Ship',
        named: null,
      },
      1
    );
    const ref = { adapter: 'hyperneo', id: `worker-${id}` };
    sessions.create(id, { verb: 'send', ref });
    sessions.recordRef(id, ref, 2);
    return store.updateTodo(todo, { state: 'doing', startedAt: 2 }, 2);
  };
  const finish = (kind: 'close' | 'remove', input: Record<string, unknown> = {}) => {
    const repo = new NeoAskTodoRepository(main, () => {
      announcements++;
      onChanged();
    });
    const packs: NeoPack[] = [
      {
        id: 'coding',
        describe: 'Coding',
        instructions: () => null,
        todos: {
          schema: () => {},
          statusLine: () => null,
          check: async () => ({ done: true, evidence: 'Merged' }),
        },
      },
    ];
    const runner = createNeoTodoRunner({
      store: repo,
      sessions: new NeoTodoSessionRepository(main),
      packs: () => packs,
      tell: async () => {},
      changed: () => {},
      invoke: async (_caller, name, input) => {
        expect(name).toBe('work.stop');
        stops.push((input.ref as { id: string }).id);
        await stopping();
        return {
          kind: 'completed',
          value: refused ? { ok: false, reason: 'synthetic refusal' } : { ok: true },
        };
      },
    });
    const operation = createNeoTodoOperations(
      repo,
      new NeoTodoSessionRepository(main),
      runner,
      () => packs,
      () => null
    ).find((operation) => operation.name === `neo.todo.${kind}`)!;
    return operation.execute(
      operation.inputSchema.parse({ todoId: 'first', reason: 'Requested change', ...input }),
      { source: 'mcp', sessionId: 'neo', role: 'neo' }
    ) as Promise<{ ok: false; reason: string } | { ok: true; todo: NeoTodo; todos: NeoTodo[] }>;
  };

  test.each(['remove'] as const)(
    '%s rolls back card pruning and state when the ask stamp fails',
    async (kind) => {
      add('first');
      store.askQuestion(
        'start',
        'ask',
        {
          text: 'Start?',
          kind: 'start',
          options: null,
          multiple: false,
          yesLabel: null,
          noLabel: null,
          startTodos: ['first'],
        },
        3
      );
      writer.exec(
        "CREATE TRIGGER refuse_finish BEFORE UPDATE OF updated_at ON neo_asks BEGIN SELECT RAISE(ABORT, 'refuse finish'); END"
      );
      await expect(finish(kind)).rejects.toThrow('refuse finish');
      expect(store.getTodo('first')?.state).toBe('doing');
      expect(store.getQuestion('start')?.state).toBe('open');
      expect(stops).toEqual(['worker-first']);
      expect(announcements).toBe(0);
    }
  );

  test.each(['remove'] as const)(
    '%s can stop and commit without main todo/session SQL',
    async (kind) => {
      add('first');
      const prepare = main.prepare.bind(main);
      main.prepare = ((sql: string) => {
        if (/neo_todos|neo_asks|neo_questions|neo_todo_sessions/.test(sql))
          throw new Error('Finalize SQL on main');
        return prepare(sql);
      }) as typeof main.prepare;
      expect(await finish(kind)).toMatchObject({
        ok: true,
        todo: { state: 'removed' },
      });
      expect(stops).toEqual(['worker-first']);
    }
  );

  test.each(['remove'] as const)(
    '%s refuses to commit when its worker stop fails',
    async (kind) => {
      add('first');
      refused = true;
      expect(await finish(kind)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('stop_failed:'),
      });
      expect(store.getTodo('first')?.state).toBe('doing');
      expect(announcements).toBe(0);
    }
  );

  test.each(['remove'] as const)(
    '%s preserves a complete report received during stop',
    async (kind) => {
      add('first');
      const text = 'Finalization evidence 🦊\n'.repeat(30000);
      stopping = async () => {
        store.updateTodo(store.getTodo('first')!, { report: text }, 3);
      };
      expect(await finish(kind)).toMatchObject({
        ok: true,
        todo: { state: 'removed', report: text },
      });
      expect(store.getTodo('first')?.report).toBe(text);
    }
  );

  test('remove preserves the adopted-worker exception', async () => {
    add('first');
    sessions.bind('first', { adapter: 'hyperneo', id: 'human-worker' }, 3);
    expect(await finish('remove')).toMatchObject({ ok: true, todo: { state: 'removed' } });
    expect(stops).toEqual([]);
  });
  test('a settled ask returns an accepted no-change record without stopping its worker', async () => {
    add('first');
    writer.exec("UPDATE neo_asks SET status='done'");
    expect(await finish('remove')).toMatchObject({
      ok: true,
      todo: { state: 'doing' },
      records: [expect.stringContaining('ask_settled:')],
    });
    expect(stops).toEqual([]);
    expect(store.getTodo('first')?.state).toBe('doing');
    expect(announcements).toBe(0);
  });

  test('a successful removal announces exactly once after its state is committed', async () => {
    add('first');
    let seen: NeoTodo | null = null;
    onChanged = () => {
      seen = new NeoAskTodoRepository(main).getTodo('first');
    };
    expect(await finish('remove')).toMatchObject({ ok: true, todo: { state: 'removed' } });
    expect(announcements).toBe(1);
    expect(seen).toMatchObject({ state: 'removed' });
  });
  test('a replacement deleted during stop is recorded without leaving a stale link', async () => {
    add('first');
    add('replacement');
    stopping = async () => {
      writer.prepare('DELETE FROM neo_todos WHERE id = ?').run('replacement');
    };
    expect(await finish('remove', { replacedBy: 'replacement' })).toMatchObject({
      ok: true,
      todo: { state: 'removed', replacedBy: null },
      records: [expect.stringContaining('replacement_missing:')],
    });
  });
  test('a current replacement stays linked in the receipt', async () => {
    add('first');
    add('replacement');
    expect(await finish('remove', { replacedBy: 'replacement' })).toMatchObject({
      ok: true,
      todo: { state: 'removed', replacedBy: 'replacement' },
    });
  });
});
