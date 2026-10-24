import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const sender = 'neo:10000000-0000-4000-8000-000000000002';
const ref = { adapter: 'hyperneo', id: 'synthetic-running-worker' };
let ids: string[] = [];
let sends = 0;
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP is disabled'); }) as typeof fetch;
try {
  for (const phase of ['initial', 'restart']) {
    const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    try {
      await app.jobProcessor.stop();
      assert.notEqual(app.server.port, 8399);
      const db = app.db.getDatabase(), store = new NeoAskTodoRepository(db), sessions = new NeoTodoSessionRepository(db);
      const production = app.sessionManager.getOperationRegistry();
      const registry = createOperationRegistry(production.entries.map(op => ['work.send', 'work.start'].includes(op.name) ? { ...op, execute: async () => { sends++; throw new Error('Unexpected dispatch'); } } : op));
      app.sessionManager.setOperationRegistryProvider(() => registry);
      const handler = createOperationMcpHandler(() => registry, () => ({ sessionId: sender, role: 'neo' }));
      const invoke = async (name: string, input: unknown) => {
        const reply = await handler({ name, input });
        const result = JSON.parse(reply.content[0].text);
        evidence.push({ phase, name, input, result });
        assert.equal(reply.isError ?? false, false, JSON.stringify(result));
        assert.equal(result.ok, true, JSON.stringify(result));
        return result;
      };
      if (phase === 'initial') {
        for (const id of [sender, ref.id]) db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic worker', '/tmp', '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z', 'active', '{}', '{}')").run(id);
        new NeoRepository(db).reserveBinding({ sessionId: sender, kind: 'neo', projectId: null });
        const opened = await invoke('neo.ask.open', { title: 'Synthetic in-progress work', request: 'Track already running work without sending it again', todos: [{ title: 'Running task', doneWhen: 'Synthetic result verified', target: { verb: 'bind', ref } }] });
        const todo = opened.todos[0];
        assert.equal(todo.state, 'doing'); assert.equal(todo.worker.id, ref.id); assert.equal(todo.worker.adapter, ref.adapter);
        const withOptions = await invoke('neo.todo.add', { askId: todo.askId, title: 'Running task with retained instruction', doneWhen: 'Synthetic result verified', instruction: 'Synthetic work already running', start: true, target: { verb: 'bind', ref } });
        assert.equal(withOptions.todo.state, 'doing'); assert.equal(withOptions.todo.worker.id, ref.id);
        assert.equal(withOptions.todo.instruction, 'Synthetic work already running');
        const failed = await invoke('neo.todo.add', { askId: todo.askId, title: 'Synthetic backfill', doneWhen: 'Synthetic result verified' });
        store.updateTodo(store.getTodo(failed.todo.id)!, { state: 'failed', reason: 'Synthetic delivery was not confirmed', finishedAt: 2 }, 2);
        sessions.create(failed.todo.id, { verb: 'send', ref }); sessions.recordRef(failed.todo.id, ref, 1);
        sessions.recordSent(failed.todo.id, { inputBefore: 1, opening: 'Synthetic old instruction' });
        const rebound = await invoke('neo.todo.bind', { todoId: failed.todo.id, ref });
        assert.equal(rebound.todo.state, 'doing'); assert.equal(rebound.todo.worker.id, ref.id);
        assert.equal(rebound.todo.reason, null); assert.equal(rebound.todo.finishedAt, null);
        assert.equal(sessions.readSent(rebound.todo.id), null);
        ids = [todo.id, withOptions.todo.id, rebound.todo.id];
      }
      for (const id of ids) {
        assert.equal(store.getTodo(id)?.state, 'doing'); assert.deepEqual(sessions.readRef(id), ref);
      }
      const inputs = db.prepare('SELECT * FROM work_delivery_inputs').all();
      assert.equal(inputs.length, 0); assert.equal(sends, 0);
      evidence.push({ phase, todos: ids.map(id => store.getTodo(id)), refs: ids.map(id => sessions.readRef(id)), sends, inputs });
    } finally { await app.cleanup(); }
  }
  console.log(`PASS: actual daemon MCP bind/backfill and failed rebind are doing with the worker set; zero dispatches; restart preserved all bindings. Evidence: ${run}/evidence/todo-bind.json`);
} finally { globalThis.fetch = network; writeFileSync(join(run, 'evidence/todo-bind.json'), JSON.stringify(evidence, null, 2)); }
