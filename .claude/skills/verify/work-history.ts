import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import type { NeoSnapshot, NeoAskHistoryPage } from '../../../packages/shared/src/types/neo-snapshot.ts';

const mode = process.argv[2];
const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
for (const part of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, part), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
assert(![8399, 8499].includes(app.server.port));
const socket = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
const opened = new Promise<void>((done, fail) => {
  const timer = setTimeout(() => fail(new Error('Proof WebSocket did not open')), 15000);
  socket.onopen = () => { clearTimeout(timer); done(); };
  socket.onerror = error => { clearTimeout(timer); fail(error); };
});
let sequence = 0;
const pending = new Map<string, (value: { data: unknown; error?: unknown }) => void>();
socket.onmessage = event => {
  const reply = JSON.parse(String(event.data));
  pending.get(reply.requestId)?.(reply);
};
async function invoke<T>(name: string, input: unknown = {}): Promise<T> {
  const id = String(++sequence);
  const reply = new Promise<{ data: unknown; error?: unknown }>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`Timed out: ${name}`)), 15000);
    pending.set(id, value => { clearTimeout(timer); pending.delete(id); done(value); });
  });
  socket.send(JSON.stringify({ type: 'REQ', id, sessionId: 'global', version: '1.0.0', timestamp: new Date().toISOString(), method: 'operation.invoke', data: { name, input } }));
  const response = await reply;
  assert(!response.error, JSON.stringify(response.error));
  return response.data as T;
}
let front: ReturnType<typeof Bun.serve> | undefined;
const observed: Record<string, unknown> = { mode };
try {
  const root = 'neo:10000000-0000-4000-8000-000000008889';
  await app.db.createSession({ id: root, title: 'Synthetic Work history', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const repo = new NeoRepository(app.db.getDatabase());
  repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  app.db.updateGlobalSettings({ language: 'en' });
  const db = app.db.getDatabase();
  const ask = db.prepare(`INSERT INTO neo_asks (id,project_id,session_id,title,request,status,created_at,updated_at) VALUES (?,?,? ,?,'Synthetic request',?,?,?)`);
  const todo = db.prepare(`INSERT INTO neo_todos (id,ask_id,position,title,done_when,state,instruction,report,created_at,updated_at) VALUES (?,?,0,'Synthetic task','Observed bytes',?,?,?,0,0)`);
  for (const [project, count] of [['small', 3], ['busy', 63]] as const) {
    repo.saveProject({ id: project, title: project, summary: '', context: '' }, 0);
    for (let i = 0; i < count; i++) ask.run(`${project}-open-${i}`, project, root, `Open ${project} ${i}`, 'open', i, i);
    for (let i = 0; i < 32; i++) {
      const id = `${project}-done-${String(i).padStart(2, '0')}`;
      ask.run(id, project, root, `Finished ${project} ${i}`, i % 2 ? 'done' : 'dropped', 1000, 1000);
      todo.run(`${id}-todo`, id, 'done', 'Full synthetic instruction', 'Full synthetic report');
    }
    for (const suffix of ['unverified', 'waiting']) ask.run(`${project}-${suffix}`, project, root, `${project} ${suffix}`, 'done', -1, -1);
    todo.run(`${project}-unverified-todo`, `${project}-unverified`, 'closed_unverified', 'Inspect this unfinished task', 'Not verified');
    db.prepare(`INSERT INTO neo_questions (id,ask_id,text,kind,state,created_at) VALUES (?,?,'Answer this older question','reply','open',-1)`).run(`${project}-q`, `${project}-waiting`);
  }
  await opened;
  for (const [project, count] of [['small', 3], ['busy', 63]] as const) {
    const view = await invoke<NeoSnapshot>('neo.snapshot', { projectId: project });
    const rows = view.todoAsks!;
    observed[project] = { asks: rows.length, open: rows.filter(entry => entry.ask.status === 'open').length, snapshotBytes: Buffer.byteLength(JSON.stringify(view)), cardBytes: Buffer.byteLength(JSON.stringify(rows)) };
    if (mode === 'baseline') { assert.equal(rows.length, Math.min(count + 34, 50)); continue; }
    assert.equal(rows.length, count + 12);
    assert(rows.some(entry => entry.ask.id === `${project}-unverified`));
    assert.equal(rows.find(entry => entry.ask.id === `${project}-waiting`)?.summary?.openQuestionCount, 1);
    const seen = new Set(rows.map(entry => entry.ask.id));
    let cursor = view.historyCursor;
    const pages = [];
    while (cursor) {
      const page = await invoke<NeoAskHistoryPage>('neo.ask.history', { projectId: project, before: cursor });
      assert(page.ok);
      pages.push(page.entries.length);
      for (const entry of page.entries) {
        assert.equal(entry.ask.projectId, project);
        assert(!seen.has(entry.ask.id));
        assert(entry.summary);
        assert(entry.todos.every(item => item.instruction === null && item.report === null));
        seen.add(entry.ask.id);
      }
      cursor = page.nextCursor;
    }
    assert.deepEqual(pages, [20, 2]);
    assert.equal(seen.size, count + 34);
    const full = await invoke<{ ok: boolean; entry: { todos: { instruction: string }[] } }>('neo.ask.read', { askId: `${project}-done-00` });
    assert(full.ok);
    assert.equal(full.entry.todos[0].instruction, 'Full synthetic instruction');
    observed[`${project}Pages`] = pages;
  }
  if (process.argv.includes('--web') || process.argv.includes('--manual')) {
    const dist = resolve('packages/web/dist');
    front = Bun.serve({ hostname: '127.0.0.1', port: 0,
      async fetch(request, server) {
        const path = new URL(request.url).pathname;
        if (path === '/ws') {
          if (server.upgrade(request, { data: { connectionSessionId: 'global', device: await app.authenticateUpgrade(request, '127.0.0.1') } })) return;
          return new Response('Upgrade failed', { status: 500 });
        }
        const file = Bun.file(join(dist, path === '/neo' ? 'neo/index.html' : path));
        return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
      }, websocket: createWebSocketHandlers(app.transport, app.sessionManager),
    });
    assert(![8399, 8499].includes(front.port));
    if (process.argv.includes('--manual')) {
      writeFileSync(process.argv[process.argv.indexOf('--manual') + 1], JSON.stringify({ port: front.port, run }));
      const deadline = Date.now() + 300000;
      while (!existsSync(join(run, 'release')) && Date.now() < deadline) await Bun.sleep(250);
      assert(existsSync(join(run, 'release')), 'manual proof must be released');
      assert.equal(JSON.parse(readFileSync(join(run, 'evidence/browser.json'), 'utf8')).passed, true);
    } else {
      const child = Bun.spawn(['node', '.claude/skills/verify/work-history-web.mjs', String(front.port), run], { stdout: 'inherit', stderr: 'inherit' });
      assert.equal(await child.exited, 0);
    }
    observed.browser = true;
  }
  observed.passed = true;
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  socket.close(); front?.stop(true); await app.cleanup();
}
