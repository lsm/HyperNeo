import type { ModelInfo } from '@hyperneo/shared';
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
import type { CodingLines } from '../../../../src/lib/neo/packs/coding/stage-lines.ts';
import { catalogModel, driverCodingLines } from '../../helpers/coding-lines.ts';
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
  for (const id of ['feature', 'other', 'third'])
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
  const decide = (
    item: NeoTodo,
    target: Parameters<typeof decideCodingSessionTarget>[2],
    lines?: CodingLines
  ) => decideCodingSessionTarget(db, item, target, status, lines);
  return { db, todo, worked, live, decide };
}

describe('coding session target decision', () => {
  const catalog = [catalogModel('glm-6', 'glm'), catalogModel('claude-opus-5-5', 'anthropic')];
  const glmHold = [{ provider: 'glm', model: 'glm-6', reason: 'rate_limit', retryAt: 4e12 }];
  const routed = (kinds: string[], held: boolean) =>
    driverCodingLines(catalog, held ? { holds: glmHold } : {}, kinds);
  const glm = { verb: 'start' as const, adapter: 'hyperneo', model: 'glm-6', name: 'backend' };
  const opus = { ...glm, model: 'claude-opus-5-5' };

  test('a hyperneo start is ranked again as coding.write and moves off a held line', async () => {
    const { todo, decide } = setup();
    const kinds: string[] = [];
    expect(await decide(todo(), glm, routed(kinds, false))).toEqual({ value: glm });
    expect(await decide(todo('other'), glm, routed(kinds, true))).toEqual({ value: opus });
    expect(kinds).toEqual([`coding.write ${repo}`, `coding.write ${repo}`]);
    expect(await decide(todo('third'), start('desktop'), routed(kinds, true))).toEqual({
      value: start('desktop'),
    });
    expect(kinds).toHaveLength(2);
  });

  test('a route moves a start to its preferred usable line, and nothing usable waits with the reasons', async () => {
    const { todo, decide } = setup();
    const routes = [
      { kind: 'coding.write', lines: [{ provider: 'anthropic', model: 'claude-opus-5-5' }] },
    ];
    expect(await decide(todo(), glm, driverCodingLines(catalog, { routes }))).toEqual({
      value: opus,
    });
    expect(await decide(todo('other'), glm, driverCodingLines(catalog, { ready: [] }))).toEqual({
      reason:
        'No usable model line for coding.write: glm/glm-6 via hyperneo: not configured; anthropic/claude-opus-5-5 via hyperneo: not configured.',
    });
  });

  test('the owning ask project is in scope: never skips the line, only keeps it', async () => {
    const { db, todo, decide } = setup();
    db.exec(
      "INSERT INTO neo_concerns (id,title,summary,context,revision,created_at,updated_at) VALUES ('p1','P1','','',1,0,0)"
    );
    db.prepare("UPDATE neo_asks SET project_id = 'p1' WHERE id = 'feature'").run();
    const line = { provider: 'glm', model: 'glm-6' };
    const kinds: string[] = [];
    const never = driverCodingLines(
      catalog,
      { rules: [{ line, never: { projects: ['p1'] } }] },
      kinds
    );
    const only = driverCodingLines(catalog, { rules: [{ line, only: { projects: ['p1'] } }] });
    expect(await decide(todo(), glm, never)).toEqual({ value: opus });
    expect(kinds).toEqual([`coding.write ${repo} p1`]);
    expect(await decide(todo('other'), glm, only)).toEqual({ value: opus });
    db.prepare("UPDATE neo_asks SET project_id = 'p1' WHERE id = 'third'").run();
    expect(await decide(todo('third'), glm, only)).toEqual({ value: glm });
  });

  test('a start runs at a route effort, not the medium default', async () => {
    const { todo, decide } = setup();
    const graded = [
      { ...catalogModel('glm-6', 'glm'), effortLevels: ['medium', 'high'] },
    ] as ModelInfo[];
    const routes = [
      { kind: 'coding.write', lines: [{ provider: 'glm', model: 'glm-6', effort: 'high' }] },
    ];
    expect(
      await decide(todo(), glm, driverCodingLines(graded, { routes, effort: 'medium' }))
    ).toEqual({ value: { ...glm, effort: 'high' } });
  });

  test('saved legacy write model and effort apply to a start that names neither, with routing off', async () => {
    const { db, todo, decide } = setup();
    const save = db.prepare(`INSERT INTO neo_pack_preferences
      (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
      VALUES ('coding', 'repo', ?, ?, ?, 'human', 1)`);
    save.run(repo, 'write.model', JSON.stringify('glm-6'));
    save.run(repo, 'write.effort', JSON.stringify('high'));
    const bare = { verb: 'start' as const, adapter: 'hyperneo', name: 'backend' };
    expect(await decide(todo(), bare)).toEqual({
      value: { ...bare, model: 'glm-6', effort: 'high' },
    });
    expect(await decide(todo('other'), { ...glm, effort: 'low' })).toEqual({
      value: { ...glm, effort: 'low' },
    });
  });

  test('a send to an existing session is not ranked', async () => {
    const { todo, worked, decide } = setup();
    const first = todo();
    await decide(first, start('backend'));
    worked(first, 'backend-1', 'backend', 'done');
    const kinds: string[] = [];
    expect(await decide(todo(), start(), routed(kinds, true))).toEqual({
      value: { verb: 'send', ref: ref('backend-1') },
    });
    expect(kinds).toEqual([]);
  });

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
