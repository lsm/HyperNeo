import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';

const [mode, directory] = process.argv.slice(2),
  run = resolve(directory);
assert(['before', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const part of ['workspace', 'bin', 'evidence'])
  mkdirSync(join(run, part), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
const dist = resolve('packages/web/dist');
const front = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === '/ws') {
      if (
        server.upgrade(request, {
          data: {
            connectionSessionId: 'global',
            device: await app.authenticateUpgrade(request, '127.0.0.1'),
          },
        })
      )
        return;
      return new Response('Upgrade failed', { status: 500 });
    }
    const file = Bun.file(join(dist, path === '/neo' ? 'neo/index.html' : path));
    return (await file.exists()) ? new Response(file) : new Response('Not found', { status: 404 });
  },
  websocket: createWebSocketHandlers(app.transport, app.sessionManager),
});
const evidence: Record<string, unknown> = { mode, ports: [app.server.port, front.port] };
try {
  assert.notEqual(app.server.port, 8399);
  const root = 'neo:10000000-0000-4000-8000-000000008287';
  await app.db.createSession({
    id: root,
    title: 'Synthetic Mark done',
    workspacePath: join(run, 'workspace'),
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
  });
  new NeoRepository(app.db.getDatabase()).reserveBinding({
    sessionId: root,
    kind: 'neo',
    projectId: null,
  });
  app.db.updateGlobalSettings({ language: 'en' });
  const store = new NeoAskTodoRepository(app.db.getDatabase());
  for (const id of ['finish', 'stop-failure']) {
    store.openAsk({
      id,
      title: `Synthetic ${id}`,
      request: 'Synthetic human confirmation',
      sessionId: root,
      projectId: null,
      originMessageId: null,
      createdAt: Date.now(),
    });
    const todo = store.addTodo(
      id,
      id,
      {
        title: 'Unfinished stage',
        doneWhen: 'Not yet met',
        check: null,
        instruction: null,
        named: null,
      },
      Date.now()
    );
    if (id === 'stop-failure') {
      const sessions = new NeoTodoSessionRepository(app.db.getDatabase());
      const ref = { adapter: 'hyperneo', daemon: 'synthetic-offline', id: 'absent' };
      sessions.create(id, { verb: 'send', ref });
      sessions.recordRef(id, ref, Date.now());
      store.updateTodo(todo, { state: 'doing' }, Date.now());
    }
  }
  const child = Bun.spawn(
    ['node', '.claude/skills/verify/mark-done-settle-web.mjs', String(front.port), run, mode],
    { stdout: 'inherit', stderr: 'inherit' }
  );
  assert.equal(await child.exited, 0, 'headless Mark done journey');
  evidence.asks = ['finish', 'stop-failure'].map((id) => store.getAsk(id));
  if (mode === 'verify') {
    assert.equal(store.getAsk('finish')?.status, 'done');
    assert.equal(store.getAsk('stop-failure')?.status, 'open');
  } else assert.equal(store.getAsk('finish')?.status, 'open');
  evidence.verified = true;
} finally {
  front.stop(true);
  await app.cleanup();
  evidence.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
