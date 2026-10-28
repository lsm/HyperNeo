import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoTodoRunner } from '../../../packages/daemon/src/lib/neo/todo-runner.ts';
import { gatewayFor } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { Result, WorkDelivery, WorkDetail, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';

const [portText, runText] = process.argv.slice(2);
const run = resolve(runText);
const port = Number(portText);
assert(Number.isInteger(port) && port >= 0 && port < 65536 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data')));
for (const dir of ['bin', 'evidence', 'workspace', 'home/.claude']) mkdirSync(join(run, dir), { recursive: true });
const fixture = fileURLToPath(new URL('../../../packages/daemon/tests/fixtures/claude-b1-cli.ts', import.meta.url));
const wrapper = (name: string, setup = '') => writeFileSync(join(run, 'bin', name), `#!/usr/bin/env bun\n${setup}\nawait import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
wrapper('claude', "if (process.argv.includes('--desktop')) process.argv.push('--synthetic-desktop-import');");
if (process.env.VERIFY_HANDOFF_TIMEOUT === '1')
  writeFileSync(join(run, 'bin/script'), '#!/bin/sh\nexec /usr/bin/script "$@"\n', { mode: 0o700 });
else wrapper('script', "process.argv.push('--synthetic-desktop-import');");
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/ps'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
const settings = join(run, 'home/.claude/settings.json');
writeFileSync(settings, '{"permissions":{"defaultMode":"bypassPermissions"}}');
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const originalSettings = digest(settings);
const rcId = crypto.randomUUID();
for (const args of [
  ['claude', '-p', '--session-id', rcId, '-n', 'rc-toggle', '--permission-mode', 'auto', '--', 'Existing authorized synthetic RC helper'],
  ['script', '-q', '/dev/null', 'claude', '--desktop', '--resume', rcId],
]) {
  const result = spawnSync(args[0], args.slice(1), { cwd: join(run, 'workspace'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
const evidence: unknown[] = [];
const events = () => readFileSync(join(run, 'evidence/native-events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
const scope = join(run, 'home/Library/Application Support/Claude/claude-code-sessions/synthetic/account');
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
assert.notEqual(app.server.port, 8399);
let ws: WebSocket | undefined;
try {
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connection failed')); });
  const rpc = <T>(name: string, input: unknown) => new Promise<T>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      ws!.removeEventListener('message', receive);
      fail(new Error(`${name} timeout`));
    }, 150000);
    const receive = (event: MessageEvent) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      ws!.removeEventListener('message', receive);
      clearTimeout(timer); evidence.push({ name, input, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.addEventListener('message', receive);
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const caller = 'synthetic-delivery-origin';
  await app.db.createSession({ id: caller, title: caller, workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const initialFrames: Array<{ uuid: string; message: { content: string } }> = [];
  const heldReceipts: Array<{ orig_msg_id: string; status: string }> = [];
  const initialSocket = join(run, '9001.sock');
  const initialPeer = createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.endsWith('\n')) return;
      const frame = JSON.parse(buffer); initialFrames.push(frame);
      const record = JSON.parse(readFileSync(join(scope, `local_${frame.session_id}.json`), 'utf8'));
      if (frame.message.content.includes('from-mode="bypass"') !== (record.permissionMode === 'bypassPermissions')) {
        heldReceipts.push({ orig_msg_id: frame.msg_id, status: 'held' });
        return;
      }
      const transcript = join(run, 'home/.claude/projects', record.cwd.replace(/[/.]/g, '-'), `${frame.session_id}.jsonl`);
      appendFileSync(transcript, JSON.stringify({ type: 'user', uuid: frame.uuid, timestamp: new Date().toISOString(), message: frame.message }) + '\n');
      appendFileSync(transcript, JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'Initial direct completion' }], stop_reason: 'end_turn' } }) + '\n');
    });
  });
  await new Promise<void>(resolve => initialPeer.listen(initialSocket, resolve));
  chmodSync(initialSocket, 0o600);
  let started: Result<WorkStarted>;
  try {
    started = await rpc<Result<WorkStarted>>('work.start', { adapter: 'claude-desktop', from: `session:${caller}`, place: { machine: hostname(), folder: join(run, 'workspace'), name: 'Synthetic delivery project' }, title: 'TEST Desktop delivery worker', message: 'Initial delivery marker', provenance: true });
    evidence.push({ initialDirectFrames: initialFrames, heldReceipts });
    assert(started.ok, JSON.stringify(started));
    assert.equal(heldReceipts.length, 0, 'Auto receiver must not hold the initial direct frame');
    assert.equal(initialFrames.length, 1, 'work.start must use the initial direct inbox');
    assert.equal(started.value.receipt?.inputId, initialFrames[0].uuid);
    assert(!events().some(e => e.kind === 'target-relay'), 'Initial task must not spawn a relay');
    assert(initialFrames[0].message.content.includes('Agent: claude-opus-5-5 (effort: medium) via Claude'));
    evidence.push({ initialDirectFrames: initialFrames });
  } finally {
    await new Promise<void>(resolve => initialPeer.close(() => resolve()));
  }
  assert(started.ok);
  const ref = started.value.ref;
  const recordPath = join(scope, `${ref.id}.json`);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const statePath = join(run, 'evidence/native-sessions.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as Array<{ id: string; pid: number }>;
  const target = state.find(s => `local_${s.id}` === ref.id)!;
  const registrations = join(run, 'home/.claude/sessions');
  chmodSync(registrations, 0o700);
  const socketPath = join(registrations, `${target.pid}.sock`);
  const registration = join(registrations, `${target.pid}.json`);
  writeFileSync(registration, JSON.stringify({ ...JSON.parse(readFileSync(registration, 'utf8')), messagingSocketPath: socketPath }));
  const transcript = join(run, 'home/.claude/projects', record.cwd.replace(/[/.]/g, '-'), `${target.id}.jsonl`);
  let changeMode: string | undefined;
  const peer = createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.endsWith('\n')) return;
      const frame = JSON.parse(buffer);
      if (changeMode) {
        writeFileSync(recordPath, JSON.stringify({ ...JSON.parse(readFileSync(recordPath, 'utf8')), permissionMode: changeMode }));
        return;
      }
      const current = JSON.parse(readFileSync(recordPath, 'utf8'));
      if (frame.message.content.includes('from-mode="bypass"') !== (current.permissionMode === 'bypassPermissions')) {
        heldReceipts.push({ orig_msg_id: frame.msg_id, status: 'held' });
        return;
      }
      appendFileSync(transcript, JSON.stringify({ type: 'user', uuid: frame.uuid, timestamp: new Date().toISOString(), message: frame.message }) + '\n');
      appendFileSync(transcript, JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'Direct completion' }], stop_reason: 'end_turn' } }) + '\n');
    });
  });
  await new Promise<void>(resolve => peer.listen(socketPath, resolve));
  chmodSync(socketPath, 0o600);
  try {
    const db = app.db.getDatabase();
    const store = new NeoAskTodoRepository(db), sessions = new NeoTodoSessionRepository(db);
    new NeoRepository(db).reserveBinding({ sessionId: caller, kind: 'neo', projectId: null });
    const handler = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: caller, role: 'neo' }));
    const invokeTodo = async (name: string, input: unknown) => {
      const reply = await handler({ name, input });
      const result = JSON.parse(reply.content[0].text);
      evidence.push({ name, input, result });
      assert(!reply.isError && result.ok, JSON.stringify(result));
      return result;
    };
    appendFileSync(transcript, JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), effort: 'medium', message: { model: 'claude-opus-5-5', content: [] } }) + '\n');
    const check = { pack: 'core', kind: 'evidence', params: { path: join(run, 'report.md') } };
    const opened = await invokeTodo('neo.ask.open', { title: 'Production bind', request: 'Track coding work', todos: [{ title: 'Bound worker', check }] });
    const boundId = opened.todos[0].id;
    await invokeTodo('neo.todo.bind', { todoId: boundId, ref });
    assert.equal(sessions.readCard(boundId)?.model, 'claude-opus-5-5', 'production bind of an ask-open todo must refresh observed identity');
    assert.equal(sessions.readCard(boundId)?.effort, 'medium');
    const added = await invokeTodo('neo.todo.add', { askId: opened.todos[0].askId, title: 'Added binding', check });
    await invokeTodo('neo.todo.bind', { todoId: added.todo.id, ref });
    assert.equal(sessions.readCard(added.todo.id)?.model, 'claude-opus-5-5', 'production bind of an added todo must refresh observed identity');
    const replacementRef = { adapter: 'claude-desktop', id: `local_${rcId}` };
    const replacementTranscript = join(run, 'home/.claude/projects', join(run, 'workspace').replace(/[/.]/g, '-'), `${rcId}.jsonl`);
    appendFileSync(replacementTranscript, JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), perTurnEffort: 'high', message: { model: 'claude-sonnet-5', content: [] } }) + '\n');
    await invokeTodo('neo.todo.bind', { todoId: boundId, ref: replacementRef });
    assert.equal(sessions.readCard(boundId)?.model, 'claude-sonnet-5', 'production rebind must read the replacement worker');
    assert.equal(sessions.readCard(boundId)?.effort, 'high');
    evidence.push({ productionBind: sessions.readCard(boundId), productionAddedBind: sessions.readCard(added.todo.id) });
    const askId = crypto.randomUUID();
    store.openAsk({ id: askId, sessionId: caller, projectId: null, originMessageId: 'fixture', title: 'Provenance', request: 'Write code and a report', createdAt: Date.now() });
    const todo = store.addTodo(crypto.randomUUID(), askId, { title: 'File evidence coding', doneWhen: 'report exists', check: { pack: 'core', kind: 'evidence', params: { path: join(run, 'report.md') } }, instruction: 'Write code and a report', named: null }, Date.now());
    sessions.bind(todo.id, ref, Date.now());
    sessions.recordRef(todo.id, ref, Date.now(), undefined, { model: 'stale', effort: 'low' });
    store.updateTodo(todo, { state: 'doing' }, Date.now());
    const runner = createNeoTodoRunner({
      write: gatewayFor(db).run.bind(gatewayFor(db)), store, sessions,
      limits: () => ({ running: 99, perGroup: 99 }), packs: () => [], tell: async () => {}, changed: () => {},
      invoke: async (_caller, name, input) => ({ kind: 'completed', value: await rpc(name, { ...input, from: `session:${caller}` }) }),
    });
    const snapshot = (model: string, effort?: string) => appendFileSync(transcript, JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), ...(effort ? { perTurnEffort: effort } : {}), message: { model, content: [{ type: 'text', text: 'Untrusted body effort: low' }] } }) + '\n');
    const openings = new Set<string>();
    for (const [model, effort] of [['claude-opus-5-5', 'medium'], ['claude-sonnet-5', 'high'], ['claude-sonnet-5', undefined]]) {
      snapshot(model!, effort);
      const result = await runner.proceed(todo.id, 'Continue the programming task.');
      assert(result.ok, JSON.stringify(result));
      const lines = readFileSync(transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const task = lines.findLast(entry => entry.type === 'user').message.content;
      assert(task.includes(`Agent: ${model} (effort: ${effort ?? 'unknown'}) via Claude`), task);
      const opening = sessions.readSent(todo.id)?.opening;
      assert(opening && task.includes(opening), 'stored opening must occur in the native task input');
      assert(!openings.has(opening), 'native follow-ups must have distinct delivery openings');
      openings.add(opening);
      const card = sessions.readCard(todo.id)!;
      assert.equal(card.model, model); assert.equal(card.effort, effort ?? null);
      sessions.bind(todo.id, ref, Date.now());
      assert.equal(sessions.readCard(todo.id)?.model, model);
      evidence.push({ deliveredTask: task, card });
    }
    sessions.bind(todo.id, { ...ref, id: 'replacement' }, Date.now());
    assert.equal(sessions.readCard(todo.id)?.model, null);
    assert.equal(sessions.readCard(todo.id)?.effort, null);
    console.log('PASS: public RPC first input has observed identity; todo continue refreshes real Claude status before native inbox delivery, including changed and unknown effort; bind preserves or clears identity.');
  } finally {
    await new Promise<void>(resolve => peer.close(() => resolve()));
  }
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    const closed = new Promise<void>(resolve => ws!.addEventListener('close', () => resolve(), { once: true })); ws.close(); await closed;
  }
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
