import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { Result, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { WorkDeliveryInputRepository } from '../../../packages/daemon/src/storage/repositories/work-delivery-input-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const folder = join(run, 'project');
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(folder);
const app = await createDaemonApp({
  config: {
    ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: folder }),
    disableWorktrees: true,
  },
  verbose: false,
});
const observed: Record<string, unknown> = {};
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  const store = new NeoAskTodoRepository(db);
  const registry = app.sessionManager.getOperationRegistry();
  const owner = 'neo:00000000-0000-4000-8000-000000000537';
  const caller = { source: 'internal' as const, role: 'neo' as const, sessionId: owner };
  const timestamp = new Date().toISOString();
  db.prepare('INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(owner, 'Synthetic Neo', 'general', folder, timestamp, timestamp, 'active', '{}', '{}');
  new NeoRepository(db).reserveBinding({ sessionId: owner, kind: 'neo', projectId: null });
  store.openAsk({ id: 'ask', projectId: null, sessionId: owner, originMessageId: null, title: 'Synthetic plan', request: 'Synthetic request', createdAt: 1 });
  store.addTodo('plan', 'ask', { title: 'Plan', doneWhen: 'Cover the requirements', check: null, instruction: 'Document cache expiry', named: null }, 1);
  store.addTodo('step', 'ask', { title: 'Add expiry', doneWhen: 'Built', check: null, instruction: 'Preserve cache keys', named: null, dependsOn: ['plan'] }, 1);
  const startInput = {
    adapter: 'hyperneo',
    place: { machine: hostname(), folder, name: 'Synthetic' },
    title: 'Check the plan',
    message: 'Additional notes',
    todoId: 'plan',
    checkPlan: true,
  };
  const unmarked = await invokeOperation(registry, 'work.start', startInput, caller);
  observed.unmarked = unmarked;
  assert(unmarked.kind === 'completed' && (unmarked.value as { reason?: string }).reason === 'todo_required', JSON.stringify(unmarked));
  db.prepare("UPDATE neo_todos SET plan=1, evidence='Synthetic design' WHERE id='plan'").run();
  const start = await invokeOperation(registry, 'work.start', startInput, caller);
  observed.start = start;
  assert(start.kind === 'completed', JSON.stringify(start));
  const result = start.value as Result<WorkStarted>;
  assert(result.ok, JSON.stringify(result));
  const deliveries = new WorkDeliveryInputRepository(db).list('plan');
  const delivery = deliveries.find((item) => item.target.verb === 'start' && item.target.planStepIds);
  assert(delivery?.target.verb === 'start');
  assert.deepEqual(delivery.target.planStepIds, ['step']);
  for (const item of ['Document cache expiry', 'Cover the requirements', 'Synthetic design', 'Preserve cache keys', 'Additional notes'])
    assert(delivery.message.includes(item), item);
  assert(delivery.outcome && 'ref' in delivery.outcome && delivery.outcome.model, JSON.stringify(delivery.outcome));
  observed.brief = delivery.message;
  db.prepare("INSERT INTO neo_todo_roles (todo_id,role,adapter,id,at,model) VALUES ('plan','do','hyperneo','synthetic-author',1,'synthetic-author-model')").run();
  const send = (from: string, stepIds: string[]) => invokeOperation(registry, 'message.send', {
    to: owner, text: `Synthetic check ${stepIds.join(',')}`, check: { verdict: 'pass', stepIds },
  }, { source: 'internal', sessionId: from, role: 'direct_task_worker' });
  await send(result.value.ref.id, ['wrong']);
  assert.equal(store.getTodo('plan')?.planCheck, undefined);
  const report = await send(result.value.ref.id, ['step']);
  observed.report = report;
  const recorded = store.getTodo('plan')?.planCheck;
  assert(recorded && 'stepIds' in recorded, JSON.stringify(report));
  assert.deepEqual(recorded.stepIds, ['step']);
  assert.equal(recorded.session, result.value.ref.id);
  const card = await invokeOperation(registry, 'neo.question.ask', {
    askId: 'ask', kind: 'choice', todoId: 'plan', todos: ['step'], signoff: true,
    text: 'Approve the cache expiry step?', options: ['Approve'],
  }, caller);
  observed.card = card;
  assert(card.kind === 'completed' && (card.value as { ok: boolean }).ok, JSON.stringify(card));
  console.log('PASS: dormant admission, checker brief, mismatched report, recorded pass, sign-off card; count=5');
} catch (error) {
  observed.error = String(error);
  throw error;
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  await app.cleanup();
}
