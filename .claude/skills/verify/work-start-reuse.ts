import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { Result, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createWorkVerbOperations } from '../../../packages/daemon/src/lib/drivers/work-operations.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { readReusableWorkers } from '../../../packages/daemon/src/storage/repositories/work-started-sessions-worker.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
const folder = join(run, 'project');
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(folder, { recursive: true });
assert.equal(spawnSync('git', ['init', '-q', '--initial-branch=dev', folder]).status, 0);
const app = await createDaemonApp({
  config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: folder }), disableWorktrees: true },
  verbose: false,
});
const place = { machine: hostname(), folder, name: 'Synthetic' };
const input = (title: string, todoId?: string) => ({ adapter: 'hyperneo', place, title, message: `Synthetic task: ${title}`, ...(todoId ? { todoId } : {}) });
const mainStartedSql: string[] = [];
const startedSql = /work_started_sessions|work_cleanup_gone/;
const start = async (title: string, caller: Parameters<typeof invokeOperation>[3], todoId = 'todo-plan') => {
  const main = app.db.getDatabase();
  const prepare = main.prepare.bind(main);
  const runSql = main.run.bind(main);
  main.prepare = ((sql: string, ...rest: unknown[]) => {
    if (startedSql.test(sql)) mainStartedSql.push(sql);
    return (prepare as (...args: unknown[]) => unknown)(sql, ...rest);
  }) as typeof main.prepare;
  main.run = ((sql: string, ...rest: unknown[]) => {
    if (startedSql.test(sql)) mainStartedSql.push(sql);
    return (runSql as (...args: unknown[]) => unknown)(sql, ...rest);
  }) as typeof main.run;
  const outcome = await invokeOperation(app.sessionManager.getOperationRegistry(), 'work.start', input(title, caller.role === 'neo' ? todoId : undefined), caller).finally(() => {
    main.prepare = prepare;
    main.run = runSql;
  });
  assert.equal(outcome.kind, 'completed', JSON.stringify(outcome));
  const result = (outcome as { value: Result<WorkStarted> }).value;
  assert(result.ok, JSON.stringify(result));
  return { id: result.value.ref.id, reused: result.value.reused === true };
};
const neo = { source: 'internal' as const, sessionId: 'synthetic-neo', role: 'neo' as const };
const human = { source: 'rpc' as const };
const sessions = () => (app.db.getDatabase().prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n;
const settle = async (ids: string[]) => {
  for (let i = 0; i < 100; i++) {
    const found = await invokeOperation(app.sessionManager.getOperationRegistry(), 'work.find', { folder, adapters: ['hyperneo'] }, human);
    const work = ((found as { value: { places?: { work?: { ref: { id: string }; status: string }[] }[] } }).value.places ?? []).flatMap((group) => group.work ?? []);
    if (ids.every((id) => work.find((item) => item.ref.id === id)?.status === 'done')) return work;
    await Bun.sleep(100);
  }
  throw new Error('workers never went idle');
};
const db = app.db.getDatabase();
const store = new NeoAskTodoRepository(db);
const todos = new NeoTodoSessionRepository(db);
store.openAsk({ id: 'synthetic-ask', projectId: null, sessionId: 'synthetic-neo', originMessageId: null, title: 'Synthetic', request: 'Synthetic', createdAt: 1 });
db.prepare('UPDATE neo_asks SET repo = ? WHERE id = ?').run('github.com/synthetic/project', 'synthetic-ask');
assert.equal((db.prepare('SELECT repo FROM neo_asks WHERE id = ?').get('synthetic-ask') as { repo: string }).repo, 'github.com/synthetic/project');
store.addTodo('todo-plan', 'synthetic-ask', { title: 'Plan', doneWhen: 'Synthetic', check: null, instruction: 'Synthetic', named: null }, 1);
try {
  assert.notEqual(app.server.port, 8399);
  store.addTodo('todo-card-error', 'synthetic-ask', { title: 'Card error', doneWhen: 'Synthetic', check: null, instruction: 'Synthetic', named: null }, 1);
  const registry = app.sessionManager.getOperationRegistry();
  const getRegistry = app.sessionManager.getOperationRegistry;
  let cardError;
  try {
    app.sessionManager.getOperationRegistry = () => { throw new Error('synthetic question failure'); };
    cardError = await invokeOperation(registry, 'work.start', input('card-error', 'todo-card-error'), neo);
  } finally {
    app.sessionManager.getOperationRegistry = getRegistry;
  }
  assert.equal(cardError.kind, 'completed', 'a failed question must not prevent work from starting');
  const afterCardError = (cardError as { value: Result<WorkStarted> }).value;
  assert(afterCardError.ok, JSON.stringify(afterCardError));
  todos.bind('todo-card-error', afterCardError.value.ref, Date.now());
  store.updateTodo(store.getTodo('todo-card-error')!, { state: 'doing' }, 2);
  db.prepare("INSERT INTO neo_session_bindings (session_id, kind) VALUES (?, 'neo')").run(neo.sessionId);
  store.addTodo('todo-card-refused', 'synthetic-ask', { title: 'Card refused', doneWhen: 'Synthetic', check: null, instruction: 'Synthetic', named: null }, 1);
  const noteCount = () => (db.prepare("SELECT count(*) AS n FROM job_queue WHERE queue = 'neo_notes' AND payload LIKE '%settings question%'").get() as { n: number }).n;
  const notesBeforeRefusal = noteCount();
  let cardRefused;
  try {
    app.sessionManager.getOperationRegistry = () => createOperationRegistry(registry.entries.filter((entry) => entry.name !== 'pack.preferences.ask'));
    cardRefused = await invokeOperation(registry, 'work.start', input('card-refused', 'todo-card-refused'), neo);
  } finally {
    app.sessionManager.getOperationRegistry = getRegistry;
  }
  assert.equal(cardRefused.kind, 'completed');
  const afterCardRefused = (cardRefused as { value: Result<WorkStarted> }).value;
  assert(afterCardRefused.ok, JSON.stringify(afterCardRefused));
  assert.equal(noteCount(), notesBeforeRefusal + 1, 'a refused question must leave a note for Neo');
  todos.bind('todo-card-refused', afterCardRefused.value.ref, Date.now());
  store.updateTodo(store.getTodo('todo-card-refused')!, { state: 'doing' }, 2);
  const first = await start('first', neo);
  const record = db.prepare(`SELECT kind, started_by AS startedBy, ask_id AS askId, todo_id AS todoId,
    machine, folder, harness FROM work_started_sessions WHERE adapter = 'hyperneo' AND id = ?`).get(first.id) as {
      kind: string; startedBy: string; askId: string; todoId: string; machine: string; folder: string; harness: string;
    };
  assert.equal(record.kind, 'worker');
  assert.equal(record.startedBy, `session:${neo.sessionId}`);
  assert.equal(record.askId, 'synthetic-ask');
  assert.equal(record.todoId, 'todo-plan');
  assert.equal(record.machine, place.machine);
  assert.equal(record.folder, folder);
  assert.equal(record.harness, 'hyperneo');
  const questions = db.prepare("SELECT count(*) AS n FROM neo_pack_preference_proposals WHERE request_id LIKE 'core.sessionReuse:%'").get() as { n: number };
  assert.equal(questions.n, 1, 'the first eligible start opens a reuse question');
  await settle([first.id]);
  const byHuman = await start('human', human);
  await settle([first.id, byHuman.id]);
  const before = sessions();
  const second = await start('second', neo);
  const afterReuse = sessions();
  await settle([second.id]);
  for (const id of [first.id, byHuman.id]) {
    store.addTodo(`todo-${id}`, 'synthetic-ask', { title: id, doneWhen: 'Synthetic', check: null, instruction: 'Synthetic', named: null }, 1);
    todos.create(`todo-${id}`, { verb: 'start', adapter: 'hyperneo', place });
    todos.recordRef(`todo-${id}`, { adapter: 'hyperneo', id });
    store.updateTodo(store.getTodo(`todo-${id}`)!, { state: 'doing' }, 2);
  }
  const third = await start('third', neo);
  const afterThird = sessions();
  const lease = (id: string, state: 'doing' | 'done', bindRef: boolean) => {
    store.addTodo(`todo-${id}`, 'synthetic-ask', { title: id, doneWhen: 'Synthetic', check: null, instruction: 'Synthetic', named: null }, 1);
    if (bindRef) todos.bind(`todo-${id}`, { adapter: 'hyperneo', id }, Date.now());
    store.updateTodo(store.getTodo(`todo-${id}`)!, { state }, 2);
  };
  lease(third.id, 'doing', true);
  const reviewer = await app.sessionManager.createSession({ workspacePath: folder, title: 'Human review', worktreeMode: 'direct', createdBy: 'human' });
  lease(reviewer, 'done', true);
  await settle([reviewer]);
  const beforeBuild = sessions();
  store.addTodo('todo-build', 'synthetic-ask', { title: 'Build', doneWhen: 'Synthetic', check: null, instruction: 'Synthetic', named: null }, 3);
  const build = await start('build', neo, 'todo-build');
  const observed = {
    first: { reused: first.reused, record },
    humanStart: { reused: byHuman.reused, newSession: byHuman.id !== first.id },
    neoSecond: { reused: second.reused, sameRefAsEarlier: [first.id, byHuman.id].includes(second.id), sessionsBefore: before, sessionsAfter: afterReuse },
    neoThirdAllLeased: { reused: third.reused, newSession: ![first.id, byHuman.id].includes(third.id), sessionsAfter: afterThird },
    neoBuildBesideFreeHumanReviewer: { reused: build.reused, gotReviewer: build.id === reviewer, sessionsBefore: beforeBuild, sessionsAfter: sessions() },
    mainThreadStartedSessionSql: mainStartedSql.length,
  };
  writeFileSync(join(run, 'evidence/work-start-reuse.json'), JSON.stringify(observed, null, 2));
  console.log(JSON.stringify(observed, null, 2));
  assert.equal(first.reused, false);
  assert.equal(byHuman.reused, false);
  assert.notEqual(byHuman.id, first.id);
  assert.equal(second.reused, true);
  assert(observed.neoSecond.sameRefAsEarlier);
  assert.equal(afterReuse, before);
  assert.equal(third.reused, false);
  assert(observed.neoThirdAllLeased.newSession);
  assert.equal(observed.neoThirdAllLeased.sessionsAfter, afterReuse + 1);
  assert.equal(build.reused, false);
  assert.equal(observed.neoBuildBesideFreeHumanReviewer.gotReviewer, false);
  assert.equal(observed.neoBuildBesideFreeHumanReviewer.sessionsAfter, beforeBuild + 1);
  assert.equal(mainStartedSql.length, 0, 'work.start must record and pick workers through the gateway');
  lease(build.id, 'doing', true);
  db.prepare(`INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
    VALUES ('core', 'global', '', 'sessionReuse', '"per_todo"', 'human', 1)`).run();
  store.addTodo('todo-separate', 'synthetic-ask', { title: 'Separate', doneWhen: 'Synthetic', check: null, instruction: 'Synthetic', named: null }, 4);
  const separate = await start('separate', neo, 'todo-separate');
  assert.equal(separate.reused, false);
  assert(![first.id, byHuman.id, third.id, build.id].includes(separate.id));
  await settle([first.id, third.id, build.id, separate.id]);
  lease(separate.id, 'doing', true);
  db.prepare(`UPDATE neo_pack_preferences SET value_json='"per_ask"' WHERE pack='core' AND key='sessionReuse'`).run();
  store.addTodo('todo-wait', 'synthetic-ask', { title: 'Wait', doneWhen: 'Synthetic', check: null, instruction: 'Synthetic', named: null }, 5);
  todos.create('todo-wait', { verb: 'start', adapter: 'hyperneo', place });
  store.updateTodo(store.getTodo('todo-wait')!, { state: 'doing', startedAt: 5 }, 5);
  const waiting = await invokeOperation(app.sessionManager.getOperationRegistry(), 'work.start', input('wait', 'todo-wait'), neo);
  assert.equal(waiting.kind, 'completed');
  assert.equal((waiting as { value: { reason?: string } }).value.reason, 'worker_busy');
  assert.equal(store.getTodo('todo-wait')?.state, 'todo');
  assert.equal(todos.get('todo-wait')?.verb, 'send');
  store.addTodo('todo-bound', 'synthetic-ask', { title: 'Bound', doneWhen: 'Synthetic', check: null, instruction: 'Synthetic', named: null }, 6);
  todos.bind('todo-bound', { adapter: 'hyperneo', id: first.id }, Date.now());
  store.updateTodo(store.getTodo('todo-bound')!, { state: 'doing', startedAt: 6 }, 6);
  const bound = await start('bound', neo, 'todo-bound');
  assert.equal(bound.reused, false);
  store.updateTodo(store.getTodo(`todo-${separate.id}`)!, { state: 'done' }, Date.now());
  await settle([separate.id]);
  assert(readReusableWorkers(db, 'hyperneo').has(separate.id));
  const noTodo = await invokeOperation(app.sessionManager.getOperationRegistry(), 'work.start', input('no-todo'), neo);
  assert.equal(noTodo.kind, 'completed');
  const noTodoResult = (noTodo as { value: Result<WorkStarted> }).value;
  assert(noTodoResult.ok, JSON.stringify(noTodoResult));
  assert.notEqual(noTodoResult.value.reused, true, 'a start without an ask must not reuse another matter');
  const otherNeo = { ...neo, sessionId: 'other-synthetic-neo' };
  const foreignTodo = await start('foreign-todo', otherNeo, 'todo-wait');
  assert.equal(foreignTodo.reused, false, 'a start for another owner must not reuse another matter');
  assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
  const socket = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  let remote;
  try {
    await new Promise<void>((done, fail) => { socket.onopen = () => done(); socket.onerror = () => fail(new Error('RPC unavailable')); });
    const sender = createOperationRegistry(createWorkVerbOperations({
      adapters: () => [], daemonName: 'synthetic-origin',
      remote: {
        list: () => [{ daemonId: 'synthetic-peer' }],
        invoke: async (_daemon, name, value) => new Promise((done, fail) => {
          const id = crypto.randomUUID();
          const timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
          socket.onmessage = (event) => {
            const reply = JSON.parse(String(event.data));
            if (reply.requestId !== id && reply.id !== id) return;
            clearTimeout(timer);
            if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
          };
          socket.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input: value }, timestamp: new Date().toISOString(), version: '1.0.0' }));
        }),
      },
    }));
    const result = await invokeOperation(sender, 'work.start', { ...input('remote', 'todo-wait'), place: { ...place, daemon: 'synthetic-peer' } }, neo);
    assert.equal(result.kind, 'completed');
    const reply = (result as { value: Result<WorkStarted> }).value;
    assert(reply.ok, JSON.stringify(reply));
    assert.notEqual(reply.value.ref.id, separate.id);
    assert.notEqual(reply.value.reused, true);
    remote = { newSession: reply.value.ref.id !== separate.id, reused: reply.value.reused === true };
  } finally { socket.close(); }
  writeFileSync(join(run, 'evidence/session-reuse-dispatch.json'), JSON.stringify({ perTodo: separate, perAsk: { reason: 'worker_busy', state: store.getTodo('todo-wait')?.state, target: todos.get('todo-wait')?.verb }, noTodo: { reused: noTodoResult.value.reused === true }, foreignTodo, remote }, null, 2));
} finally {
  await app.cleanup();
}
