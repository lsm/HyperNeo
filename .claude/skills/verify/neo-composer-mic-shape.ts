import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const [phase, readyPath, directory] = process.argv.slice(2), run = resolve(directory);
assert(['before', 'after'].includes(phase));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const part of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, part), { recursive: true });
for (const command of ['gh', 'open']) writeFileSync(join(run, 'bin', command), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const fetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP refused by synthetic fixture'); }) as typeof fetch;
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, verbose: false });
let front: ReturnType<typeof Bun.serve> | undefined;
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await app.settingsManager.updateGlobalSettings({ language: 'en', voice: { enabled: true, endpoint: `http://127.0.0.1:${app.server.port}/synthetic-asr-unused`, model: 'synthetic', mode: 'batch', allowPrivateNetwork: true } });
  const root = 'neo:10000000-0000-4000-8000-000000009290', worker = 'mic-shape-worker';
  for (const [id, title] of [[root, 'Synthetic mic Neo'], [worker, 'Synthetic mic chat']]) await app.db.createSession({
    id, title, workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
  });
  const db = app.db.getDatabase();
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const store = new NeoAskTodoRepository(db);
  store.openAsk({ id: 'mic-shape', sessionId: root, projectId: null, originMessageId: null, title: 'Mic shape fixture', request: 'Synthetic UI verification', createdAt: Date.now() });
  store.askQuestion('mic-shape-source', 'mic-shape', { kind: 'reply', text: 'Open the synthetic chat to inspect its composer.', options: null, multiple: false, noLabel: null, yesLabel: null, startTodos: null, sourceSession: { adapter: 'hyperneo', id: worker, name: 'Synthetic mic chat', label: 'HyperNeo · Synthetic mic chat', provider: 'Synthetic', link: `/session/${worker}` } }, Date.now());
  const dist = resolve('packages/web/dist');
  assert(existsSync(join(dist, 'neo/index.html')));
  front = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === '/ws') {
      if (server.upgrade(request, { data: { connectionSessionId: 'global', device: await app.authenticateUpgrade(request, '127.0.0.1') } })) return;
      return new Response('Upgrade failed', { status: 500 });
    }
    const file = Bun.file(join(dist, path === '/neo' ? 'neo/index.html' : path));
    return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
  }, websocket: createWebSocketHandlers(app.transport, app.sessionManager) });
  assert.notEqual(front.port, 8399);
  writeFileSync(readyPath, JSON.stringify({ phase, run, pid: process.pid, url: `http://127.0.0.1:${front.port}/neo` }, null, 2));
  console.log(`Ready for attended browser: http://127.0.0.1:${front.port}/neo`);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  for (const signal of ['SIGUSR1', 'SIGINT', 'SIGTERM'] as const) process.once(signal, release);
  const timer = setTimeout(release, 600000);
  await gate;
  clearTimeout(timer);
  const browser = JSON.parse(readFileSync(join(run, 'evidence/browser.json'), 'utf8'));
  assert.equal(browser.phase, phase);
  assert(phase === 'before' ? browser.baselineReproduced : browser.passed);
} finally {
  front?.stop(true);
  await app.cleanup();
  globalThis.fetch = fetch;
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ resourcesStopped: true, syntheticOnly: true }));
}
