import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoPack } from '../../../../src/lib/neo/pack-contract.ts';
import { CODING_SESSION_STRATEGY_PREFERENCE } from '../../../../src/lib/neo/packs/coding/session-strategy.ts';
import { decideCodingSessionTarget } from '../../../../src/lib/neo/packs/coding/session-target.ts';
import { listPackPreferences } from '../../../../src/lib/neo/preference-operations.ts';
import { createPackPreferenceQuestions } from '../../../../src/lib/neo/preference-questions.ts';
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
type Live = 'idle' | 'running' | 'needs_you' | 'unreachable' | 'archived' | 'interrupted';

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
  const todo = (askId = 'feature', inRepo = repo, url?: string): NeoTodo => {
    const added = todos.addTodo(
      crypto.randomUUID(),
      askId,
      {
        title: 'Slice',
        doneWhen: 'Merged',
        check: url ? { pack: 'coding', kind: 'pr_merged', params: { urls: [url] } } : null,
        instruction: 'Do it',
        named: null,
      },
      1
    );
    if (url)
      db.prepare(
        'INSERT INTO pack_coding_todo_prs (todo_id, prs_json, read_at) VALUES (?, ?, 1)'
      ).run(added.id, JSON.stringify([{ url, state: 'OPEN', checks: 'passing', review: 'none' }]));
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
          status:
            state === 'idle'
              ? 'done'
              : state === 'archived' || state === 'interrupted'
                ? 'stopped'
                : state,
          ...(state === 'archived' ? { archived: true } : {}),
          lastActivityAt: 1,
        },
      },
    };
  };
  const coding = {
    id: 'coding',
    describe: 'coding',
    instructions: () => null,
    preferences: {
      sessionStrategy: CODING_SESSION_STRATEGY_PREFERENCE,
      mergePolicy: {
        label: { en: 'Merge policy', 'zh-Hans': '合并规则' },
        valueLabels: {},
        scope: 'repo',
        type: { kind: 'enum', values: ['ci_only', 'human'] },
        default: 'human',
        ask: 'Merge policy?',
      },
    },
  } satisfies NeoPack;
  const [askSetting] = createPackPreferenceQuestions(
    db,
    todos,
    () => [coding],
    () => 'en',
    async () => {}
  );
  const asks: unknown[] = [];
  const failing = { ask: false, before: null as null | (() => void) };
  const decide = (item: NeoTodo, target: Parameters<typeof decideCodingSessionTarget>[2]) =>
    decideCodingSessionTarget(db, item, target, status, async (input) => {
      failing.before?.();
      if (failing.ask) {
        asks.push('failed');
        return { kind: 'failed' as const, code: 'execution_failed' as const, message: 'synthetic' };
      }
      const value = await askSetting!.execute(
        { askId: item.askId, ...input },
        { source: 'internal', sessionId: 'neo', role: 'neo' }
      );
      asks.push(value);
      return { kind: 'completed' as const, value };
    });
  const questions = (askId: string) => todos.listQuestionsForAsks([askId]);
  const agentAsk = (input: Record<string, unknown>) =>
    askSetting!.execute(input as never, { source: 'internal', sessionId: 'neo', role: 'neo' });
  return { db, todos, todo, worked, live, decide, questions, asks, agentAsk, failing };
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

  test('an idle session of another work type is never reused for new work', async () => {
    const { todo, worked, decide } = setup();
    worked(todo('other'), 'jason', 'Jason', 'done');
    worked(todo('other'), 'worker', 'dev', 'done');
    expect(await decide(todo(), start())).toEqual({
      value: { verb: 'send', ref: ref('worker') },
    });
  });

  test('a place holding only sessions of other work types starts a fresh worker', async () => {
    const { todo, worked, decide } = setup();
    worked(todo('other'), 'jason', 'Jason', 'done');
    worked(todo('other'), 'reviews', 'Claude review TLS W1a', 'done');
    expect(await decide(todo(), start())).toEqual({ value: start('dev') });
  });

  test('a session assigned as a review actor is never reused for other work', async () => {
    const { db, todo, worked, decide } = setup();
    const review = todo('other');
    worked(review, 'actor', undefined, 'done');
    db.prepare(
      `INSERT INTO pack_facts (todo_id, pack, key, value_json) VALUES (?, 'coding', ?, ?)`
    ).run(
      review.id,
      'assignment:github.com/synthetic/repo/pull/9:head:review',
      JSON.stringify({
        url: 'github.com/synthetic/repo/pull/9',
        head: 'head',
        acceptanceContract: 'contract',
        newDispatch: true,
        write: ref('author'),
        actor: { kind: 'agent', id: 'actor', model: 'm', harness: 'claude-desktop' },
        ref: ref('actor'),
      })
    );
    expect(await decide(todo(), start())).toEqual({ value: start('dev') });
  });

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
    const { db, todo, worked, decide, questions } = setup();
    db.prepare(
      `INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
       VALUES ('coding', 'repo', ?, 'sessionStrategy', '"per_task"', 'human', 1)`
    ).run(repo);
    worked(todo('other'), 'idle', 'dev', 'done');
    expect(await decide(todo(), start('dev'))).toEqual({ value: start('dev') });
    expect(questions('feature')).toEqual([]);
  });

  test('the first dispatch in a repo asks its session strategy once and stays long-lived until a human answers', async () => {
    const { db, todos, todo, worked, decide, questions, asks } = setup();
    worked(todo('other'), 'idle', 'dev', 'done');
    expect(await decide(todo(), start('dev'))).toEqual({
      value: { verb: 'send', ref: ref('idle') },
    });
    const [question] = questions('feature');
    expect(question).toMatchObject({
      kind: 'choice',
      state: 'open',
      todos: [],
      options: [
        'Long-lived work-type sessions',
        'One session per task',
        'One session per PR',
        'Keep current settings',
      ],
    });
    expect(await decide(todo(), start('dev'))).toMatchObject({ reason: expect.any(String) });
    expect(await decide(todo('other'), start('dev'))).toEqual({
      value: { verb: 'send', ref: ref('idle') },
    });
    expect([...questions('feature'), ...questions('other')]).toHaveLength(1);
    expect(asks).toEqual([{ ok: true, questionId: question!.id }]);
    expect(listPackPreferences(db, 'coding')).toEqual([]);
    todos.answerQuestion(question!, 'One session per task', 'button', 2);
    expect(listPackPreferences(db, 'coding')).toMatchObject([
      { scope: { kind: 'repo', key: repo }, key: 'sessionStrategy', value: 'per_task' },
    ]);
    expect(await decide(todo('other'), start('dev'))).toEqual({ value: start('dev') });
    expect([...questions('feature'), ...questions('other')]).toHaveLength(1);
    expect(asks).toHaveLength(1);
  });

  for (const answered of [false, true])
    test(`an unrelated ${answered ? 'answered' : 'open'} proposal under the strategy request id does not stand in for the strategy question`, async () => {
      const { db, todos, todo, decide, questions, asks, agentAsk } = setup();
      const borrowed = (await agentAsk({
        askId: 'other',
        requestId: `coding.sessionStrategy:${repo}:1`,
        values: [
          {
            pack: 'coding',
            scope: { kind: 'repo', key: repo },
            key: 'mergePolicy',
            value: 'ci_only',
          },
        ],
        hold: false,
      })) as { questionId: string };
      if (answered) {
        const [card] = questions('other');
        todos.answerQuestion(card!, card!.options![0]!, 'button', 2);
        expect(listPackPreferences(db, 'coding').map((row) => row.key)).toEqual(['mergePolicy']);
      }
      await decide(todo(), start('dev'));
      const [asked] = questions('feature');
      expect(asked).toMatchObject({ state: 'open', kind: 'choice', todos: [] });
      expect(asked!.id).not.toBe(borrowed.questionId);
      expect(asks).toEqual([{ ok: true, questionId: asked!.id }]);
    });

  test('a strategy question that cannot be opened is retried at once, keeps work going and is asked by a later dispatch', async () => {
    const { todo, worked, decide, questions, asks, failing } = setup();
    worked(todo('other'), 'idle', 'dev', 'done');
    failing.ask = true;
    expect(await decide(todo(), start('dev'))).toEqual({
      value: { verb: 'send', ref: ref('idle') },
    });
    expect(asks).toEqual(['failed', 'failed']);
    expect(questions('feature')).toEqual([]);
    failing.ask = false;
    await decide(todo('other'), start('dev'));
    const [asked] = questions('other');
    expect(asked).toMatchObject({ state: 'open', kind: 'choice', todos: [] });
    expect(asks).toEqual(['failed', 'failed', { ok: true, questionId: asked!.id }]);
  });

  test('a strategy saved while the question is being asked is not asked again', async () => {
    const { db, todo, decide, questions, asks, failing } = setup();
    failing.ask = true;
    failing.before = () =>
      db
        .prepare(
          `INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
           VALUES ('coding', 'repo', ?, 'sessionStrategy', '"per_pr"', 'human', 1)`
        )
        .run(repo);
    await decide(todo(), start('dev'));
    expect(asks).toEqual(['failed']);
    expect(questions('feature')).toEqual([]);
  });

  test('two first dispatches at the same time open one strategy question and both stay long-lived', async () => {
    const { todo, worked, decide, questions, asks } = setup();
    worked(todo('other'), 'idle', 'dev', 'done');
    const decisions = await Promise.all([
      decide(todo(), start('dev')),
      decide(todo('other'), start('dev')),
    ]);
    expect(decisions).toEqual([
      { value: { verb: 'send', ref: ref('idle') } },
      { value: { verb: 'send', ref: ref('idle') } },
    ]);
    const open = [...questions('feature'), ...questions('other')];
    expect(open).toHaveLength(1);
    expect(asks).toEqual([{ ok: true, questionId: open[0]!.id }]);
  });

  test('a strategy question retired unanswered is asked again, and a kept answer is not', async () => {
    const { todos, todo, decide, questions, asks } = setup();
    await decide(todo(), start('dev'));
    const [first] = questions('feature');
    todos.retireQuestion(first!, 'ask_settled', null, 2);
    await decide(todo('other'), start('dev'));
    const [again] = questions('other');
    expect(again).toMatchObject({ state: 'open', todos: [] });
    expect(again!.id).not.toBe(first!.id);
    todos.answerQuestion(again!, 'Keep current settings', 'button', 3);
    await decide(todo('other'), start('dev'));
    expect(asks).toEqual([
      { ok: true, questionId: first!.id },
      { ok: true, questionId: again!.id },
    ]);
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

  test('an archived session is never reused; a live idle one is, and with none a new one starts', async () => {
    for (const idleLive of [true, false]) {
      const { todo, worked, live, decide } = setup();
      worked(todo('other'), 'gone', 'dev', 'done');
      worked(todo('other'), 'idle', 'dev-2', 'done');
      live.gone = 'archived';
      if (!idleLive) live.idle = 'archived';
      expect(await decide(todo(), start())).toMatchObject(
        idleLive ? { value: { verb: 'send', ref: ref('idle') } } : { value: { verb: 'start' } }
      );
    }
  });

  test('a feature whose own session was archived starts a new one', async () => {
    const { todo, worked, live, decide } = setup();
    const first = todo();
    await decide(first, start('backend'));
    worked(first, 'backend-1', 'backend', 'done');
    live['backend-1'] = 'archived';
    const next = todo();
    expect(await decide(next, start())).toMatchObject({ value: { verb: 'start' } });
    worked(next, 'backend-2', 'backend', 'done');
    expect(await decide(todo(), start())).toEqual({
      value: { verb: 'send', ref: ref('backend-2') },
    });
  });

  test('a feature whose own session was archived moves to a live idle session of its work type', async () => {
    const { todo, worked, live, decide } = setup();
    const first = todo();
    await decide(first, start('backend'));
    worked(first, 'backend-1', 'backend', 'done');
    worked(todo('other'), 'spare', 'backend-2', 'done');
    live['backend-1'] = 'archived';
    const moved = todo();
    expect(await decide(moved, start('backend'))).toEqual({
      value: { verb: 'send', ref: ref('spare') },
    });
    worked(moved, 'spare');
    expect(await decide(todo(), start('backend'))).toEqual({
      value: { verb: 'send', ref: ref('spare') },
    });
  });

  test('a feature whose own session was archived starts over rather than take another type', async () => {
    const { todo, worked, live, decide } = setup();
    const first = todo();
    await decide(first, start('backend'));
    worked(first, 'backend-1', 'backend', 'done');
    worked(todo('other'), 'spare', 'backend-2', 'done');
    live['backend-1'] = 'archived';
    const moved = todo();
    expect(await decide(moved, start())).toEqual({ value: start('dev') });
    worked(moved, 'dev', 'dev', 'done');
    expect(await decide(todo(), start())).toEqual({ value: { verb: 'send', ref: ref('dev') } });
  });

  test('an archived session keeps its name taken', async () => {
    const { todo, worked, live, decide } = setup();
    worked(todo('other'), 'gone', 'dev', 'done');
    live.gone = 'archived';
    expect(await decide(todo(), start())).toEqual({ value: start('dev-2') });
  });

  test('two dispatches racing to take over an archived owner: only one wins', async () => {
    const { todo, worked, live, decide } = setup();
    const first = todo();
    await decide(first, start('backend'));
    worked(first, 'backend-1', 'backend', 'done');
    live['backend-1'] = 'archived';
    const results = await Promise.all([decide(todo(), start()), decide(todo(), start())]);
    expect(results.filter((result) => 'value' in result)).toHaveLength(1);
    expect(results.filter((result) => 'reason' in result)).toHaveLength(1);
  });

  test('a stopped but open feature session keeps its feature', async () => {
    const { todo, worked, live, decide } = setup();
    const first = todo();
    await decide(first, start('backend'));
    worked(first, 'backend-1', 'backend', 'done');
    worked(todo('other'), 'spare', 'backend-2', 'done');
    worked(todo('other'), 'gone', 'backend-3', 'done');
    live['backend-1'] = 'interrupted';
    live.gone = 'archived';
    expect(await decide(todo(), start())).toEqual({
      value: { verb: 'send', ref: ref('backend-1') },
    });
  });

  test('later slices of a PR follow the session that took over its archived holder', async () => {
    const { todo, worked, live, decide } = setup();
    const url = 'https://github.com/synthetic/repo/pull/9';
    const first = todo('feature', repo, url);
    await decide(first, start('backend'));
    worked(first, 'holder', 'backend', 'done');
    worked(todo('other'), 'spare', 'backend-2', 'done');
    live.holder = 'archived';
    const second = todo('feature', repo, url);
    expect(await decide(second, start('backend'))).toEqual({
      value: { verb: 'send', ref: ref('spare') },
    });
    worked(second, 'spare', undefined, 'done');
    expect(await decide(todo('feature', repo, url), start('backend'))).toEqual({
      value: { verb: 'send', ref: ref('spare') },
    });
  });

  test('per-PR slices follow the live replacement of an archived holder, and queue there', async () => {
    const { db, todo, worked, live, decide } = setup();
    db.prepare(
      `INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
       VALUES ('coding', 'repo', ?, 'sessionStrategy', '"per_pr"', 'human', 1)`
    ).run(repo);
    const url = 'https://github.com/synthetic/repo/pull/9';
    const first = todo('feature', repo, url);
    expect(await decide(first, start('dev'))).toEqual({ value: start('dev') });
    worked(first, 'a', 'dev', 'done');
    live.a = 'archived';
    const second = todo('feature', repo, url);
    expect(await decide(second, start('dev'))).toEqual({ value: start('dev') });
    worked(second, 'b', 'dev', 'done');
    expect(await decide(todo('feature', repo, url), start('dev'))).toEqual({
      value: { verb: 'send', ref: ref('b') },
    });
    live.b = 'running';
    expect(await decide(todo('feature', repo, url), start('dev'))).toEqual({
      value: { verb: 'send', ref: ref('b') },
    });
  });

  test('a PR follows its live replacement holder from another ask, and queues there', async () => {
    const { db, todo, worked, live, decide } = setup();
    const url = 'https://github.com/synthetic/repo/pull/9';
    const first = todo('feature', repo, url);
    await decide(first, start('backend'));
    worked(first, 'a', 'backend', 'done');
    live.a = 'archived';
    const fix = todo('other', repo, url);
    db.prepare('UPDATE neo_todos SET created_at = 2 WHERE id = ?').run(fix.id);
    expect(await decide(fix, start('backend'))).toMatchObject({ value: { verb: 'start' } });
    worked(fix, 'b', 'backend-2', 'doing');
    live.b = 'running';
    expect(await decide(todo('feature', repo, url), start())).toEqual({
      value: { verb: 'send', ref: ref('b') },
    });
  });

  test('per-PR slices follow the latest dispatched live holder, not the latest created', async () => {
    const { db, todo, worked, live, decide } = setup();
    db.prepare(
      `INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
       VALUES ('coding', 'repo', ?, 'sessionStrategy', '"per_pr"', 'human', 1)`
    ).run(repo);
    const url = 'https://github.com/synthetic/repo/pull/9';
    const ran = (item: NeoTodo, session: string, at: number) => {
      worked(item, session, 'dev', 'done');
      db.prepare('UPDATE neo_todo_sessions SET started_at = ? WHERE todo_id = ?').run(at, item.id);
    };
    const original = todo('feature', repo, url);
    const waiting = todo('feature', repo, url);
    const later = todo('feature', repo, url);
    ran(original, 'a', 1);
    ran(later, 'a', 2);
    live.a = 'archived';
    expect(await decide(waiting, start('dev'))).toEqual({ value: start('dev') });
    ran(waiting, 'b', 3);
    expect(await decide(todo('feature', repo, url), start('dev'))).toEqual({
      value: { verb: 'send', ref: ref('b') },
    });
  });
});
