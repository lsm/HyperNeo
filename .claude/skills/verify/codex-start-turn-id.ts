process.env.HYPERNEO_SPACE ??= 'on';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { CodingTurnPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/turn-prs.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { recordWorkTurns } from '../../../packages/daemon/src/storage/repositories/work-turn-repository.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { syntheticCodexDesktop } from './codex-desktop-peer.ts';

const [portText, runText] = process.argv.slice(2);
assert(runText);
const run = resolve(runText);
const port = Number(portText);
assert(Number.isInteger(port) && port > 0 && port < 65536 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
for (const dir of ['home/.codex/app-server-control', 'evidence', 'bin'])
  mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const codexLog = join(run, 'evidence/bootstrap-codex.jsonl');
writeFileSync(
  join(run, 'bin/codex'),
  `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const model = { id: 'synthetic', model: 'gpt-6.1-sol', displayName: 'Synthetic', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] };
let n = 0;
for await (const line of console) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  appendFileSync(${JSON.stringify(codexLog)}, JSON.stringify(message) + '\\n');
  if (!('id' in message)) continue;
  const result = message.method === 'model/list'
    ? { data: [model], nextCursor: null }
    : message.method === 'thread/start'
      ? { thread: { id: 'synthetic-new-' + ++n }, model: 'gpt-6.1-sol', reasoningEffort: 'medium' }
      : message.method === 'project/create'
        ? { project: { id: 'synthetic-project' } }
        : {};
  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
}
`,
  { mode: 0o700 }
);
process.env.CODEX_CLI_PATH = join(run, 'bin/codex');
const state = new Database(join(run, 'home/.codex/state_5.sqlite'));
state.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, updated_at_ms INTEGER); CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT)`);
state.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT, git_branch TEXT)`);
state.close();

const evidence: unknown[] = [];
let sharedTurn: string | null = null;
let sharedThreads = 0;
const shared = Bun.serve({
  unix: join(run, 'home/.codex/app-server-control/app-server-control.sock'),
  fetch(request, server) {
    return server.upgrade(request) ? undefined : new Response('websocket only', { status: 400 });
  },
  websocket: {
    message(socket, data) {
      const message = JSON.parse(String(data));
      if (!('id' in message)) return;
      evidence.push({ shared: message.method });
      const result =
        message.method === 'turn/start'
          ? sharedTurn
            ? { turn: { id: sharedTurn } }
            : {}
          : message.method === 'model/list'
            ? { data: [{ id: 'synthetic', model: 'gpt-6.1-sol', displayName: 'Synthetic', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }], nextCursor: null }
            : message.method === 'thread/start'
              ? { thread: { id: `synthetic-shared-thread-${++sharedThreads}` }, model: 'gpt-6.1-sol', reasoningEffort: 'medium' }
              : message.method === 'project/create'
                ? { project: { id: 'synthetic-project' } }
                : {};
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    },
  },
});
let closeDesktop: (() => Promise<void>) | null = await syntheticCodexDesktop(run, {
  start: () => 'synthetic-opening',
});
writeFileSync(
  join(run, 'bin/open'),
  `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(run, 'evidence/open.log'))}\n`,
  { mode: 0o700 }
);
const sessionId = 'neo:10000000-0000-4000-8000-000000000002';
const app = await createDaemonApp({
  config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
try {
  await app.spaceRuntimeService.ready();
  const db = app.db.getDatabase();
  db.exec(
    `INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES ('${sessionId}','Synthetic Neo','/tmp','2026-11-26T00:00:00Z','2026-11-26T00:00:00Z','active','{}','{}')`
  );
  new NeoRepository(db).reserveBinding({ sessionId, kind: 'neo', projectId: null });
  new NeoAskTodoRepository(db).openAsk({
    id: 'synthetic-ask', projectId: null, sessionId, originMessageId: null,
    title: 'Synthetic starts', request: 'Start Codex workers', createdAt: 1,
  });
  const handler = createOperationMcpHandler(
    () => app.sessionManager.getOperationRegistry(),
    () => ({ sessionId, role: 'neo' })
  );
  const add = async (title: string) => {
    const reply = await handler({
      name: 'neo.todo.add',
      input: {
        after: [], askId: 'synthetic-ask', title, doneWhen: 'Facts retained',
        check: { pack: 'core', kind: 'evidence', params: { path: join(run, 'missing-proof') } },
        instruction: 'Only a synthetic opening instruction',
        target: {
          verb: 'start', adapter: 'codex-desktop',
        },
      },
    });
    const result = JSON.parse((reply.content[0] as { text: string }).text);
    evidence.push({ title, result });
    return result;
  };
  const outcome = (todoId: string) => {
    const row = db
      .prepare('SELECT outcome FROM work_delivery_inputs WHERE todo_id = ?')
      .get(todoId) as { outcome: string } | null;
    return row ? JSON.parse(row.outcome) : null;
  };
  const owns = (todoId: string, ref: { adapter: string; id: string }, turn: string) => {
    recordWorkTurns.run(db, {
      ref,
      turns: [
        { id: turn, startedAt: 10, endedAt: 20, ended: 'success', inputs: [], urls: [], finalUrls: [], complete: true, cursor: '{"at":10}' },
        { id: `${turn}-other`, startedAt: 30, endedAt: 40, ended: 'success', inputs: [], urls: [], finalUrls: [], complete: true, cursor: '{"at":30}' },
      ],
    }, undefined as never);
    return new CodingTurnPrRepository(db).own(todoId).map(({ id }) => id);
  };

  const desktop = await add('Desktop IPC start');
  assert.equal(desktop.ok, true, JSON.stringify(desktop));
  assert.equal(desktop.todo.state, 'doing', JSON.stringify(desktop.todo));
  const desktopOutcome = outcome(desktop.todo.id);
  evidence.push({ desktopOutcome });
  assert.equal(desktopOutcome.receipt, undefined, 'no rollout, so no receipt');
  assert.deepEqual(desktopOutcome.delivery, { delivered: true, startedTurnId: 'synthetic-opening' });
  const desktopOwn = owns(desktop.todo.id, desktopOutcome.ref, 'synthetic-opening');
  evidence.push({ desktopOwn });
  assert.deepEqual(desktopOwn, ['synthetic-opening']);
  console.log('PASS: Desktop IPC start without a receipt keeps its opening turn id and gives its todo');

  await closeDesktop();
  closeDesktop = null;
  rmSync(join(run, 'home/.codex/ipc'), { recursive: true, force: true });
  sharedTurn = 'synthetic-shared';
  const appServer = await add('App-server start');
  assert.equal(appServer.ok, true, JSON.stringify(appServer));
  const sharedOutcome = outcome(appServer.todo.id);
  evidence.push({ sharedOutcome });
  assert.deepEqual(sharedOutcome.delivery, { delivered: true, startedTurnId: 'synthetic-shared' });
  assert.deepEqual(owns(appServer.todo.id, sharedOutcome.ref, 'synthetic-shared'), ['synthetic-shared']);
  console.log('PASS: app-server start keeps its opening turn id and gives its todo');

  sharedTurn = null;
  const missing = await add('App-server start without a turn id');
  const missingOutcome = missing.todo ? outcome(missing.todo.id) : null;
  evidence.push({ missingOutcome });
  assert.notEqual(missing.todo?.state, 'doing', JSON.stringify(missing));
  assert.match(String(missingOutcome?.failure ?? JSON.stringify(missing)), /turn\/start returned no turn id/);
  console.log('PASS: app-server start without a turn id is not confirmed');
} finally {
  await app.cleanup();
  shared.stop(true);
  await closeDesktop?.();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
