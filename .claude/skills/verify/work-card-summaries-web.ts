import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const run = resolve(process.argv.at(-1)!);
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
    if (!(await file.exists())) return new Response('Not found', { status: 404 });
    return path === '/neo'
      ? new Response(file, {
          headers: {
            'Set-Cookie': `hyperneo_device=${readLocalCredential()}; Path=/; HttpOnly; SameSite=Strict`,
          },
        })
      : new Response(file);
  },
  websocket: createWebSocketHandlers(app.transport, app.sessionManager),
});
const evidence: Record<string, unknown> = { ports: [app.server.port, front.port] };
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
  store.openAsk({
    id: 'a-api', title: 'Draft the iOS API client', request: 'Synthetic ask menu parity',
    sessionId: root, projectId: null, originMessageId: null, createdAt: Date.now(),
  });
  store.addTodo('synthetic-task', 'a-api', {
    title: 'Preserve quote replies', doneWhen: 'Same ask reference',
    check: null, instruction: "Full synthetic task instructions", named: null,
  }, Date.now());
  const task = store.getTodo("synthetic-task")!;
  store.updateTodo(task, { report: "Full synthetic worker report", state: "doing" }, Date.now());
  for (let index = 0; index < 21; index++) {
    const done = store.addTodo(`synthetic-done-${index}`, 'a-api', {
      title: `Completed task ${index}`, doneWhen: 'Done',
      check: null, instruction: null, named: null,
    }, Date.now());
    store.updateTodo(done, { state: 'done' }, Date.now());
  }
  store.askQuestion("synthetic-choice", "a-api", { text: "Which synthetic option?", kind: "choice", options: ["Ship", "Wait"], multiple: false, noLabel: null, yesLabel: null, confirm: null }, Date.now());
  store.openAsk({
    id: 'a-history', title: 'Finished synthetic history', request: 'Synthetic summary outside the queue',
    sessionId: root, projectId: null, originMessageId: null, createdAt: Date.now() - 1000,
  });
  for (let index = 0; index < 21; index++) {
    const done = store.addTodo(`history-done-${index}`, 'a-history', {
      title: `Finished history task ${index}`, doneWhen: 'Done',
      check: null, instruction: null, named: null,
    }, Date.now() - 1000);
    store.updateTodo(done, { state: 'done' }, Date.now() - 1000);
  }
  const kept = store.addTodo('history-task', 'a-history', {
    title: 'Keep history replies', doneWhen: 'Same ask reference',
    check: null, instruction: 'Full synthetic history instructions', named: null,
  }, Date.now());
  store.updateTodo(kept, { report: 'Full synthetic history report', state: 'done' }, Date.now());
  if (process.argv.includes('--manual')) {
    writeFileSync(process.argv[3], JSON.stringify({ port: front.port, run }));
    const deadline = Date.now() + 300000;
    while (!existsSync(join(run, 'release')) && Date.now() < deadline) await Bun.sleep(500);
    assert(existsSync(join(run, 'release')), 'manual web proof release');
    assert(existsSync(join(run, 'evidence/browser.json')), 'manual browser evidence required');
  } else {
  const child = Bun.spawn(
    ['node', '.claude/skills/verify/work-card-summaries-web.mjs', String(front.port), run],
    { stdout: 'inherit', stderr: 'inherit' }
  );
  assert.equal(await child.exited, 0, 'headless ask Reply journey');
  }
  assert.equal(store.getAsk('a-api')?.status, 'open');
  evidence.verified = true;
} finally {
  front.stop(true);
  await app.cleanup();
  evidence.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
