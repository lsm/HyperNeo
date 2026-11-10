import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { SettingsRepository } from '../../../packages/daemon/src/storage/repositories/settings-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const sender = 'neo:10000000-0000-4000-8000-000000000003';
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP is disabled'); }) as typeof fetch;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
try {
  await app.jobProcessor.stop();
  const db = app.db.getDatabase(), store = new NeoAskTodoRepository(db);
  const registry = app.sessionManager.getOperationRegistry();
  const handler = createOperationMcpHandler(() => registry, () => ({ sessionId: sender, role: 'neo' }));
  const invoke = async (name: string, input: unknown) => {
    const reply = await handler({ name, input });
    const result = JSON.parse(reply.content[0].text);
    evidence.push({ name, input, result });
    return result;
  };
  db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic close proof', '/tmp', '2026-11-06T00:00:00Z', '2026-11-06T00:00:00Z', 'active', '{}', '{}')").run(sender);
  new NeoRepository(db).reserveBinding({ sessionId: sender, kind: 'neo', projectId: null });
  new SettingsRepository(db).updateGlobalSettings({ language: 'en' });
  const present = join(run, 'result.txt');
  writeFileSync(present, 'Synthetic result');
  const opened = await invoke('neo.ask.open', { title: 'Synthetic close proof', request: 'Cancel work that never started', todos: [
    { title: 'Cancelled before it started', check: { pack: 'core', kind: 'evidence', params: {} } },
    { title: 'Result already there', check: { pack: 'core', kind: 'evidence', params: { path: present } } },
  ] });
  const [cancelled, passing] = opened.todos.map((todo: { id: string }) => todo.id);
  const before = store.getTodo(cancelled)!;

  const refused = await invoke('neo.todo.close', { todoId: cancelled, reason: 'never started' });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert(refused.reason.includes('neo.todo.remove'), refused.reason);
  assert.deepEqual(store.getTodo(cancelled), before);
  assert(!JSON.stringify(await invoke('neo.ask.read', { askId: before.askId })).includes('check_unmet'));

  const removed = await invoke('neo.todo.remove', { todoId: cancelled, reason: 'never started' });
  assert.equal(removed.todo.state, 'removed', JSON.stringify(removed));
  assert.equal(removed.todo.blockedBy, null, JSON.stringify(removed));

  const done = await invoke('neo.todo.close', { todoId: passing, reason: 'Result written' });
  assert.equal(done.todo.state, 'done', JSON.stringify(done));
  console.log('PASS: real daemon MCP refuses closing a never-started todo with an unmet check, leaves it unchanged, removes it directly, and still closes one whose check passed.');
} finally {
  await app.cleanup();
  globalThis.fetch = network;
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
