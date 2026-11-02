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
const start = async (title: string, caller: Parameters<typeof invokeOperation>[3], todoId='todo-plan') => {
  const outcome = await invokeOperation(app.sessionManager.getOperationRegistry(), 'work.start', input(title, caller.role === 'neo' ? todoId : undefined), caller);
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('workers never went idle');
};
await app.jobProcessor.stop();
const db = app.db.getDatabase();
const store = new NeoAskTodoRepository(db);
const todos = new NeoTodoSessionRepository(db);
store.openAsk({ id: 'synthetic-ask', projectId: null, repo: 'github.com/synthetic/project', sessionId: 'synthetic-neo', originMessageId: null, title: 'Synthetic', request: 'Synthetic', createdAt: 1 });
store.addTodo('todo-plan', 'synthetic-ask', { title: 'Plan', doneWhen: 'Synthetic', check: null, instruction: 'Synthetic', named: null }, 1);
try {
  assert.notEqual(app.server.port, 8399);
  const first = await start('first', neo);
  await settle([first.id]);
  todos.create('todo-plan',{verb:'start',adapter:'hyperneo',place});todos.recordRef('todo-plan',{adapter:'hyperneo',id:first.id});
  store.updateTodo(store.getTodo('todo-plan')!,{state:'done'},Date.now());
  store.openAsk({id:'other-ask',projectId:null,repo:'github.com/synthetic/project',sessionId:neo.sessionId,originMessageId:null,title:'Different matter',request:'Synthetic other matter',createdAt:Date.now()});
  store.addTodo('other-todo','other-ask',{title:'Other step',doneWhen:'Observed',check:null,instruction:null,named:null},Date.now());
  const other=await start('other matter',neo,'other-todo');await settle([first.id,other.id]);
  const observed={first,other,otherAskDidNotBorrowCompletedTodoWorker:other.id!==first.id};
  writeFileSync(join(run,'evidence/worker-matter.json'),JSON.stringify(observed,null,2));
  assert.notEqual(other.id,first.id,'a worker on an OPEN ask cannot be borrowed merely because its todo completed');
  const before=sessions();const same=await start('same matter next step',neo);await settle([same.id]);
  assert.equal(same.id,first.id,'reuse the idle worker already owned by this ask');assert(same.reused);assert.equal(sessions(),before);
  const humanStart=await start('human',human);assert.notEqual(humanStart.id,first.id);assert(!humanStart.reused);
  writeFileSync(join(run,'evidence/worker-matter.json'),JSON.stringify({...observed,same,humanStart,sessionsBeforeReuse:before,sessionsAfterReuse:before,pass:true},null,2));
  console.log('PASS real work.start keeps completed-todo workers on their open ask, reuses the same matter, and keeps human starts fresh');

} finally {
  await app.cleanup();
}
