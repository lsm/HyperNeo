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
  const sender = 'neo:20000000-0000-4000-8000-000000000002';
  const worker = '10000000-0000-4000-8000-000000000002';
  for (const id of [sender, worker]) db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,type,config,metadata) VALUES (?, 'Synthetic worker', ?, '2026-11-28T00:00:00Z', '2026-11-28T00:00:00Z', 'active', 'worker', '{}', '{}')").run(id, join(run, 'work'));
  new NeoRepository(db).reserveBinding({ sessionId: sender, kind: 'neo', projectId: null });
  const todos = new NeoAskTodoRepository(db), sessions = new NeoTodoSessionRepository(db);
  todos.openAsk({ id: 'synthetic-ask', sessionId: sender, projectId: null, originMessageId: null, title: 'Synthetic ask', request: 'Track work', createdAt: 1 });
  const handler = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: sender, role: 'neo' }));
  const call = async (name: string, input: object) => {
    const reply = await handler({ name, input });
    evidence.push({ name, input, reply });
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    return JSON.parse(reply.content[0].text);
  };
  const check = { pack: 'core', kind: 'evidence', params: { path: join(run, 'missing-proof') } };
  const gate = (await call('neo.todo.add', { askId: 'synthetic-ask', title: 'Unfinished gate', after: [], check })).todo.id as string;
  const add = (target: object) => call('neo.todo.add', { askId: 'synthetic-ask', title: 'Synthetic todo', after: [gate], check, instruction: 'Synthetic instruction', target });
  const inputs = () => (db.prepare('SELECT COUNT(*) AS n FROM work_delivery_inputs').get() as { n: number }).n;
  const ref = { adapter: 'hyperneo', id: worker };
  const triple = { provider: 'anthropic', model: 'synthetic-model', effort: 'high' };

  const before = todos.listTodos('synthetic-ask').length;
  const start = await add({ verb: 'start', adapter: 'hyperneo', model: 'synthetic-model', effort: 'high' });
  assert.equal(start.ok, false);
  assert.match(start.reason, /^identity_required: .*\(missing: provider\)$/);
  const send = await add({ verb: 'send', ref });
  assert.equal(send.ok, false);
  assert.match(send.reason, /^identity_required: .*\(missing: provider, model, effort\)$/);
  assert.equal(todos.listTodos('synthetic-ask').length, before, 'A refused target added a todo');
  const remote = await add({ verb: 'start', adapter: 'hyperneo', place: { machine: 'other', daemon: 'other', name: 'synthetic' } });
  assert.doesNotMatch(String(remote.reason ?? ''), /^identity_required/, 'Remote targets keep today’s admission');
  const named = await add({ verb: 'send', ref, ...triple });
  assert.equal(named.ok, true, JSON.stringify(named));
  const stored = sessions.get(named.todo.id) as Record<string, unknown> | null;
  assert.deepEqual([stored?.verb, stored?.model, stored?.effort, stored?.provider], ['send', triple.model, triple.effort, triple.provider]);

  for (const name of ['work.send', 'work.queue']) {
    const bare = await call(name, { todoId: gate, ref, message: 'Synthetic new work' });
    assert.deepEqual([bare.ok, bare.reason, bare.notSent], [false, 'identity_required', true]);
    assert.match(bare.detail, /missing: provider, model, effort/);
  }
  const legacy = await call('work.send', { todoId: gate, ref, message: 'Synthetic new work', ...triple });
  assert.equal(legacy.ok, false, 'A worker with no recorded identity must not receive new todo work');
  assert.equal(legacy.notSent, true);
  assert.equal(inputs(), 0, 'A refused send recorded a delivery input');
  evidence.push({ legacyReason: legacy.reason, rows: db.prepare('SELECT todo_id, target FROM neo_todo_sessions').all() });
  console.log('PASS: real daemon refuses local todo targets and new-todo sends without provider, model and effort, before recording or delivering anything.');
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  await app.cleanup();
}
