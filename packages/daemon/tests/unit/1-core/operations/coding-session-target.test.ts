import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { decideCodingSessionTarget } from '../../../../src/lib/neo/packs/coding/session-target.ts';
import {
  CodingTodoPrRepository,
  createCodingTodoPack,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { prepareCodingTodoStorage } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import type { WorkRef } from '../../../../src/lib/drivers/types.ts';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke.ts';

const repo = 'synthetic/repo';
const ref = (id: string) => ({ adapter: 'claude-desktop', id });
const start = (name?: string) => ({ verb: 'start' as const, adapter: 'claude-desktop', name });
type Live = 'idle' | 'running' | 'needs_you' | 'stopped' | 'unreachable';

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  prepareCodingTodoStorage(db);
  const todos = new NeoAskTodoRepository(db);
  for (const id of ['feature', 'other'])
    todos.openAsk({
      id,
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: id,
      request: id,
      createdAt: 1,
    });
  createCodingTodoPack(new CodingTodoPrRepository(db), async () => []).schema(db);
  const todo = (askId = 'feature', inRepo = repo): NeoTodo => {
    const added = todos.addTodo(
      crypto.randomUUID(),
      askId,
      { title: 'Slice', doneWhen: 'Merged', check: null, instruction: 'Do it', named: null },
      1
    );
    if (inRepo)
      db.prepare(
        'INSERT INTO pack_coding_todos (todo_id, repo) VALUES (?, ?) ON CONFLICT (todo_id) DO UPDATE SET repo = excluded.repo'
      ).run(added.id, inRepo);
    return added;
  };
  const worked = (item: NeoTodo, session: string, name?: string, state?: 'doing' | 'done') => {
    db.prepare('INSERT INTO neo_todo_sessions (todo_id, target, ref) VALUES (?, ?, ?)').run(
      item.id,
      JSON.stringify(name ? start(name) : { verb: 'send', ref: ref(session) }),
      JSON.stringify(ref(session))
    );
    if (state) db.prepare('UPDATE neo_todos SET state = ? WHERE id = ?').run(state, item.id);
  };
  const live: Record<string, Live> = {};
  const status = async (work: WorkRef): Promise<OperationOutcome> => {
    const state = live[work.id] ?? 'idle';
    if (state === 'unreachable')
      return { kind: 'failed' as const, code: 'execution_failed' as const, message: 'offline' };
    return {
      kind: 'completed' as const,
      value: {
        ok: true,
        value: {
          ref: work,
          title: work.id,
          place: { machine: 'm', name: 'w' },
          status: state === 'idle' ? 'done' : state,
          lastActivityAt: 1,
        },
      },
    };
  };
  const decide = (item: NeoTodo, target: Parameters<typeof decideCodingSessionTarget>[2]) =>
    decideCodingSessionTarget(db, item, target, status);
  return { db, todo, worked, live, decide };
}

describe('coding session target decision', () => {
  test('leaves a todo outside any coding repository to the target Neo chose', async () => {
    const { todo, decide } = setup();
    expect(await decide(todo('feature', ''), start('docs'))).toEqual({ value: start('docs') });
  });

  test('later work of a feature goes to its session, and queues there while it is busy', async () => {
    const { todo, worked, live, decide } = setup();
    const first = todo();
    expect(await decide(first, start('backend'))).toEqual({ value: start('backend') });
    worked(first, 'backend-1', 'backend', 'done');
    expect(await decide(todo(), start())).toEqual({
      value: { verb: 'send', ref: ref('backend-1') },
    });
    live['backend-1'] = 'running';
    expect(await decide(todo(), start())).toEqual({
      value: { verb: 'send', ref: ref('backend-1') },
    });
    live['backend-1'] = 'unreachable';
    expect(await decide(todo(), start())).toMatchObject({ reason: expect.any(String) });
  });

  test('unrelated work reuses an idle session of its work type before starting one', async () => {
    const { todo, worked, live, decide } = setup();
    worked(todo('other'), 'front', 'frontend', 'done');
    worked(todo('other'), 'back', 'backend', 'done');
    const next = todo();
    expect(await decide(next, start('backend'))).toEqual({
      value: { verb: 'send', ref: ref('back') },
    });
    worked(next, 'back');
    expect(await decide(todo(), start())).toEqual({ value: { verb: 'send', ref: ref('back') } });
    live.front = 'needs_you';
    live.back = 'running';
    expect(await decide(todo('other'), start('frontend'))).toEqual({
      value: start('frontend-2'),
    });
  });

  test.each([true, false])(
    'skips an archived Claude Desktop worker (live alternative: %s)',
    async (hasLive) => {
      const { todo, worked, live, decide } = setup();
      worked(todo('other'), 'archived', 'backend', 'done');
      live.archived = 'stopped';
      if (hasLive) worked(todo('other'), 'idle', 'frontend', 'done');

      expect(await decide(todo(), start('backend'))).toEqual({
        value: hasLive ? { verb: 'send', ref: ref('idle') } : start('backend'),
      });
    }
  );

  test('a session held by unfinished work is busy even when its turn is idle', async () => {
    const { todo, worked, decide } = setup();
    worked(todo('other'), 'dev', 'dev', 'doing');
    expect(await decide(todo(), start())).toEqual({ value: start('dev-2') });
  });

  test('a concurrent dispatch of the same feature waits instead of starting a duplicate', async () => {
    const { todo, decide } = setup();
    const [first, second] = [todo(), todo()];
    expect(await decide(first, start())).toEqual({ value: start('dev') });
    expect(await decide(second, start())).toMatchObject({ reason: expect.any(String) });
    expect(await decide(first, start())).toEqual({ value: start('dev') });
  });

  test('per-task work starts its own session even when another is idle', async () => {
    const { db, todo, worked, decide } = setup();
    db.prepare(
      `INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
       VALUES ('coding', 'repo', ?, 'sessionStrategy', '"per_task"', 'human', 1)`
    ).run(repo);
    worked(todo('other'), 'idle', 'dev', 'done');
    expect(await decide(todo(), start('dev'))).toEqual({ value: start('dev') });
  });

  test('unfinished work on a feature session does not hide an unreadable status', async () => {
    const { todo, worked, live, decide } = setup();
    const first = todo();
    await decide(first, start('backend'));
    worked(first, 'backend-1', 'backend', 'doing');
    live['backend-1'] = 'unreachable';
    expect(await decide(todo(), start())).toMatchObject({ reason: expect.any(String) });
  });

  test('a refused send-only dispatch leaves the feature free for a later start', async () => {
    const { todo, decide } = setup();
    expect(await decide(todo(), { verb: 'send', ref: ref('elsewhere') })).toMatchObject({
      reason: expect.stringMatching(/^session_start_needed/),
    });
    expect(await decide(todo(), start())).toEqual({ value: start('dev') });
  });

  test('a feature reserved by a todo that settled without a session is free to start again', async () => {
    const { db, todo, decide } = setup();
    const first = todo();
    expect(await decide(first, start())).toEqual({ value: start('dev') });
    db.prepare("UPDATE neo_todos SET state = 'removed' WHERE id = ?").run(first.id);
    const next = todo();
    expect(await decide(next, start())).toEqual({ value: start('dev') });
    expect(await decide(todo(), start())).toMatchObject({ reason: expect.any(String) });
  });
});
