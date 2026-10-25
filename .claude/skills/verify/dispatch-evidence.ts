import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { syntheticCodexDesktop } from './codex-desktop-peer.ts';

const [portText, runText] = process.argv.slice(2);
assert(runText);
const run = resolve(runText);
const port = Number(portText);
const obligations = process.argv.includes('--obligations');
assert(Number.isInteger(port) && port > 0 && port < 65536 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const dir of ['home/.codex/app-server-control', 'home/.claude/projects', 'home/.claude/sessions', 'evidence', 'workspace', 'bin']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
const codex = join(run, 'home/.codex');
const rollout = join(codex, 'synthetic.jsonl');
writeFileSync(rollout, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Earlier task only.' } })}\n`);
const state = new Database(join(codex, 'state_5.sqlite'));
state.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, updated_at_ms INTEGER); CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT)`);
state.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT, git_branch TEXT)`);
state.prepare(`INSERT INTO threads VALUES ('synthetic-thread', 'Synthetic worker', '', '', ?, 'vscode', 0, 1, ?, NULL)`).run(join(run, 'workspace'), rollout);
state.close();
const evidence: unknown[] = [];
let mode = 'idle';
const beforeEffects: { method: string; inputs: Record<string, unknown>[]; message?: string }[] = [];
const readInputs = () => {
  const db = new Database(join(run, 'data/daemon.db'), { readonly: true });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name = 'work_delivery_inputs'").get()) return [];
    return db.prepare('SELECT * FROM work_delivery_inputs ORDER BY rowid').all() as Record<string, unknown>[];
  } finally { db.close(); }
};
const cliSession = '10000000-0000-4000-8000-000000000003';
chmodSync(join(run, 'home/.claude/sessions'), 0o700);
const inboxPath = join(run, `home/.claude/sessions/${process.pid}.sock`);
writeFileSync(join(run, `home/.claude/sessions/${process.pid}.json`), JSON.stringify({ sessionId: cliSession, pid: process.pid, procStart: 1, entrypoint: 'cli', version: '2.1.295', messagingSocketPath: inboxPath }));
writeFileSync(join(run, 'bin/claude'), `#!/bin/sh\nprintf '%s' '${JSON.stringify([{ sessionId: cliSession, status: 'idle', pid: process.pid }])}'\n`, { mode: 0o700 });
const inbox = createServer(socket => { socket.on('data', bytes => { evidence.push({ cliInboxBytes: bytes.toString() }); if (obligations) { const inputs = readInputs(); beforeEffects.push({ method: 'claude/inbox', inputs }); evidence.push({ beforeExternalEffect: 'claude/inbox', inputs }); } }); socket.on('end', () => socket.end()); });
await new Promise<void>((done, fail) => { inbox.once('error', fail); inbox.listen(inboxPath, done); });
chmodSync(inboxPath, 0o600);
const peer = Bun.serve({
  unix: join(codex, 'app-server-control/app-server-control.sock'),
  fetch(request, server) { return server.upgrade(request) ? undefined : new Response('websocket only', { status: 400 }); },
  websocket: {
    message(socket, data) {
      const message = JSON.parse(String(data));
      if (!('id' in message)) return;
      evidence.push({ peer: message });
      if (obligations && ['turn/start', 'turn/steer'].includes(message.method)) {
        const inputs = readInputs();
        beforeEffects.push({ method: message.method, inputs, message: message.params.input[0].text });
        evidence.push({ beforeExternalEffect: message.method, inputs });
      }
      const result = message.method === 'thread/turns/list'
        ? { data: mode === 'steer' ? [{ id: 'synthetic-turn', status: 'inProgress' }] : [] }
        : message.method === 'turn/start'
          ? { turn: { id: 'synthetic-started' } }
          : message.method === 'turn/steer' ? { turnId: 'synthetic-turn' } : {};
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    },
  },
});
const sessionId = 'neo:10000000-0000-4000-8000-000000000002';
const closeDesktop = await syntheticCodexDesktop(run, {
  active: () => mode === 'steer',
  start: (request) => {
    const message = request.params.turnStart.request.input[0].text;
    evidence.push({ desktopStart: request });
    if (obligations) {
      const inputs = readInputs();
      beforeEffects.push({ method: 'turn/start', inputs, message });
      evidence.push({ beforeExternalEffect: 'turn/start', inputs });
    }
    return 'synthetic-started';
  },
  steer: () => {
    if (obligations) {
      const inputs = readInputs();
      beforeEffects.push({ method: 'turn/steer', inputs });
      evidence.push({ beforeExternalEffect: 'turn/steer', inputs });
    }
    return 'synthetic-turn';
  },
});
const ref = { adapter: 'codex-desktop', id: 'synthetic-thread' };
const dbPath = join(run, 'data/daemon.db');
let todoId = '';
let unconfirmedId = '';
let unconfirmedInput: string | undefined;
let initialInputs: unknown;
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
        const started = await invoke('neo.todo.add', { askId: 'synthetic-ask', title: 'Synthetic idle turn', doneWhen: 'Facts retained', instruction: 'Only a synthetic opening instruction', target: { verb: 'send', ref }, start: true });
        assert.equal(started.todo.state, 'doing', JSON.stringify(started.todo));
        todoId = started.todo.id;
        if (obligations) assert(beforeEffects.some(event => event.method === 'turn/start' && event.inputs.some(row => row.todo_id === todoId && row.outcome === null && event.message?.includes(String(row.message)))), 'durable accepted input must exist before external turn start');
        const unconfirmed = await invoke('neo.todo.add', { askId: 'synthetic-ask', title: 'Synthetic inbox', doneWhen: 'Facts retained', instruction: 'Unconfirmed synthetic instruction', target: { verb: 'send', ref: { adapter: 'claude-code', id: cliSession } }, start: true });
        assert.equal(unconfirmed.todo.state, 'doing', JSON.stringify(unconfirmed.todo));
        unconfirmedId = unconfirmed.todo.id;
        if (obligations) assert(beforeEffects.some(event => event.method === 'claude/inbox' && event.inputs.some(row => row.todo_id === unconfirmedId && row.outcome === null)));
      }
      if (obligations) {
        const inputs = readInputs();
        evidence.push({ phase, deliveryInputs: inputs });
        assert.equal(inputs.length, 2);
        if (phase === 'initial') initialInputs = inputs;
        else assert.deepEqual(inputs, initialInputs, 'restart must not reset input evidence or deadlines');
        for (const row of inputs) {
          assert.equal(Number(row.deadline_at) - Number(row.accepted_at), 30000);
          assert(row.outcome);
        }
      }
      const pending = sessions.readSent(unconfirmedId);
      evidence.push({ phase, unconfirmed: pending });
      assert.equal(pending?.delivery?.delivered, false);
      assert.equal(pending?.delivery?.unconfirmed, true);
      assert.equal(pending?.delivery?.receipt?.executionId, cliSession);
      assert(pending?.delivery?.receipt?.inputId);
      if (phase === 'initial') unconfirmedInput = pending.delivery.receipt.inputId;
      else assert.equal(pending.delivery.receipt.inputId, unconfirmedInput);
      evidence.push({ phase, unconfirmedAnchor: sessions.readStartedAt(unconfirmedId) });
      assert.equal(sessions.readStartedAt(unconfirmedId), 0, 'written inbox input keeps its pre-send baseline anchor without claiming consumption');
      const opening = sessions.readSent(todoId);
      evidence.push({ phase, opening });
      assert.deepEqual(opening?.delivery, { delivered: true, startedTurnId: 'synthetic-started' });
      assert.equal(sessions.readStartedAt(todoId), 1, 'existing session baseline remains separate from the turn acknowledgement');
      if (phase === 'restart') {
        mode = 'steer';
        await invoke('neo.todo.continue', { todoId, message: 'Synthetic follow-up only' });
        const steered = sessions.readSent(todoId);
        evidence.push({ phase, steered });
        assert.deepEqual(steered?.delivery, { delivered: true, steeredIntoTurnId: 'synthetic-turn' });
      }
    } finally { await app.cleanup(); }
  }
  if (obligations) {
    const inputs = readInputs();
    evidence.push({ reopenedInputs: inputs });
    assert.equal(inputs.length, 3);
    const own = inputs.filter(row => row.todo_id === todoId);
    assert.equal(own.length, 2);
    assert.notEqual(own[0].id, own[1].id);
    assert.deepEqual(JSON.parse(String(own[0].outcome)).delivery, { delivered: true, startedTurnId: 'synthetic-started' });
    assert.deepEqual(JSON.parse(String(own[1].outcome)).delivery, { delivered: true, steeredIntoTurnId: 'synthetic-turn' });
    assert(beforeEffects.at(-1)?.inputs.some(row => row.outcome === null && String(row.message).includes('Synthetic follow-up only')));
  }
  const reopened = new Database(dbPath, { readonly: true });
  try { assert.deepEqual(new NeoTodoSessionRepository(reopened).readSent(todoId)?.delivery, { delivered: true, steeredIntoTurnId: 'synthetic-turn' }); }
  finally { reopened.close(); }
  console.log(`PASS: ${obligations ? "write-ahead input history/deadlines plus " : ""}real daemon MCP todo dispatch retains start/unconfirmed/steer facts across daemon restart and read-only DB reopen. ${run}/evidence/observed.json`);
} finally {
  peer.stop(true);
  await closeDesktop();
  await new Promise<void>(done => inbox.close(() => done()));
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
