import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import type { Result, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const folder = join(run, 'project');
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(folder, { recursive: true });
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: folder }), disableWorktrees: true }, verbose: false });
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  const store = new NeoAskTodoRepository(db);
  const registry = app.sessionManager.getOperationRegistry();
  const caller = { source: 'internal' as const, role: 'neo' as const, sessionId: 'synthetic-neo' };
  const place = { machine: hostname(), folder, name: 'Synthetic' };
  store.openAsk({ id: 'ask', projectId: null, sessionId: caller.sessionId, originMessageId: null, title: 'Synthetic', request: 'Synthetic', createdAt: 1 });
  const todo = (id: string) => store.addTodo(id, 'ask', { title: id, doneWhen: 'Observed', check: null, instruction: 'Synthetic', named: null }, 1);
  db.prepare(`INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
    VALUES ('core', 'global', '', 'sessionReuse', '"per_todo"', 'human', 1)`).run();
  const start = async (todoId: string, role: string, excludeRefs: {adapter: string; id: string}[] = []) => {
    const outcome = await invokeOperation(registry, 'work.start', { adapter: 'hyperneo', place, title: todoId, message: `Synthetic ${role}`, todoId, role, excludeRefs }, caller);
    assert.equal(outcome.kind, 'completed', JSON.stringify(outcome));
    const result = (outcome as { value: Result<WorkStarted> }).value;
    assert(result.ok, JSON.stringify(result));
    return result.value;
  };
  const settle = async (ref: {adapter: string; id: string}) => {
    for (let i = 0; i < 100; i++) {
      const outcome = await invokeOperation(registry, 'work.status', { ref }, caller);
      if (outcome.kind === 'completed' && (outcome.value as {ok: boolean; value?: {status: string}}).value?.status === 'done') return;
      await Bun.sleep(100);
    }
    throw new Error('worker did not become idle');
  };
  const refs = [];
  for (const id of ['seed-a', 'seed-b']) {
    todo(id);
    const started = await start(id, 'do');
    assert.notEqual(started.reused, true);
    store.updateTodo(store.getTodo(id)!, { state: 'done' }, 2);
    await settle(started.ref);
    refs.push(started.ref);
  }
  const seeded = db.prepare(`SELECT todo_id, role, id FROM neo_todo_roles WHERE todo_id IN ('seed-a','seed-b') ORDER BY todo_id`).all();
  assert.deepEqual(seeded, [
    { todo_id: 'seed-a', role: 'do', id: refs[0].id },
    { todo_id: 'seed-b', role: 'do', id: refs[1].id },
  ]);
  db.prepare(`UPDATE neo_pack_preferences SET value_json='"long_lived"' WHERE pack='core' AND key='sessionReuse'`).run();
  todo('roles');
  const author = await start('roles', 'do', [refs[1]]);
  const reviewer = await start('roles', 'review', [refs[0]]);
  assert.equal(author.reused, true);
  assert.equal(reviewer.reused, true);
  assert.equal(author.ref.id, refs[0].id);
  assert.equal(reviewer.ref.id, refs[1].id);
  const rows = db.prepare(`SELECT role, adapter, id FROM neo_todo_roles WHERE todo_id='roles' ORDER BY rowid`).all();
  assert.deepEqual(rows, [{ role: 'do', ...refs[0] }, { role: 'review', ...refs[1] }]);
  writeFileSync(join(run, 'evidence/worker-role-claims.json'), JSON.stringify({ seeded, author: author.ref, reviewer: reviewer.ref, bothReused: true, rows }, null, 2));
  console.log('PASS: work.start reused separate idle workers and recorded their todo roles; count=2');
} finally {
  await app.cleanup();
}
