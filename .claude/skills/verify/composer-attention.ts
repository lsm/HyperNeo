import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const folder of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, folder), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const root = 'neo:10000000-0000-4000-8000-000000008890';
const worker = 'synthetic-composer-worker';
let stops = 0;
async function state(mode: string) {
  await app.internalEventBus.publish('session.errorClear', { sessionId: worker });
  if (mode === 'error') await app.internalEventBus.publish('session.error', { sessionId: worker, error: 'Synthetic attention error' });
  await app.internalEventBus.publish('session.updated', { sessionId: worker, processingState: { status: mode === 'working' ? 'processing' : mode === 'waiting' ? 'waiting_for_input' : 'idle' } });
}
app.messageHub.onRequest('client.interrupt', async (input) => {
  assert.equal((input as { sessionId: string }).sessionId, worker);
  stops++;
  await state('idle');
  return { success: true };
});
const dist = resolve('packages/web/dist');
const front = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request, server) {
  const url = new URL(request.url);
  if (url.pathname === '/fixture') {
    if (url.searchParams.has('state')) await state(url.searchParams.get('state')!);
    return Response.json({ stops });
  }
  if (url.pathname === '/ws') {
    if (server.upgrade(request, { data: { connectionSessionId: 'global', device: await app.authenticateUpgrade(request, '127.0.0.1') } })) return;
    return new Response('Upgrade failed', { status: 500 });
  }
  const file = Bun.file(join(dist, url.pathname === '/neo' ? 'neo/index.html' : url.pathname));
  return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
}, websocket: createWebSocketHandlers(app.transport, app.sessionManager) });
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  for (const [id, title] of [[root, 'Synthetic Neo'], [worker, 'Synthetic worker']]) await app.db.createSession({
    id, title, workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
  });
  const db = app.db.getDatabase();
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const store = new NeoAskTodoRepository(db);
  store.openAsk({ id: 'composer-fixture', sessionId: root, projectId: null, originMessageId: null, title: 'Composer attention fixture', request: 'Synthetic UI verification', createdAt: Date.now() });
  store.focusAsk('composer-fixture', { adapter: 'hyperneo', id: worker, name: 'Synthetic worker', label: 'HyperNeo · Synthetic worker', provider: 'Synthetic', link: `/session/${worker}` }, Date.now());
  store.askQuestion('composer-source', 'composer-fixture', { kind: 'reply', text: 'Review synthetic worker context', options: null, multiple: false, noLabel: null, yesLabel: null, startTodos: null, sourceSession: { adapter: 'hyperneo', id: worker, name: 'Synthetic worker', label: 'HyperNeo · Synthetic worker', provider: 'Synthetic', link: `/session/${worker}` } }, Date.now());
  const child = Bun.spawn(['node', '.claude/skills/verify/composer-attention.mjs', String(front.port), run, process.argv[2], process.argv[3]], { stdout: 'inherit', stderr: 'inherit' });
  assert.equal(await child.exited, 0);
  assert.equal(stops, 2, 'phone and desktop Stop must each reach the synthetic RPC peer');
} finally {
  front.stop(true);
  await app.cleanup();
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ ports: [app.server.port, front.port], resourcesStopped: true, stops }));
}
