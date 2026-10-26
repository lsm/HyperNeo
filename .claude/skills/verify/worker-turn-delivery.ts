import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { sdkMessageBodyAt } from '../../../packages/daemon/src/storage/repositories/sdk-message-body-read.ts';
import { hyperneoInputText } from '../../../packages/daemon/src/lib/drivers/hyperneo-adapter.ts';
import { RemoteDaemonRegistry, remoteDaemons } from '../../../packages/daemon/src/lib/remote-daemons/registry.ts';
import { createRemoteSendForwarder } from '../../../packages/daemon/src/lib/remote-daemons/forward-send.ts';

const [mode, directory] = process.argv.slice(2);
const run = resolve(directory);
assert(['before', 'status-before', 'sender-before', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
assert.notEqual(app.server.port, 8399);
const db = app.db.getDatabase();
const todos = new NeoAskTodoRepository(db);
const sessions = new NeoTodoSessionRepository(db);
const root = 'neo:10000000-0000-4000-8000-000000008835';
const evidence: Record<string, unknown> = { mode };
const outbound = new RemoteDaemonRegistry();
let peer: ReturnType<typeof Bun.serve> | undefined;
const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
await new Promise<void>((done, fail) => { ws.onopen = () => done(); ws.onerror = () => fail(new Error('RPC unavailable')); });
const rpc = (name: string, input: unknown) => new Promise<any>((done, fail) => {
  const id = crypto.randomUUID();
  const timer = setTimeout(() => fail(new Error(`${name} timed out`)), 20000);
  ws.onmessage = (event) => {
    const reply = JSON.parse(String(event.data));
    if (reply.id !== id && reply.requestId !== id) return;
    clearTimeout(timer);
    reply.error ? fail(new Error(JSON.stringify(reply.error))) : done(reply.data);
  };
  ws.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
});
const seedSession = (id: string) => app.db.createSession({ id, title: 'Synthetic inbox proof', workspacePath: run, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
const refresh = async () => {
  const job = app.jobQueue.enqueue({ queue: 'neo.work.driver.refresh', payload: { scope: 'neo' }, runAt: Date.now() });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const status = app.jobQueue.getJob(job.id)?.status;
    if (status === 'completed') return;
    assert.notEqual(status, 'dead');
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('refresh timed out');
};
const messages = () => (db.prepare(`SELECT ${sdkMessageBodyAt('m.rowid')} AS body FROM sdk_messages m WHERE session_id=? AND message_type='user' ORDER BY seq`).all(root) as { body: string }[]).map((row) => hyperneoInputText(row.body));
try {
  await seedSession(root);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  for (const scenario of [false, true, 'status-drift']) {
    const explicit = scenario === true;
    const drifting = scenario === 'status-drift';
    const worker = `worker-${scenario}`;
    await seedSession(worker);
    const at = Date.now();
    todos.openAsk({ id: worker, title: worker, request: 'Observe worker milestone', sessionId: root, projectId: null, originMessageId: null, createdAt: at });
    const ref = { adapter: 'hyperneo', id: worker };
    const bind = async (index: number) => {
      const id = `${worker}-${index}`;
      const todo = todos.addTodo(id, worker, { title: id, doneWhen: 'Synthetic PR merged', check: { pack: 'coding', kind: 'pr_merged', params: { urls: [] } }, instruction: 'Observe this worker', named: null }, at);
      sessions.create(id, { verb: 'send', ref });
      sessions.recordRef(id, ref, at);
      sessions.recordSent(id, { inputBefore: at, opening: 'Observe this worker', receipt: { executionId: worker, inputId: `${worker}-input` } });
      todos.updateTodo(todo, { state: 'doing', startedAt: at, report: 'Previously retained result' }, at);
      const dispatch = await sessions.inputs.accept(id, root, { verb: 'send', ref }, 'Observe this worker', at);
      await sessions.inputs.recordOutcome(dispatch, { ref, receipt: { executionId: worker, inputId: `${worker}-input` } }, at);
    };
    for (let index = 0; index < (drifting ? 1 : 2); index++) await bind(index);
    const put = (id: string, type: string, text: string) => {
      const uuid = id;
      const body = type === 'result' ? { type, uuid, subtype: 'success', result: text, is_error: false } : { type, uuid, message: { content: text } };
      db.prepare("INSERT INTO sdk_messages(id,session_id,sdk_uuid,message_type,sdk_message,timestamp,send_status,is_terminal,consumed_seq) VALUES (?,?,?,?,?,?,'consumed',?,?)").run(id, worker, uuid, type, JSON.stringify(body), new Date().toISOString(), type === 'result' ? 1 : 0, type === 'result' ? 2 : 1);
    };
    put(`${worker}-input`, 'user', 'Observe this worker');
    if (explicit) evidence.explicitReceipt = await rpc('message.send', { to: root, text: 'PR opened: synthetic milestone', kind: 'done', from: `session:${worker}` });
    await new Promise((done) => setTimeout(done, 5));
    put(`${worker}-result`, 'result', 'PR opened: synthetic milestone');
    await refresh();
    if (drifting) {
      evidence.firstStatus = await rpc('work.status', { ref });
      db.prepare('UPDATE sessions SET processing_state=? WHERE id=?').run(JSON.stringify({ status: 'processing' }), worker);
      await bind(1);
      evidence.secondStatus = await rpc('work.status', { ref });
      assert.equal((evidence.firstStatus as any).value.status, 'done');
      assert.equal((evidence.secondStatus as any).value.status, 'running');
      await refresh();
      db.prepare('UPDATE sessions SET processing_state=NULL WHERE id=?').run(worker);
    }
    await new Promise((done) => setTimeout(done, 500));
    await refresh();
    if (mode === 'verify') {
      const beforeReplay = messages().length;
      put(`${worker}-repeat-result`, 'result', 'PR opened: synthetic milestone');
      await refresh();
      await new Promise((done) => setTimeout(done, 500));
      assert.equal(messages().length, beforeReplay);
      evidence[`${worker}-replay`] = { before: beforeReplay, after: messages().length };
    }
    const delivered = messages().filter((text) => text.startsWith('Worker turn report') && text.includes(`todo ${worker}-`));
    evidence[worker] = { reportInputs: delivered.length, delivered, stored: [0, 1].map((index) => todos.getTodo(`${worker}-${index}`)) };
    assert.equal(delivered.length, mode === 'before' || (mode === 'status-before' && drifting) ? 2 : explicit ? 0 : 1);
    for (let index = 0; index < 2; index++) assert.equal(todos.getTodo(`${worker}-${index}`)?.report, 'Agent: PR opened: synthetic milestone');
  }
  const machine = 'synthetic-origin';
  let remoteWork: Record<string, unknown> = {};
  peer = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response('upgrade', { status: 400 }); },
    websocket: { message(socket, bytes) {
      const call = JSON.parse(String(bytes));
      if (call.type !== 'REQ') return;
      socket.send(JSON.stringify({ ...call, id: crypto.randomUUID(), requestId: call.id, type: 'RSP', data: { ok: true, value: remoteWork } }));
    } },
  });
  await remoteDaemons.attach('attachment-alias', `ws://127.0.0.1:${peer.port}/ws`);
  await outbound.attach('recipient', `ws://127.0.0.1:${app.server.port}/ws`);
  const forward = createRemoteSendForwarder(outbound, machine);
  for (const adapter of ['hyperneo', 'codex-desktop', 'claude-code']) {
    const worker = `remote-${adapter}`;
    const at = Date.now();
    const ref = { adapter, id: worker, daemon: 'attachment-alias' };
    todos.openAsk({ id: worker, title: worker, request: 'Remote sender identity', sessionId: root, projectId: null, originMessageId: null, createdAt: at });
    const todo = todos.addTodo(worker, worker, { title: worker, doneWhen: 'Synthetic PR merged', check: { pack: 'coding', kind: 'pr_merged', params: { urls: [] } }, instruction: 'Observe remote sender', named: null }, at);
    sessions.create(worker, { verb: 'send', ref });
    sessions.recordRef(worker, ref, at);
    todos.updateTodo(todo, { state: 'doing', startedAt: at }, at);
    const dispatch = await sessions.inputs.accept(worker, root, { verb: 'send', ref }, 'Observe remote sender', at);
    await sessions.inputs.recordOutcome(dispatch, { ref }, at);
    const localId = adapter === 'hyperneo' ? worker : `${adapter}:${worker}`;
    const receipt = await forward({ kind: 'remote-session', daemonId: 'recipient', sessionId: root }, {
      sessionId: root, kind: 'done', message: { type: 'user', message: { content: `Remote milestone ${adapter}` }, parent_tool_use_id: null },
    }, `session:${encodeURIComponent(localId)}`);
    assert.equal(receipt.kind, 'accepted');
    remoteWork = { ref: { adapter, id: worker }, title: worker, place: { machine, name: 'Remote fixture' },
      status: 'done', lastActivityAt: at, turnEnds: [{ id: `${worker}-turn`, startedAt: at, at: Date.now() + 1, message: `Remote milestone ${adapter}` }] };
    evidence[`${worker}-status`] = await rpc('work.status', { ref, since: at });
    await refresh();
    await new Promise((done) => setTimeout(done, 500));
    const reports = messages().filter((text) => text.startsWith('Worker turn report') && text.includes(`todo ${worker},`));
    const recorded = db.prepare('SELECT from_session FROM neo_session_messages WHERE message_id=?').get(receipt.kind === 'accepted' ? receipt.messageId : '');
    evidence[`${worker}-sender`] = { recorded, reports, receipt };
    assert.equal(reports.length, mode === 'sender-before' ? 1 : 0);
    todos.updateTodo(todos.getTodo(worker)!, { state: 'removed' }, Date.now());
  }
  evidence.recipientInputs = messages();
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  ws.close();
  await remoteDaemons.detach('attachment-alias');
  await outbound.detach('recipient');
  peer?.stop(true);
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
