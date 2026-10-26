import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createCodingTodoPack, CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
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
const check = { pack: 'coding', kind: 'pr_merged', params: { urls: ['https://github.com/synthetic/proof/pull/1'] } };
let created = '';
let audits = 0;
try {
  for (const phase of ['initial', 'restart']) {
    const db = new Database(join(run, 'data/daemon.db'));
    try {
      runMigrations(db, () => {});
      createTables(db);
      const store = new NeoAskTodoRepository(db);
      const sessions = new NeoTodoSessionRepository(db);
      const coding = { id: 'coding', describe: 'Synthetic coding', todos: createCodingTodoPack(new CodingTodoPrRepository(db), async () => []) };
      coding.todos.schema(db);
      const unexpected = async (): Promise<never> => { throw new Error('No worker may run'); };
      const registry = createOperationRegistry(createNeoTodoOperations(store, sessions, {
        start: unexpected, proceed: unexpected, retry: unexpected, stop: async () => null,
        recompute: async (todo, patch) => store.updateTodo(todo, patch, Date.now()),
      }, () => [coding], () => null));
      const handler = createOperationMcpHandler(() => registry, () => ({ sessionId: 'neo', role: 'neo' }), async () => {
        audits++;
        throw new Error('Synthetic audit unavailable after the mutation');
      });
      const invoke = async (name: string, input: unknown) => {
        const reply = await handler({ name, input });
        const result = JSON.parse(reply.content[0].text);
        evidence.push({ phase, name, input, reply });
        assert.equal(reply.isError ?? false, false, JSON.stringify(result));
        assert.equal(result.ok, true, JSON.stringify(result));
        assert(result.records[0].startsWith('pr_already_tracked:'));
        return result;
      };
      if (phase === 'initial') {
        store.openAsk({ id: 'ask', title: 'Synthetic audit failure', request: 'Preserve the committed result', sessionId: 'neo', projectId: null, originMessageId: null, createdAt: Date.now() });
        store.addTodo('original', 'ask', { title: 'Original', doneWhen: 'Merged', check, instruction: null, named: null }, Date.now());
        const added = await invoke('neo.todo.add', { askId: 'ask', title: 'Follow-up', doneWhen: 'Merged', check });
        created = added.todo.id;
        const edited = await invoke('neo.todo.edit', { todoId: created, title: 'Edited despite audit failure', addUrls: check.params.urls });
        assert.equal(edited.todo.id, created);
        assert.equal(audits, 2);
      }
      assert.equal(store.listTodos('ask').length, 2);
      assert.equal(store.getTodo(created)?.title, 'Edited despite audit failure');
      evidence.push({ phase, audits, todos: store.listTodos('ask') });
    } finally { db.close(); }
  }
  console.log('PASS: actual todo add/edit MCP replies remain successful after audit failure; exactly one added todo and its edit survive database reopen.');
} finally { writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2)); }
