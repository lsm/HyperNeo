import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { recordOperationRefusal } from '../../../packages/daemon/src/storage/repositories/operation-refusal-repository.ts';
import { gatewayFor } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { createNeoAskRecordOperations } from '../../../packages/daemon/src/lib/neo/ask-record-operations.ts';
import { createNeoWorkerQuestionWriter, createNeoQuestionOperations } from '../../../packages/daemon/src/lib/neo/question-operations.ts';
import { createNeoAskReadOperation, createNeoDoneTodosOperation } from '../../../packages/daemon/src/lib/neo/ask-entries.ts';
import { createOperationRegistry, type OperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createDiscoveryOperations } from '../../../packages/daemon/src/lib/operations/discovery.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'data'), { recursive: true }); mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
for (const phase of ['initial', 'reopen']) {
  const db = new Database(join(run, 'data/daemon.db'));
  try {
    runMigrations(db, () => {}); createTables(db);
    const store = new NeoAskTodoRepository(db), sessions = new NeoTodoSessionRepository(db);
    const unexpected = async (): Promise<never> => { throw new Error('No worker dispatch or answer is permitted'); };
    const admit = (caller: Parameters<typeof createNeoAskReadOperation>[2] extends (arg: infer T) => unknown ? T : never) => ({ value: caller });
    const project = async <T,>(items: readonly T[]) => [...items];
    const registry: OperationRegistry = createOperationRegistry([
      ...createDiscoveryOperations(() => registry),
      ...createNeoAskRecordOperations(store, sessions, { start: unexpected, proceed: unexpected, retry: unexpected, stop: async () => null, recompute: async (todo, patch) => store.updateTodo(todo, patch, Date.now()) }, () => null, () => true, () => []),
      ...createNeoQuestionOperations(store, unexpected, unexpected),
      createNeoAskReadOperation(store, () => [], admit, project),
      createNeoDoneTodosOperation(store, sessions, () => [], admit, project),
    ]);
    const handler = createOperationMcpHandler(registry, () => ({ sessionId: 'neo', role: 'neo' }), (refusal) => gatewayFor(db).run(recordOperationRefusal, { refusal, sessionId: 'neo', at: Date.now() }));
    const call = async (name: string, input: unknown) => {
      const reply = await handler({ name, input }), result = JSON.parse(reply.content[0].text);
      evidence.push({ phase, name, reply }); assert.equal(reply.isError ?? false, false); assert(result.ok === true || result.found === true, JSON.stringify(result)); return result;
    };
    const described = await call('operations.describe', { name: 'neo.question.ask' });
    assert.equal(described.found, true);
    assert(described.description.includes('If a supplied todoId is unknown, belongs to another ask, or is done, closed unverified or removed'));
    assert(described.description.includes('return a todo_closed record and open the question on the ask without linking that todo'));
    if (phase === 'initial') {
      const ask = store.openAsk({ id: 'ask', projectId: null, sessionId: 'neo', originMessageId: null, title: 'Synthetic ask', request: 'Close unverified work visibly', createdAt: 1 });
      const unfinished = store.addTodo('unfinished', ask.id, { title: 'Unverified delivery', doneWhen: 'Build served and observed', instruction: null, check: null, named: null }, 1);
      const ref = { adapter: 'hyperneo', id: 'synthetic-worker' };
      sessions.create(unfinished.id, { verb: 'send', ref }); sessions.recordRef(unfinished.id, ref, 2);
      store.updateTodo(unfinished, { state: 'doing', startedAt: 2 }, 2);
      const writer = createNeoWorkerQuestionWriter(store, sessions, () => 'en', async () => ({ ...ref, name: 'Worker', label: 'HyperNeo · Worker', provider: 'HyperNeo', link: null }));
      const workerQuestion = await writer(ref, { todoId: unfinished.id, kind: 'question', title: 'Which target?', options: ['First', 'Second'], language: 'en', report: 'Synthetic human decision required.' });
      assert.equal(workerQuestion.ok, true); assert.equal(store.getTodo(unfinished.id)?.blockedBy, 'needs-human');
      evidence.push({ beforeSettlement: store.getTodo(unfinished.id), workerQuestion });
      const closed = store.addTodo('closed', ask.id, { title: 'Closed work', doneWhen: 'Checked', instruction: null, check: null, named: null }, 1);
      store.updateTodo(closed, { state: 'closed_unverified', reason: 'Not observed' }, 2);
      const question = await call('neo.question.ask', { askId: ask.id, todoId: closed.id, text: 'What next?', kind: 'reply' });
      assert(question.records[0].startsWith('todo_closed:')); assert.equal(question.question.todoId ?? null, null);
      const settled = await call('neo.ask.settle', { askId: ask.id, status: 'done', outcome: 'Closing without verified outcomes' });
      assert(settled.records[0].startsWith('todos_unfinished:'));
      assert(settled.todos.every((todo: { state: string }) => todo.state === 'closed_unverified'));
      store.openAsk({ id: 'child', parentId: ask.id, repo: 'github.com/synthetic/child', projectId: null, sessionId: ask.sessionId, originMessageId: null, title: 'Child card', request: 'Filed work', createdAt: 1 });
      const retry = await call('neo.ask.open', { title: ask.title, request: 'Follow-up', todos: [{ title: 'New follow-up', doneWhen: 'Observed result' }] });
      assert.equal(retry.ask.id, ask.id); assert.equal(retry.todos.length, 2);
      assert(retry.records[0].includes('Open a new ask for it with a different title'));

    }
    const read = await call('neo.ask.read', { askId: 'ask' });
    assert(read.entry.todos.every((todo: { state: string }) => todo.state === 'closed_unverified'));
    assert.equal(read.entry.doneCount, 0);
    assert((await call('neo.ask.doneTodos', { askId: 'ask' })).todos.length === 0);
    assert(store.listQuestions('ask').every((question) => question.state === 'retired' && question.answer === null && question.answeredBy === null));
    const audits = db.prepare('SELECT operation,reason,accepted FROM operation_refusals ORDER BY id').all();
    assert.equal(audits.length, 3); assert(audits.every((audit) => (audit as { accepted: number }).accepted === 1));
    evidence.push({ phase, audits, todos: store.listTodos('ask') });
  } finally { await gatewayFor(db).close(); db.close(); writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2)); }
}
console.log('PASS: MCP catalog and settled-ask guidance match record behavior; unverified rows, unanswered questions and accepted audit records survive DB reopen.');
