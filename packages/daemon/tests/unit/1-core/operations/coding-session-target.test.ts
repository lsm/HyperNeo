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
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import type { CodingLines } from '../../../../src/lib/neo/packs/coding/stage-lines.ts';
import { catalogModel, driverCodingLines } from '../../helpers/coding-lines.ts';

const repo = 'synthetic/repo';
const ref = (id: string) => ({ adapter: 'claude-desktop', id });
const start = (name?: string) => ({ verb: 'start' as const, adapter: 'claude-desktop', name });

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
  const worked = (
    item: NeoTodo,
    session: string,
    name?: string,
    state?: 'doing' | 'done' | 'removed'
  ) => {
    db.prepare('INSERT INTO neo_todo_sessions (todo_id, target, ref) VALUES (?, ?, ?)').run(
      item.id,
      JSON.stringify(name ? start(name) : { verb: 'send', ref: ref(session) }),
      JSON.stringify(ref(session))
    );
    if (state) db.prepare('UPDATE neo_todos SET state = ? WHERE id = ?').run(state, item.id);
  };
  const decide = (
    item: NeoTodo,
    target: Parameters<typeof decideCodingSessionTarget>[2],
    lines?: CodingLines
  ) => decideCodingSessionTarget(db, item, target, lines);
  return { db, todos, todo, worked, decide };
}

describe('coding session target decision', () => {
  test('a later slice keeps its start target even when its feature has a worker', async () => {
    const { todo, worked, decide, db } = setup();
    worked(todo(), 'prior-worker', 'backend', 'done');
    const next = todo();
    const requested = start('backend');
    expect(await decide(next, requested)).toEqual({ value: requested });
    expect(db.prepare('SELECT count(*) AS n FROM pack_coding_feature_sessions').get()).toEqual({
      n: 0,
    });
  });

  test('a PR holder does not redirect an explicitly addressed worker', async () => {
    const { todo, worked, decide } = setup();
    const url = 'https://github.com/synthetic/repo/pull/9';
    worked(todo('feature', repo, url), 'holder', 'backend', 'done');
    const target = { verb: 'send' as const, ref: ref('author') };
    expect(await decide(todo('other', repo, url), target)).toEqual({ value: target });
  });

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

  test('a send to an existing session is not ranked', async () => {
    const { todo, decide } = setup();
    const kinds: string[] = [];
    const target = { verb: 'send' as const, ref: ref('backend-1') };
    expect(await decide(todo(), target, routed(kinds, true))).toEqual({ value: target });
    expect(kinds).toEqual([]);
  });

  test('leaves a todo outside any coding repository to the target Neo chose', async () => {
    const { todo, decide } = setup();
    expect(await decide(todo('feature', ''), start('docs'))).toEqual({ value: start('docs') });
  });
});
