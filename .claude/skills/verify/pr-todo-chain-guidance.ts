import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP disabled'); }) as typeof fetch;
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, verbose: false });
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  const sender = 'neo:40000000-0000-4000-8000-000000000001';
  db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic coordinator', ?, '2026-11-08T00:00:00Z', '2026-11-08T00:00:00Z', 'active', '{}', '{}')").run(sender, run);
  new NeoRepository(db).reserveBinding({ sessionId: sender, kind: 'neo', projectId: null });
  const registry = app.sessionManager.getOperationRegistry();
  for (const name of ['neo.todo.add', 'neo.todo.edit']) {
    const description = registry.entries.find(op => op.name === name)!.description;
    for (const term of ['one PR per todo', 'merge check', 'after', 'addUrls']) assert(description.includes(term), `${name}: ${term}`);
    evidence.push({ name, description });
  }
  const handler = createOperationMcpHandler(() => registry, () => ({ sessionId: sender, role: 'neo' }));
  const invoke = async (name: string, input: unknown) => {
    const reply = await handler({ name, input });
    assert(!reply.isError, reply.content[0].text);
    const result = JSON.parse(reply.content[0].text);
    assert.equal(result.ok, true, JSON.stringify(result));
    evidence.push({ name, input, result });
    return result;
  };
  const pack = await invoke('neo.pack.read', { id: 'coding' });
  for (const term of ['one PR per todo', 'queue starts', 'Example:', 'addUrls']) assert(pack.instructions.includes(term));
  const store = new NeoAskTodoRepository(db);
  store.openAsk({ id: 'ask', sessionId: sender, projectId: null, originMessageId: null, title: 'Parser and callers', request: 'Track two PRs separately', createdAt: 1 });
  const check = { pack: 'coding', kind: 'pr_merged', params: {} };
  const first = await invoke('neo.todo.add', { after: [], askId: 'ask', title: 'Extract parser', check });
  const second = await invoke('neo.todo.add', { askId: 'ask', title: 'Update callers', after: [first.todo.id], check });
  assert.deepEqual(store.getTodo(first.todo.id)!.check?.params, {});
  assert.deepEqual(store.getTodo(second.todo.id)!.check?.params, {});
  await invoke('neo.todo.edit', { todoId: first.todo.id, addUrls: ['https://github.com/example/project/pull/123'] });
  await invoke('neo.todo.edit', { todoId: second.todo.id, addUrls: ['https://github.com/example/project/pull/124'] });
  assert.deepEqual(store.getTodo(second.todo.id)!.dependsOn, [first.todo.id]);
  assert.deepEqual(store.getTodo(first.todo.id)!.check?.params.urls, ['https://github.com/example/project/pull/123']);
  assert.deepEqual(store.getTodo(second.todo.id)!.check?.params.urls, ['https://github.com/example/project/pull/124']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_delivery_inputs').get().n, 0);
  console.log('PASS: live tool descriptions and coding pack guidance expose the chain; two separate PR checks retain after dependency; deliveryInputs=0');
} finally {
  await app.cleanup();
  globalThis.fetch = network;
  writeFileSync(join(run, 'evidence/pr-todo-chain-guidance.json'), JSON.stringify(evidence, null, 2));
}
