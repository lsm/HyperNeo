import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { Result, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
const folder = join(run, 'project');
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(folder, { recursive: true });
assert.equal(spawnSync('git', ['init', '-q', '--initial-branch=dev', folder]).status, 0);
assert.equal(
  spawnSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'initial'], { cwd: folder }).status,
  0
);
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
const place = { machine: hostname(), folder, name: 'Synthetic' };
const input = (title: string, todoId?: string) => ({ adapter: 'hyperneo', place, title, message: `Synthetic task: ${title}`, ...(todoId ? { todoId } : {}) });
const start = async (title: string, caller: Parameters<typeof invokeOperation>[3]) => {
  const outcome = await invokeOperation(app.sessionManager.getOperationRegistry(), 'work.start', input(title, caller.role === 'neo' ? 'todo-plan' : undefined), caller);
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
store.openAsk({ id: 'synthetic-ask', projectId: null, repo: 'github.com/synthetic/project', sessionId: 'synthetic-neo', originMessageId: null, title: 'Synthetic', request: 'Synthetic', createdAt: 1 });
store.addTodo('todo-plan', 'synthetic-ask', { title: 'Plan', doneWhen: 'Synthetic', check: null, instruction: 'Synthetic', named: null }, 1);
try {
  assert.notEqual(app.server.port, 8399);
  const first = await start('first', neo);
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
  const observed = {
    first: { reused: first.reused },
    humanStart: { reused: byHuman.reused, newSession: byHuman.id !== first.id },
    neoSecond: { reused: second.reused, sameRefAsEarlier: [first.id, byHuman.id].includes(second.id), sessionsBefore: before, sessionsAfter: afterReuse },
    neoThirdAllLeased: { reused: third.reused, newSession: ![first.id, byHuman.id].includes(third.id), sessionsAfter: sessions() },
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
} finally {
  await app.cleanup();
}
