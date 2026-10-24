import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
try {
  await app.spaceRuntimeService.ready();
  const db = app.db.getDatabase();
  db.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES ('synthetic-neo','Synthetic Neo',?,'2026-10-24T00:00:00Z','2026-10-24T00:00:00Z','active','{}','{}')`).run(join(run, 'workspace'));
  new NeoRepository(db).reserveBinding({ sessionId: 'synthetic-neo', projectId: null, kind: 'neo' });
  const store = new NeoAskTodoRepository(db);
  for (const id of ['link-ask', 'race-ask']) store.openAsk({ id, sessionId: 'synthetic-neo', projectId: null, originMessageId: null, title: id, request: 'Synthetic source verification', createdAt: 1 });
  const ref = { adapter: 'claude-desktop', id: 'synthetic-source' };
  const summary = { ok: true, value: { ref, title: 'Remote review worker', place: { machine: 'local', name: 'Synthetic' }, status: 'stopped', lastActivityAt: 1, remoteLink: 'https://claude.ai/code/synthetic-bridge' } };
  let delayed = false, entered!: () => void, release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const base = app.sessionManager.getOperationRegistry();
  const registry = createOperationRegistry(base.entries.map((op) => op.name === 'work.status' ? { ...op, execute: async (input, caller) => {
    if ((input as { ref: { id: string } }).ref.id !== ref.id) return op.execute(input, caller);
    if (delayed) { entered(); await barrier; }
    return summary;
  } } : op));
  app.sessionManager.setOperationRegistryProvider(() => registry);
  const handler = createOperationMcpHandler(() => registry, () => ({ sessionId: 'synthetic-neo', role: 'neo' }));
  const ask = async (askId: string) => {
    const result = await handler({ name: 'neo.question.ask', input: { askId, kind: 'reply', text: 'Worker recommendation', sourceSession: ref } });
    assert(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const linked = await ask('link-ask');
  assert(linked.ok);
  assert.equal(linked.question.sourceSession.link, summary.value.remoteLink);
  delayed = true;
  const pending = ask('race-ask');
  await reading;
  const settled = await invokeOperation(registry, 'neo.ask.settle', { askId: 'race-ask', status: 'dropped', outcome: 'No longer needed' }, { source: 'rpc', principal: 'local' });
  assert(settled.kind === 'completed' && (settled.value as { ok: boolean }).ok);
  release();
  const refused = await pending;
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /^ask_settled:/);
  assert.deepEqual(store.listQuestions('race-ask'), []);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ linked, settled, refused, noQuestionAfterSettle: true, syntheticStatusBarrier: true }, null, 2));
  console.log('PASS: real daemon MCP retains safe HTTPS source; human settlement during delayed work.status prevents question creation');
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true }));
}
