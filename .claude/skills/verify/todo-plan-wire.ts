import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

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
  const owner = 'neo:00000000-0000-4000-8000-000000000538';
  const caller = { source: 'internal' as const, role: 'neo' as const, sessionId: owner };
  const timestamp = new Date().toISOString();
  db.prepare('INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(owner, 'Synthetic Neo', 'general', folder, timestamp, timestamp, 'active', '{}', '{}');
  new NeoRepository(db).reserveBinding({ sessionId: owner, kind: 'neo', projectId: null });
  store.openAsk({ id: 'ask', projectId: null, sessionId: owner, originMessageId: null, title: 'Synthetic plan', request: 'Synthetic request', createdAt: 1 });
  const call = async (name: string, input: object) => {
    const outcome = await invokeOperation(registry, name, input, caller);
    assert(outcome.kind === 'completed', JSON.stringify(outcome));
    return outcome.value as { ok: boolean; reason?: string; todo?: NeoTodo };
  };
  const check = { pack: 'core', kind: 'evidence', params: { path: join(folder, 'plan.md') } };
  const add = (title: string, after: string[], plan?: true) =>
    call('neo.todo.add', { askId: 'ask', title, check, after, ...(plan ? { plan } : {}) });
  const refuse = async (label: string, result: ReturnType<typeof call>, reason: string) => {
    const reply = await result;
    observed[label] = reply;
    assert.equal(reply.ok, false, JSON.stringify(reply));
    assert(reply.reason?.startsWith(reason), JSON.stringify(reply));
  };
  const plan = await add('Plan the cache change', [], true);
  observed.add = plan;
  assert(plan.ok && plan.todo?.plan && plan.todo.producesFollowUp, JSON.stringify(plan));
  const todoId = plan.todo.id;
  await refuse('done with no steps', call('neo.todo.done', { todoId }), 'plan_steps_missing');
  const step = await add('Implement cache expiry', [todoId]);
  assert(step.ok && step.todo, JSON.stringify(step));
  const stepId = step.todo.id;
  await refuse('edit to done before checking', call('neo.todo.edit', { todoId, done: 'met', evidence: 'Written' }), 'plan_check_missing');
  await refuse('remove the last step', call('neo.todo.remove', { todoId: stepId, reason: 'Obsolete' }), 'plan_steps_missing');
  await refuse('detach the last step', call('neo.todo.edit', { todoId: stepId, after: [] }), 'plan_steps_missing');
  const unrelated = await add('Unrelated work', []);
  assert(unrelated.ok && unrelated.todo, JSON.stringify(unrelated));
  await refuse('replace with unrelated work', call('neo.todo.remove', { todoId: stepId, reason: 'Obsolete', replacedBy: unrelated.todo.id }), 'plan_steps_missing');
  const dropped = await call('neo.ask.settle', { askId: 'ask', status: 'dropped', outcome: 'Abandoned' });
  observed.dropped = dropped;
  assert(dropped.ok, JSON.stringify(dropped));
  console.log('PASS: plan admission, completion refusals, removal refusals, dropped ask; count=7');
} catch (error) {
  observed.error = String(error);
  throw error;
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  await app.cleanup();
}
