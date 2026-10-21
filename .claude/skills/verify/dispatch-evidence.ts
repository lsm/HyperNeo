import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const [portText, runText] = process.argv.slice(2);
assert(runText);
const run = resolve(runText);
const port = Number(portText);
assert(Number.isInteger(port) && port > 0 && port < 65536 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const dir of ['home/.codex/app-server-control', 'evidence', 'workspace', 'bin']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
const codex = join(run, 'home/.codex');
const rollout = join(codex, 'synthetic.jsonl');
writeFileSync(rollout, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Earlier task only.' } })}\n`);
const state = new Database(join(codex, 'state_5.sqlite'));
state.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT, git_branch TEXT)`);
state.prepare(`INSERT INTO threads VALUES ('synthetic-thread', 'Synthetic worker', '', '', ?, 'vscode', 0, 1, ?, NULL)`).run(join(run, 'workspace'), rollout);
state.close();
const evidence: unknown[] = [];
let mode = 'queue';
const peer = Bun.serve({
  unix: join(codex, 'app-server-control/app-server-control.sock'),
  fetch(request, server) { return server.upgrade(request) ? undefined : new Response('websocket only', { status: 400 }); },
  websocket: {
    message(socket, data) {
      const message = JSON.parse(String(data));
      if (!('id' in message)) return;
      evidence.push({ peer: message });
      const result = message.method === 'thread/turns/list'
        ? { data: mode === 'steer' ? [{ id: 'synthetic-turn', status: 'inProgress' }] : [] }
        : message.method === 'thread/queue/add'
          ? { queuedSubmission: { id: 'synthetic-queue' } }
          : message.method === 'turn/steer' ? { turnId: 'synthetic-turn' } : {};
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    },
  },
});
const sessionId = 'neo:10000000-0000-4000-8000-000000000002';
const ref = { adapter: 'codex-desktop', id: 'synthetic-thread' };
const dbPath = join(run, 'data/daemon.db');
let todoId = '';
try {
  for (const phase of ['initial', 'restart']) {
    const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath }), verbose: false });
    try {
      await app.spaceRuntimeService.ready();
      const db = app.db.getDatabase();
      const sessions = new NeoTodoSessionRepository(db);
      const handler = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId, role: 'neo' }));
      const invoke = async (name: string, input: unknown) => {
        const reply = await handler({ name, input });
        assert.equal(reply.content[0].type, 'text');
        const result = JSON.parse(reply.content[0].text);
        evidence.push({ phase, name, input, result });
        assert.equal(result.ok, true, JSON.stringify(result));
        return result;
      };
      if (phase === 'initial') {
        db.exec(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES ('${sessionId}','Synthetic Neo','/tmp','2026-10-20T00:00:00Z','2026-10-20T00:00:00Z','active','{}','{}')`);
        new NeoRepository(db).reserveBinding({ sessionId, kind: 'neo', projectId: null });
        new NeoAskTodoRepository(db).openAsk({ id: 'synthetic-ask', projectId: null, sessionId, originMessageId: null, title: 'Synthetic evidence', request: 'Retain peer acknowledgement', createdAt: 1 });
        const started = await invoke('neo.todo.add', { askId: 'synthetic-ask', title: 'Synthetic queue', doneWhen: 'Facts retained', instruction: 'Only a synthetic queued instruction', target: { verb: 'send', ref }, start: true });
        todoId = started.todo.id;
      }
      const queued = sessions.readSent(todoId);
      evidence.push({ phase, queued });
      assert.deepEqual(queued?.delivery, { delivered: false, queuedSubmissionId: 'synthetic-queue' });
      assert.equal(sessions.readStartedAt(todoId), null, 'queue acknowledgement is not a turn start');
      if (phase === 'restart') {
        mode = 'steer';
        await invoke('neo.todo.continue', { todoId, message: 'Synthetic follow-up only' });
        const steered = sessions.readSent(todoId);
        evidence.push({ phase, steered });
        assert.deepEqual(steered?.delivery, { delivered: true, steeredIntoTurnId: 'synthetic-turn' });
      }
    } finally { await app.cleanup(); }
  }
  const reopened = new Database(dbPath, { readonly: true });
  try { assert.deepEqual(new NeoTodoSessionRepository(reopened).readSent(todoId)?.delivery, { delivered: true, steeredIntoTurnId: 'synthetic-turn' }); }
  finally { reopened.close(); }
  console.log(`PASS: real daemon MCP todo dispatch retains queue/steer facts across daemon restart and read-only DB reopen. ${run}/evidence/observed.json`);
} finally {
  peer.stop(true);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
