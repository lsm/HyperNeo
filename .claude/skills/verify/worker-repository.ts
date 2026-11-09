import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
let sends = 0;
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP disabled'); }) as typeof fetch;
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, verbose: false });
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  const sender = 'neo:30000000-0000-4000-8000-000000000001';
  const refs = ['same', 'other', 'unknown'].map((name, i) => {
    const folder = join(run, name);
    mkdirSync(folder);
    execFileSync('git', ['init', '-q', folder]);
    const tree = execFileSync('git', ['-C', folder, 'mktree'], { input: '', encoding: 'utf8' }).trim();
    const commit = execFileSync('git', ['-C', folder, 'hash-object', '-t', 'commit', '-w', '--stdin'], {
      input: `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nSynthetic repository fixture\n`, encoding: 'utf8',
    }).trim();
    execFileSync('git', ['-C', folder, 'update-ref', 'HEAD', commit]);
    if (name !== 'unknown') execFileSync('git', ['-C', folder, 'remote', 'add', 'origin', name === 'same' ? 'git@github.com:EXAMPLE/REPO.git' : 'https://github.com/example/other.git']);
    const id = `30000000-0000-4000-8000-00000000000${i + 2}`;
    db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,type,config,metadata) VALUES (?, 'Synthetic worker', ?, '2026-11-08T00:00:00Z', '2026-11-08T00:00:00Z', 'active', 'worker', '{}', '{}')").run(id, folder);
    return { adapter: 'hyperneo' as const, id };
  });
  db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic Neo', ?, '2026-11-08T00:00:00Z', '2026-11-08T00:00:00Z', 'active', '{}', '{}')").run(sender, run);
  new NeoRepository(db).reserveBinding({ sessionId: sender, kind: 'neo', projectId: null });
  const todos = new NeoAskTodoRepository(db), sessions = new NeoTodoSessionRepository(db);
  todos.openAsk({ id: 'ask', sessionId: sender, projectId: null, originMessageId: null, title: 'Repository admission', request: 'Use the correct repository', createdAt: 1 });
  const production = app.sessionManager.getOperationRegistry();
  const registry = createOperationRegistry(production.entries.map(op => ['work.send', 'work.start'].includes(op.name) ? { ...op, execute: async () => { sends++; throw new Error('Unexpected dispatch'); } } : op));
  app.sessionManager.setOperationRegistryProvider(() => registry);
  const handler = createOperationMcpHandler(() => registry, () => ({ sessionId: sender, role: 'neo' }));
  const call = async (name: string, input: unknown) => {
    const reply = await handler({ name, input });
    assert(!reply.isError, reply.content[0].text);
    const result = JSON.parse(reply.content[0].text);
    evidence.push({ name, input, result });
    return result;
  };
  const check = { pack: 'coding', kind: 'pr_merged', params: { urls: ['https://github.com/example/repo/pull/1'] } };
  const add = (extra: object = {}) => call('neo.todo.add', { askId: 'ask', title: 'Synthetic todo', after: [], check, ...extra });
  const refusal = (result: { ok: boolean; reason?: string }) => {
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.reason!, /^worker_repository_mismatch:/);
    assert.equal(sends, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_delivery_inputs').get().n, 0);
  };
  await call('work.status', { ref: refs[0] });
  assert.equal((await add({ instruction: 'Implement change', target: { verb: 'send', ref: refs[0] } })).ok, true);
  for (const ref of refs.slice(1)) {
    const before = todos.listTodos('ask').length;
    refusal(await add({ instruction: 'Implement change', target: { verb: 'send', ref }, start: true }));
    assert.equal(todos.listTodos('ask').length, before);
    const pending = await add();
    assert.equal(pending.ok, true);
    refusal(await call('neo.todo.edit', { todoId: pending.todo.id, instruction: 'Implement change', target: { verb: 'send', ref } }));
    assert.equal(sessions.get(pending.todo.id), null);
    refusal(await call('neo.todo.bind', { todoId: pending.todo.id, ref }));
    assert.equal(sessions.readRef(pending.todo.id), null);
    sessions.bind(pending.todo.id, ref, 1);
    todos.updateTodo(todos.getTodo(pending.todo.id)!, { state: 'doing', startedAt: 1, approvedAt: 1 }, 1);
    refusal(await call('neo.todo.continue', { todoId: pending.todo.id, message: 'Continue change' }));
  }
  const pending = await add();
  assert.equal((await call('neo.todo.bind', { todoId: pending.todo.id, ref: refs[0] })).ok, true);
  assert.equal((await add({ check: { pack: 'core', kind: 'evidence', params: {} }, instruction: 'Non-coding task', target: { verb: 'send', ref: refs[1] } })).ok, true);
  assert.equal(sends, 0);
  evidence.push({ sends, deliveryInputs: db.prepare('SELECT COUNT(*) AS n FROM work_delivery_inputs').get().n });
  console.log(`PASS: same repository accepted; other/unknown refused on add/edit/bind/continue; non-coding accepted; sends=${sends}; deliveryInputs=0`);
} finally {
  await app.cleanup();
  globalThis.fetch = network;
  writeFileSync(join(run, 'evidence/worker-repository.json'), JSON.stringify(evidence, null, 2));
}
