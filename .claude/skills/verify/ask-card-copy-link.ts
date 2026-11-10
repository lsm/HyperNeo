import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const part of ['workspace', 'bin', 'evidence'])
  mkdirSync(join(run, part), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const app = await createDaemonApp({
  config: {
    ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
    disableWorktrees: true,
  },
  verbose: false,
});
const dist = resolve('packages/web/dist');
const front = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/ask/')) {
      return fetch(new Request(`http://127.0.0.1:${app.server.port}${path}`, request));
    }
    if (path === '/ws') {
      if (server.upgrade(request, { data: {
        connectionSessionId: 'global',
        device: await app.authenticateUpgrade(request, '127.0.0.1'),
      } })) return;
      return new Response('Upgrade required', { status: 426 });
    }
    const file = Bun.file(join(dist, path === '/neo' ? 'neo/index.html' : path));
    return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
  },
  websocket: createWebSocketHandlers(app.transport, app.sessionManager),
});
try {
  await app.jobProcessor.stop();
  assert.notEqual(front.port, 8399);
  assert.notEqual(app.server.port, 8399);
  const sessionId = 'neo:10000000-0000-4000-8000-000000000001';
  await app.db.createSession({
    id: sessionId,
    title: 'Synthetic copy-link conversation',
    workspacePath: join(run, 'workspace'),
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: {},
  });
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId, kind: 'neo', projectId: null });
  app.db.updateGlobalSettings({ language: 'system' });
  const store = new NeoAskTodoRepository(app.db.getDatabase());
  const askId = '10000000-0000-4000-8000-000000000002';
  store.openAsk({
    id: askId,
    sessionId,
    projectId: null,
    originMessageId: null,
    title: 'Review [iOS] \\ API\nnext step',
    request: 'Synthetic clipboard verification',
    createdAt: Date.now(),
  });
  writeFileSync(join(run, 'fixture.json'), JSON.stringify({
    askId,
    label: 'Review \\[iOS\\] \\\\ API next step',
  }));
  const child = Bun.spawn(['node', '.claude/skills/verify/ask-card-copy-link.mjs', String(front.port), run], {
    stdout: 'inherit', stderr: 'inherit',
  });
  assert.equal(await child.exited, 0, 'real browser clipboard verification');
} finally {
  front.stop(true);
  await app.cleanup();
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ resourcesStopped: true }));
}
