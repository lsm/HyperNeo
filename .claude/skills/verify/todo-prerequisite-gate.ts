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
for (const name of Object.keys(process.env))
  assert(!/API_KEY|AUTH_TOKEN|OAUTH_TOKEN|GH_TOKEN|GITHUB_TOKEN/.test(name), `credential ${name}`);
mkdirSync(join(run, 'evidence'), { recursive: true });
const rows: unknown[] = [];
const sender = 'neo:10000000-0000-4000-8000-000000000003';
const ref = { adapter: 'hyperneo', id: 'synthetic-prerequisite-worker' };
const check = { pack: 'core', kind: 'evidence', params: { path: '/synthetic/pending' } };
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP is disabled'); }) as typeof fetch;
let sends = 0;
try {
  const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  try {
    await app.jobProcessor.stop();
    assert.notEqual(app.server.port, 8399);
    const db = app.db.getDatabase(), store = new NeoAskTodoRepository(db), sessions = new NeoTodoSessionRepository(db);
    const stub = {
      'work.send': async () => { sends++; return { ok: true, value: { delivered: true, receipt: { executionId: ref.id, inputId: crypto.randomUUID() } } }; },
      'work.status': async () => ({ ok: true, value: { ref, status: 'running', lastActivityAt: Date.now() } }),
    } as Record<string, () => Promise<unknown>>;
    const production = app.sessionManager.getOperationRegistry();
    const registry = createOperationRegistry(production.entries.map(op => stub[op.name] ? { ...op, execute: stub[op.name] } : op));
    app.sessionManager.setOperationRegistryProvider(() => registry);
    const handler = createOperationMcpHandler(() => registry, () => ({ sessionId: sender, role: 'neo' }));
    const invoke = async (name: string, input: unknown) => JSON.parse((await handler({ name, input })).content[0].text);
    const row = async (label: string, expected: 'refused' | 'ok', name: string, input: { todoId: string }) => {
      const before = sends;
      const result = await invoke(name, input);
      const todo = store.getTodo(input.todoId)!;
      rows.push({ label, name, ok: result.ok, reason: result.reason ?? null, sent: sends - before, state: todo.state, startedAt: todo.startedAt });
      assert.equal(result.ok, expected === 'ok', `${label}: ${JSON.stringify(result)}`);
      if (expected === 'refused') { assert.match(result.reason, /^not_ready:/); assert.equal(sends, before, label); }
      return todo;
    };
    for (const id of [sender, ref.id]) db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic worker', '/tmp', '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z', 'active', '{}', '{}')").run(id);
    new NeoRepository(db).reserveBinding({ sessionId: sender, kind: 'neo', projectId: null });
    const opened = await invoke('neo.ask.open', { title: 'Synthetic prerequisites', request: 'Finish A before J and X before Y', todos: [{ title: 'A', check, after: [] }, { title: 'J', check, after: [0] }, { title: 'X', check, after: [] }, { title: 'Y', check, after: [2] }] });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const [a, j, x, y] = opened.todos.map((todo: { id: string }) => todo.id);
    const set = (id: string, patch: Parameters<typeof store.updateTodo>[1]) => store.updateTodo(store.getTodo(id)!, patch, Date.now());
    assert.equal((await invoke('neo.todo.bind', { todoId: a, ref })).ok, true);
    assert.equal((await invoke('neo.todo.bind', { todoId: x, ref })).ok, true);
    await row('bind while prerequisite X runs', 'refused', 'neo.todo.bind', { todoId: y, ref } as { todoId: string });
    assert.equal(store.getTodo(y)?.state, 'todo'); assert.equal(store.getTodo(y)?.startedAt, null);
    set(a, { state: 'done' });
    sessions.create(j, { verb: 'send', ref }); sessions.recordRef(j, ref, 1);
    set(j, { state: 'doing', startedAt: 1, approvedAt: 1, instruction: 'Synthetic step' });
    set(a, { state: 'doing', finishedAt: null });
    await row('continue while prerequisite A is reopened', 'refused', 'neo.todo.continue', { todoId: j, message: 'Synthetic next step' } as { todoId: string });
    set(j, { state: 'failed', reason: 'Synthetic failure' });
    await row('retry with a worker while prerequisite A is reopened', 'refused', 'neo.todo.retry', { todoId: j });
    assert.equal(store.getTodo(j)?.state, 'failed');
    set(a, { state: 'done' }); set(x, { state: 'done' });
    assert.equal((await row('retry after A finished', 'ok', 'neo.todo.retry', { todoId: j })).state, 'doing');
    await row('continue after A finished', 'ok', 'neo.todo.continue', { todoId: j, message: 'Synthetic next step' } as { todoId: string });
    assert.equal(sends, 2);
    assert.equal((await row('bind after X finished', 'ok', 'neo.todo.bind', { todoId: y, ref } as { todoId: string })).state, 'doing');
  } finally { await app.cleanup(); }
  console.log(`PASS: continue, retry and bind refuse with an unfinished prerequisite, send nothing, and run once it is finished. Evidence: ${run}/evidence/todo-prerequisite-gate.json`);
} finally { globalThis.fetch = network; writeFileSync(join(run, 'evidence/todo-prerequisite-gate.json'), JSON.stringify({ sends, rows }, null, 2)); }
