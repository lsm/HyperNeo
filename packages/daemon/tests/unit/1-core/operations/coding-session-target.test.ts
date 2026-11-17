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
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
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
  for (const id of ['feature', 'other', 'third', 'fourth'])
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
    db.prepare(
      "INSERT OR IGNORE INTO work_started_sessions (adapter, id, started_at, role) VALUES ('claude-desktop', ?, 1, 'worker')"
    ).run(session);
    db.prepare('INSERT INTO neo_todo_sessions (todo_id, target, ref) VALUES (?, ?, ?)').run(
      item.id,
      JSON.stringify(name ? start(name) : { verb: 'send', ref: ref(session) }),
      JSON.stringify(ref(session))
    );
    if (state) db.prepare('UPDATE neo_todos SET state = ? WHERE id = ?').run(state, item.id);
  };
  const live: Record<string, Live> = {};
  const models: Record<string, { model: string; provider: string }> = {};
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
          ...models[work.id],
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
  const decide = (
    item: NeoTodo,
    target: Parameters<typeof decideCodingSessionTarget>[2],
    lines?: CodingLines
  ) =>
    decideCodingSessionTarget(
      db,
      item,
      target,
      status,
      async (input) => {
        failing.before?.();
        if (failing.ask) {
          asks.push('failed');
          return {
            kind: 'failed' as const,
            code: 'execution_failed' as const,
            message: 'synthetic',
          };
        }
        const value = await askSetting!.execute(
          { askId: item.askId, ...input },
          { source: 'internal', sessionId: 'neo', role: 'neo' }
        );
        asks.push(value);
        return { kind: 'completed' as const, value };
      },
      lines
    );
  const questions = (askId: string) => todos.listQuestionsForAsks([askId]);
  const agentAsk = (input: Record<string, unknown>) =>
    askSetting!.execute(input as never, { source: 'internal', sessionId: 'neo', role: 'neo' });
  return { db, todos, todo, worked, live, models, decide, questions, asks, agentAsk, failing };
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
    expect(await decide(todo('other'), glm, routed(kinds, true))).toEqual({
      value: opus,
      note: `Started on anthropic/claude-opus-5-5 via hyperneo instead of glm/glm-6 via hyperneo: held (rate_limit) until ${new Date(4e12).toISOString()}.`,
    });
    expect(kinds).toEqual([`coding.write ${repo}`, `coding.write ${repo}`]);
    expect(await decide(todo('third'), start('desktop'), routed(kinds, true))).toEqual({
      value: start('desktop'),
    });
    expect(kinds).toHaveLength(2);
  });

  test('a start that keeps its own line says nothing about other refused lines', async () => {
    const { todo, decide } = setup();
    const opusHold = [{ provider: 'anthropic', model: 'claude-opus-5-5', retryAt: 4e12 }];
    expect(await decide(todo(), glm, driverCodingLines(catalog, { holds: opusHold }))).toEqual({
      value: glm,
    });
  });

  test('a route moves a start to its preferred usable line, and nothing usable waits with the reasons', async () => {
    const { todo, decide } = setup();
    const routes = [
      { kind: 'coding.write', lines: [{ provider: 'anthropic', model: 'claude-opus-5-5' }] },
    ];
    expect(await decide(todo(), glm, driverCodingLines(catalog, { routes }))).toEqual({
      value: opus,
      note: 'Started on anthropic/claude-opus-5-5 via hyperneo instead of glm/glm-6 via hyperneo: the route ranks it lower.',
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
    expect(await decide(todo(), glm, never)).toEqual({
      value: opus,
      note: 'Started on anthropic/claude-opus-5-5 via hyperneo instead of glm/glm-6 via hyperneo: excluded by a rule.',
    });
    expect(kinds).toEqual([`coding.write ${repo} p1`]);
    expect(await decide(todo('other'), glm, only)).toEqual({
      value: opus,
      note: 'Started on anthropic/claude-opus-5-5 via hyperneo instead of glm/glm-6 via hyperneo: excluded by a rule.',
    });
    db.prepare("UPDATE neo_asks SET project_id = 'p1' WHERE id = 'third'").run();
    expect(await decide(todo('third'), glm, only)).toEqual({ value: glm });
  });

  const saveWrite = (db: ReturnType<typeof setup>['db'], model: string, effort: string) => {
    const save = db.prepare(`INSERT INTO neo_pack_preferences
      (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
      VALUES ('coding', 'repo', ?, ?, ?, 'human', 1)`);
    save.run(repo, 'write.model', JSON.stringify(model));
    save.run(repo, 'write.effort', JSON.stringify(effort));
  };
  const routingOff = () => ({ ...driverCodingLines(catalog), active: () => false });
  const bare = { verb: 'start' as const, adapter: 'hyperneo', name: 'backend' };

  test('saved legacy write model and effort apply to a start that names neither, with routing off', async () => {
    const { db, todo, decide } = setup();
    saveWrite(db, 'glm-6', 'high');
    expect(await decide(todo(), bare, routingOff())).toEqual({
      value: { ...bare, model: 'glm-6', effort: 'high' },
    });
    expect(await decide(todo('other'), { ...glm, effort: 'low' }, routingOff())).toEqual({
      value: { ...glm, effort: 'low' },
    });
    expect(await decide(todo('third'), start('desktop'), routingOff())).toEqual({
      value: start('desktop'),
    });
    const remote = { ...bare, place: { machine: 'm', name: 'w', daemon: 'other-host' } };
    expect(await decide(todo('fourth'), remote, routingOff())).toEqual({ value: remote });
  });

  test('a stale saved write model or effort is dropped, so the start still runs on the default', async () => {
    const { db, todo, decide } = setup();
    saveWrite(db, 'retired-9', 'bogus');
    expect(await decide(todo(), bare, routingOff())).toEqual({ value: bare });
    const other = setup();
    saveWrite(other.db, 'retired-9', 'high');
    expect(await other.decide(other.todo(), bare, routingOff())).toEqual({
      value: { ...bare, effort: 'high' },
    });
  });

  test('a ranked start reads its saved write values and line scope through the stage-target read op', async () => {
    const { db, todo, decide } = setup();
    const gateway = gatewayFor(db);
    const call = gateway.call.bind(gateway);
    const seen: string[] = [];
    gateway.call = ((op: { name: string }, method: string, ...rest: unknown[]) => {
      seen.push(`${op.name}.${method}`);
      return (call as (...args: unknown[]) => unknown)(op, method, ...rest);
    }) as typeof gateway.call;
    expect(await decide(todo(), glm, driverCodingLines(catalog))).toEqual({ value: glm });
    expect(seen).toEqual(
      expect.arrayContaining([
        'coding.stageTarget.reads.stagePreference',
        'coding.stageTarget.reads.lineScope',
      ])
    );
  });

  test('an idle worker whose status names no provider is ranked as the line it resolves to', async () => {
    const { db, todo, models, decide } = setup();
    const prior = todo('other');
    db.prepare('INSERT INTO neo_todo_sessions (todo_id, target, ref) VALUES (?, ?, ?)').run(
      prior.id,
      JSON.stringify({ verb: 'start', adapter: 'hyperneo', name: 'backend' }),
      JSON.stringify({ adapter: 'hyperneo', id: 'old-worker' })
    );
    db.prepare("UPDATE neo_todos SET state = 'done' WHERE id = ?").run(prior.id);
    expect(await decide(todo('third'), glm, driverCodingLines(catalog))).toEqual({
      value: { verb: 'send', ref: { adapter: 'hyperneo', id: 'old-worker' } },
    });
    models['old-worker'] = { model: 'glm-6' } as { model: string; provider: string };
    const rules = [
      { line: { provider: 'glm', model: 'glm-6' }, never: { kinds: ['coding.write'] } },
    ];
    expect(await decide(todo(), glm, driverCodingLines(catalog, { rules }))).toMatchObject({
      value: { verb: 'start', model: 'claude-opus-5-5' },
    });
  });

  test('a new feature does not reuse an idle worker on an excluded line; it starts on a usable one', async () => {
    const { db, todo, models, decide } = setup();
    const prior = todo('other');
    db.prepare('INSERT INTO neo_todo_sessions (todo_id, target, ref) VALUES (?, ?, ?)').run(
      prior.id,
      JSON.stringify({ verb: 'start', adapter: 'hyperneo', name: 'backend' }),
      JSON.stringify({ adapter: 'hyperneo', id: 'glm-worker' })
    );
    db.prepare("UPDATE neo_todos SET state = 'done' WHERE id = ?").run(prior.id);
    models['glm-worker'] = { model: 'glm-6', provider: 'glm' };
    expect(await decide(todo('third'), glm, driverCodingLines(catalog))).toEqual({
      value: { verb: 'send', ref: { adapter: 'hyperneo', id: 'glm-worker' } },
    });
    const rules = [
      { line: { provider: 'glm', model: 'glm-6' }, never: { kinds: ['coding.write'] } },
    ];
    expect(await decide(todo(), glm, driverCodingLines(catalog, { rules }))).toMatchObject({
      value: { verb: 'start', adapter: 'hyperneo', model: 'claude-opus-5-5' },
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

  test('a reservation reuses only a daemon-started worker', async () => {
    for (const worker of [false, true]) {
      const { db, todo, worked, decide } = setup();
      const first = todo();
      await decide(first, start('backend'));
      worked(first, 'owner', 'backend', 'done');
      if (!worker) db.prepare("DELETE FROM work_started_sessions WHERE id = 'owner'").run();
      const result = await decide(todo(), start());
      if (worker) expect(result).toEqual({ value: { verb: 'send', ref: ref('owner') } });
      else expect(result).toMatchObject({ value: { verb: 'start', name: 'dev' } });
    }
  });

  test('a PR holder is reused only when it is a worker for every strategy', async () => {
    for (const strategy of ['long_lived', 'per_pr', 'per_task']) {
      for (const worker of [false, true]) {
        const { db, todo, worked, decide } = setup();
        db.prepare(
          `INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at) VALUES ('coding', 'repo', ?, 'sessionStrategy', ?, 'human', 1)`
        ).run(repo, JSON.stringify(strategy));
        const url = 'https://github.com/synthetic/repo/pull/9';
        worked(todo('other', repo, url), 'holder', 'backend', 'done');
        if (!worker) db.prepare("DELETE FROM work_started_sessions WHERE id = 'holder'").run();
        const result = await decide(todo('feature', repo, url), start('backend'));
        expect(result).toMatchObject(
          worker ? { value: { verb: 'send', ref: ref('holder') } } : { value: { verb: 'start' } }
        );
      }
    }
  });

  test('per-task work reuses its bound session only when it is a worker', async () => {
    for (const worker of [false, true]) {
      const { db, todo, worked, decide } = setup();
      db.prepare(
        `INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at) VALUES ('coding', 'repo', ?, 'sessionStrategy', '"per_task"', 'human', 1)`
      ).run(repo);
      const item = todo();
      worked(item, 'bound', 'backend', 'done');
      if (!worker) db.prepare("DELETE FROM work_started_sessions WHERE id = 'bound'").run();
      expect(await decide(item, start())).toMatchObject(
        worker ? { value: { verb: 'send', ref: ref('bound') } } : { value: { verb: 'start' } }
      );
    }
  });

  test('a non-worker PR holder replaces the existing feature reservation', async () => {
    const { db, todo, worked, decide } = setup();
    const reserved = todo();
    await decide(reserved, start('backend'));
    worked(reserved, 'reserved-worker', 'backend', 'done');
    const url = 'https://github.com/synthetic/repo/pull/9';
    worked(todo('other', repo, url), 'person', 'person', 'done');
    db.prepare("DELETE FROM work_started_sessions WHERE id = 'person'").run();
    expect(await decide(todo('feature', repo, url), start('backend'))).toMatchObject({
      value: { verb: 'start' },
    });
  });

  test('an explicit send to the reserved session remains available', async () => {
    const { db, todo, worked, decide } = setup();
    const first = todo();
    await decide(first, start('backend'));
    worked(first, 'person', 'backend', 'done');
    db.prepare("DELETE FROM work_started_sessions WHERE id = 'person'").run();
    expect(await decide(todo(), { verb: 'send', ref: ref('person') })).toEqual({
      value: { verb: 'send', ref: ref('person') },
    });
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

  test('a strategy saved while the question is being asked is not asked again and decides routing', async () => {
    const { db, todo, worked, decide, questions, asks, failing } = setup();
    failing.ask = true;
    failing.before = () =>
      db
        .prepare(
          `INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
           VALUES ('coding', 'repo', ?, 'sessionStrategy', '"per_pr"', 'human', 1)`
        )
        .run(repo);
    worked(todo('other'), 'idle', 'dev', 'done');
    expect(await decide(todo(), start('dev'))).toEqual({ value: start('dev') });
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
