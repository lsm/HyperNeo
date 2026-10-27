import { createCodingPackTables } from '../../../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { recordOperationRefusal } from '../../../packages/daemon/src/storage/repositories/operation-refusal-repository.ts';
import { gatewayFor } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { createNeoTodoRunner } from '../../../packages/daemon/src/lib/neo/todo-runner.ts';
import { createNeoTodoOperations } from '../../../packages/daemon/src/lib/neo/todo-operations.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'data'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
let removed = '';
for (const phase of ['initial', 'reopen']) {
  const db = new Database(join(run, 'data/daemon.db'));
  try {
    runMigrations(db, () => {}); createTables(db); createCodingPackTables(db);
    const store = new NeoAskTodoRepository(db), sessions = new NeoTodoSessionRepository(db);
    const unexpected = async (): Promise<never> => { throw new Error('No worker dispatch is permitted'); };
    const runner = createNeoTodoRunner({ write: gatewayFor(db).run.bind(gatewayFor(db)), store, sessions, invoke: unexpected, packs: () => [], tell: unexpected, changed: () => {} });
    const registry = createOperationRegistry(createNeoTodoOperations(store, sessions, { ...runner, resolveTarget: unexpected }, () => [], () => null));
    const handler = createOperationMcpHandler(registry, () => ({ sessionId: 'neo', role: 'neo' }), (refusal) => gatewayFor(db).run(recordOperationRefusal, { refusal, sessionId: 'neo', at: Date.now() }));
    const call = async (name: string, input: unknown, code: string) => {
      const reply = await handler({ name, input }), result = JSON.parse(reply.content[0].text);
      evidence.push({ phase, name, reply });
      assert.equal(reply.isError ?? false, false); assert.equal(result.ok, true, JSON.stringify(result));
      assert(result.records.some((record: string) => record.startsWith(code + ':')));
      return result;
    };
    if (phase === 'initial') {
      const ask = store.openAsk({ id: 'ask', projectId: null, sessionId: 'neo', originMessageId: null, title: 'Synthetic ask', request: 'Record bookkeeping', createdAt: 1 });
      const todo = store.addTodo('waiting', ask.id, { title: 'Waiting work', doneWhen: 'Observed result', instruction: 'Work', check: null, named: null }, 1);
      store.joinStartQuestion(todo, 2);
      const before = store.getTodo(todo.id), cards = store.listQuestions(ask.id);
      await call('neo.todo.retry', { todoId: todo.id }, 'not_retryable');
      await call('neo.todo.continue', { todoId: todo.id, message: 'Follow up' }, 'not_started');
      assert.deepEqual(store.getTodo(todo.id), before); assert.deepEqual(store.listQuestions(ask.id), cards);
      const result = await call('neo.todo.remove', { todoId: todo.id, replacedBy: 'missing', reason: 'Superseded' }, 'replacement_missing');
      assert.equal(result.todo.state, 'removed'); assert.equal(result.todo.replacedBy, null); removed = todo.id;
      store.settleAsk(ask, 'dropped', 'Synthetic drop', 3);
      await call('neo.todo.add', { askId: ask.id, title: 'Late work', check: { pack: 'core', kind: 'evidence', params: { artifact: 'synthetic-missing' } } }, 'ask_settled');
      await call('neo.todo.continue', { todoId: todo.id, message: 'Late follow-up' }, 'ask_settled');
      assert.equal(store.listTodos(ask.id).length, 1);
    }
    assert.equal(store.getTodo(removed)?.state, 'removed');
    const audits = db.prepare('SELECT operation,reason,accepted FROM operation_refusals ORDER BY id').all();
    assert.equal(audits.length, 5); assert(audits.every((audit) => (audit as { accepted: number }).accepted === 1));
    evidence.push({ phase, audits, todos: store.listTodos('ask'), questions: store.listQuestions('ask') });
  } finally { await gatewayFor(db).close(); db.close(); writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2)); }
}
console.log('PASS: tool-visible no-op/removal records, untouched start card, and five accepted audit records survive DB reopen.');
