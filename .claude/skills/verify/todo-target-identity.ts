import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'work'), { recursive: true });
const evidence: unknown[] = [];
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  const sender = 'neo:20000000-0000-4000-8000-000000000001';
  const worker = '10000000-0000-4000-8000-000000000001';
  for (const id of [sender, worker]) db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,type,config,metadata) VALUES (?, 'Synthetic worker', ?, '2026-10-26T00:00:00Z', '2026-10-26T00:00:00Z', 'active', 'worker', '{}', '{}')").run(id, join(run, 'work'));
  new NeoRepository(db).reserveBinding({ sessionId: sender, kind: 'neo', projectId: null });
  const todos = new NeoAskTodoRepository(db), sessions = new NeoTodoSessionRepository(db);
  todos.openAsk({ id: 'synthetic-ask', sessionId: sender, projectId: null, originMessageId: null, title: 'Synthetic ask', request: 'Track work', createdAt: 1 });
  const handler = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: sender, role: 'neo' }));
  const add = async (verb: string, id: string, start = false) => {
    const reply = await handler({ name: 'neo.todo.add', input: { askId: 'synthetic-ask', title: 'Synthetic todo', check: { pack: 'core', kind: 'evidence', params: { path: join(run, 'missing-proof') } }, instruction: 'Synthetic instruction', target: { verb, ref: { adapter: 'hyperneo', id } }, start } });
    evidence.push({ verb, id, start, reply });
    assert.notEqual(reply.isError, true);
    return JSON.parse(reply.content[0].text);
  };
  for (const verb of ['send', 'bind']) {
    const reply = await add(verb, worker.slice(0, 8));
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const stored = verb === 'bind' ? sessions.readRef(reply.todo.id) : sessions.get(reply.todo.id)?.ref;
    assert.deepEqual(stored, { adapter: 'hyperneo', id: worker });
    evidence.push({ stored });
  }
  const pending = await add('send', worker);
  assert.equal(pending.ok, true);
  const bind = async (id: string) => {
    const reply = await handler({ name: 'neo.todo.bind', input: { todoId: pending.todo.id, ref: { adapter: 'hyperneo', id } } });
    evidence.push({ operation: 'neo.todo.bind', id, reply });
    assert.notEqual(reply.isError, true);
    return JSON.parse(reply.content[0].text);
  };
  const bound = await bind(worker.slice(0, 8));
  assert.equal(bound.ok, true, JSON.stringify(bound));
  const original = sessions.readRef(pending.todo.id);
  assert.deepEqual(original, { adapter: 'hyperneo', id: worker });
  const refused = await bind('deadbeef');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /^target_not_found:/);
  assert.deepEqual(sessions.readRef(pending.todo.id), original);
  const count = todos.listTodos('synthetic-ask').length;
  const rejected = await add('send', 'deadbeef', true);
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /^target_not_found:/);
  assert.equal(todos.listTodos('synthetic-ask').length, count);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_delivery_inputs').get().n, 0);
  const beforeBatch = todos.listAsks(null, 100);
  const batch = await handler({ name: 'neo.ask.open', input: {
    title: 'Refused target batch', request: 'Resolve every target before recording',
    todos: [worker.slice(0, 8), 'deadbeef'].map((id, n) => ({ title: `Batch item ${n}`, check: { pack: 'core', kind: 'evidence', params: { path: join(run, 'missing-proof') } }, instruction: 'Synthetic instruction', target: { verb: 'send', ref: { adapter: 'hyperneo', id } } })),
  } });
  evidence.push({ operation: 'neo.ask.open', batch });
  assert.notEqual(batch.isError, true);
  const rejectedBatch = JSON.parse(batch.content[0].text);
  assert.equal(rejectedBatch.ok, false);
  assert.match(rejectedBatch.reason, /^target_not_found:/);
  assert.deepEqual(todos.listAsks(null, 100), beforeBatch, 'Rejected batch opened an ask or recorded its first todo');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_delivery_inputs').get().n, 0);
  const taskId = 'synthetic-full-space-task';
  db.prepare("INSERT INTO spaces(id,slug,name,workspace_path,created_at,updated_at) VALUES ('synthetic-space','synthetic','Synthetic',?,1,1)").run(join(run, 'space'));
  db.prepare("INSERT INTO space_tasks(id,space_id,task_number,title,status,created_at,updated_at) VALUES (?,'synthetic-space',1,'Synthetic work','review',1,1)").run(taskId);
  for (const input of [{ id: taskId, idPrefix: 'ignored', localOnly: true }, { adapters: ['space'], idPrefix: 'synthetic-full', localOnly: true }]) {
    const reply = await handler({ name: 'work.find', input });
    evidence.push({ operation: 'work.find', input, reply });
    assert.notEqual(reply.isError, true);
    const result = JSON.parse(reply.content[0].text);
    assert.deepEqual(result.places.flatMap((place: { work: { ref: unknown }[] }) => place.work.map(work => work.ref)), [{ adapter: 'space', id: taskId }]);
    assert.deepEqual(result.unreachable, []);
  }
  const spaceTodo = await handler({ name: 'neo.todo.add', input: { askId: 'synthetic-ask', title: 'Space target', check: { pack: 'core', kind: 'evidence', params: { path: join(run, 'missing-proof') } }, instruction: 'Synthetic instruction', target: { verb: 'send', ref: { adapter: 'space', id: 'synthetic-full' } } } });
  evidence.push({ operation: 'neo.todo.add', adapter: 'space', spaceTodo });
  assert.notEqual(spaceTodo.isError, true);
  const addedSpace = JSON.parse(spaceTodo.content[0].text);
  assert.equal(addedSpace.ok, true, JSON.stringify(addedSpace));
  assert.deepEqual(sessions.get(addedSpace.todo.id)?.ref, { adapter: 'space', id: taskId });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_delivery_inputs').get().n, 0);
  evidence.push({ rows: db.prepare('SELECT target, ref FROM neo_todo_sessions').all() });
  console.log('PASS: real daemon MCP add and direct bind store full target IDs; unknown prefixes are refused without recording, rebinding or dispatching.');
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  await app.cleanup();
}
