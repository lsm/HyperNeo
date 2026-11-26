import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
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
  const human = { source: 'rpc' as const, principal: 'local', sessionId: owner };
  const call = async (name: string, input: object, actor: typeof caller | typeof human = caller) => {
    const outcome = await invokeOperation(registry, name, input, actor);
    assert(outcome.kind === 'completed', JSON.stringify(outcome));
    return outcome.value as { ok: boolean; reason?: string; todo?: NeoTodo; question?: NeoQuestion };
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
  const signoff = (todos?: string[]) =>
    call('neo.question.ask', {
      askId: 'ask',
      kind: 'choice',
      todoId,
      todos,
      signoff: true,
      text: 'Approve the current cache work?',
      options: ['Approve'],
    });
  await refuse('sign-off before checking', signoff([stepId]), 'plan_check_missing');
  const second = await add('Update cache docs', [todoId, unrelated.todo.id]);
  assert(second.ok && second.todo, JSON.stringify(second));
  const secondId = second.todo.id;
  const recordCheck = (stepIds: string[]) =>
    db.prepare('UPDATE neo_todos SET plan_check_json = ? WHERE id = ?').run(
      JSON.stringify({ stepIds, session: 'synthetic-checker', model: 'fixture', anotherModelUsable: true }),
      todoId
    );
  recordCheck([stepId, secondId]);
  await refuse('done before sign-off', call('neo.todo.done', { todoId }), 'plan_signoff_missing');
  const approve = async (steps: string[]) => {
    const card = await signoff(steps);
    assert(card.ok && card.question, JSON.stringify(card));
    assert.deepEqual(card.question.todos, steps);
    const answer = await call(
      'neo.question.answer', { questionId: card.question.id, answer: 'Approve' }, human
    );
    assert(answer.ok, JSON.stringify(answer));
    return answer;
  };
  observed.firstApproval = await approve([stepId, secondId]);
  const pendingSignoff = await signoff([stepId, secondId]);
  assert(pendingSignoff.ok && pendingSignoff.question?.state === 'open', JSON.stringify(pendingSignoff));
  const removed = await call('neo.todo.remove', { todoId: stepId, reason: 'Only the docs need work' });
  assert(removed.ok, JSON.stringify(removed));
  const obsoleteCard = store.getQuestion(pendingSignoff.question.id);
  assert.equal(obsoleteCard?.state, 'retired');
  observed.retiredSignoff = obsoleteCard;
  await refuse('obsolete check and sign-off', call('neo.todo.done', { todoId }), 'plan_check_missing');
  await refuse(
    'cascade would take the last step',
    call('neo.todo.remove', { todoId: unrelated.todo.id, reason: 'Obsolete', dependents: 'remove' }),
    'plan_steps_missing'
  );
  const gone = await call('neo.todo.remove', { todoId: unrelated.todo.id, reason: 'Obsolete' });
  assert(gone.ok, JSON.stringify(gone));
  const removal = store.askQuestion('remove-decision', 'ask', {
    cause: 'removed_prerequisite', kind: 'choice', text: 'Remove the dependent?',
    options: ['Continue', 'Remove these'], multiple: false, yesLabel: null, noLabel: null,
    todos: [unrelated.todo.id, secondId],
  }, Date.now());
  await refuse(
    'answer would take the last step',
    call('neo.question.answer', { questionId: removal.id, answer: 'Remove these' }, human),
    'plan_steps_missing'
  );
  assert.equal(store.getQuestion(removal.id)?.state, 'open');
  assert.notEqual(store.getTodo(secondId)?.state, 'removed');
  const continued = await call(
    'neo.question.answer', { questionId: removal.id, answer: 'Continue' }, human
  );
  assert(continued.ok, JSON.stringify(continued));
  recordCheck([secondId]);
  await refuse('obsolete sign-off alone', call('neo.todo.done', { todoId }), 'plan_signoff_missing');
  observed.updatedApproval = await approve([secondId]);
  const completed = await call('neo.todo.done', { todoId, reason: 'Plan checked and signed' });
  observed.completed = completed;
  assert(completed.ok && completed.todo?.state === 'done', JSON.stringify(completed));
  const lateStep = await add('Check the release notes', [todoId]);
  assert(lateStep.ok && lateStep.todo, JSON.stringify(lateStep));
  for (const id of [secondId, lateStep.todo.id]) {
    const finished = await call('neo.todo.done', { todoId: id, reason: 'Step finished' });
    assert(finished.ok && finished.todo?.state === 'done', JSON.stringify(finished));
  }
  const settled = await call('neo.ask.settle', { askId: 'ask', status: 'done', outcome: 'All steps done' });
  observed.settled = settled;
  assert(settled.ok, JSON.stringify(settled));
  store.openAsk({ id: 'abandoned', projectId: null, sessionId: owner, originMessageId: null, title: 'Abandoned plan', request: 'Synthetic request', createdAt: 1 });
  const abandoned = await call('neo.todo.add', { askId: 'abandoned', title: 'Plan abandoned work', check, after: [], plan: true });
  assert(abandoned.ok, JSON.stringify(abandoned));
  const dropped = await call('neo.ask.settle', { askId: 'abandoned', status: 'dropped', outcome: 'Abandoned' });
  observed.dropped = dropped;
  assert(dropped.ok, JSON.stringify(dropped));
  console.log(`PASS: plan admission, completion refusals, removal refusals, sign-off renewal, done settlement and dropped ask; recorded replies=${Object.keys(observed).length}`);
} catch (error) {
  observed.error = String(error);
  throw error;
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  await app.cleanup();
}
