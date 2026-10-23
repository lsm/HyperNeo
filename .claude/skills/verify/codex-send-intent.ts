import { strict as assert } from 'node:assert';
import { mkdirSync, existsSync, writeFileSync, appendFileSync, readFileSync, renameSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';

const [action, portText, runText] = process.argv.slice(2);
const port = Number(portText);
const run = resolve(runText);
assert(['verify', 'reproduce', 'ownership'].includes(action));
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
const home = join(run, 'home/.codex');
mkdirSync(join(home, 'ipc'), { recursive: true });
mkdirSync(join(home, 'app-server-control'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const bin = join(run, 'bin');
mkdirSync(bin, { recursive: true });
assert(process.env.PATH?.startsWith(`${bin}:`), 'Launch with the owned bin directory first on PATH');
const openedMarker = join(run, 'opened');
const bootstrapPid = join(run, 'bootstrap.pid');
const openLog = join(run, 'evidence/open.jsonl');
writeFileSync(join(bin, 'open'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.some(a => a.includes('synthetic-new'))) {
  const pid = Number(fs.readFileSync(${JSON.stringify(bootstrapPid)}, 'utf8'));
  let alive = true;
  try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
  if (alive) throw new Error('Bootstrap process still owns the thread');
}
fs.appendFileSync(${JSON.stringify(openLog)}, JSON.stringify(args) + '\\n');
fs.writeFileSync(${JSON.stringify(openedMarker)}, 'owned');
`, { mode: 0o700 });
assert.equal(Bun.which('open'), join(bin, 'open'), 'Only the owned opener may run');
if (action === 'ownership') {
  const workspace = join(run, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { p: { rootPaths: [workspace] } }, 'app-server-project-id-by-legacy-project-id-by-host': { [`local:${home}`]: { p: 'project-1' } } }));
  const command = join(bin, 'codex');
  writeFileSync(command, `#!${process.execPath}
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
fs.writeFileSync(${JSON.stringify(bootstrapPid)}, String(process.pid));
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === 'thread/start' ? { thread: { id: 'synthetic-new', model: 'gpt-6.1-sol' } } : {};
  process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n');
});
rl.on('close', () => setTimeout(() => process.exit(fs.existsSync(${JSON.stringify(join(run, 'fail-bootstrap-exit'))}) ? 7 : 0), 40));
`, { mode: 0o700 });
  process.env.CODEX_CLI_PATH = command;
}
const rollout = join(run, 'synthetic-rollout.jsonl');
writeFileSync(rollout, '');
const db = new Database(join(home, 'state_5.sqlite'));
db.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT);
CREATE TABLE projects (id TEXT, name TEXT);
CREATE TABLE project_roots (project_id TEXT, path TEXT);
INSERT INTO threads VALUES ('synthetic', 'Synthetic', '', '', '/tmp/synthetic', 'desktop', 0, 1, '/missing-synthetic.jsonl');`);
db.prepare('UPDATE threads SET rollout_path = ?').run(rollout);
db.close();
let owner = action === 'ownership' ? 'missing' : 'offline';
let active = true;
let loaded = true;
let resumeError = '';
let consumeQueue = false;
let uncertain = false;
let refuse = false;
let startError = false;
let serverStartError = false;
const calls: unknown[] = [];
const logs: unknown[] = [];
const replies: unknown[] = [];
const unsubscribe = subscribeToStructuredLogs((event) => { if (event.module?.includes('codex-send')) logs.push(event); });
const desktop = createServer((socket) => {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const size = buffer.readUInt32LE(0);
      const request = JSON.parse(buffer.subarray(4, size + 4).toString());
      buffer = buffer.subarray(size + 4);
      calls.push({ desktop: request.method, version: request.version, params: request.params });
      if (owner === 'offline' && request.method === 'initialize') { socket.destroy(); continue; }
      const response = request.method === 'initialize' ? { resultType: 'success', result: { clientId: 'synthetic-client' } }
        : request.method === 'thread-owner-discovery' ? owner === 'owned' || (owner === 'missing' && existsSync(openedMarker)) ? { resultType: 'success', handledByClientId: 'fixture-owner' } : { resultType: 'error', error: owner === 'missing' ? 'no-client-found' : 'request-version-mismatch' }
        : request.method === 'thread-follower-start-turn' ? startError ? { resultType: 'error', error: 'start unavailable' } : { resultType: 'success', result: { result: { turn: { id: 'desktop-started' } } } }
        : refuse ? { resultType: 'error', error: 'NoActiveTurn' } : { resultType: 'success', result: { result: { turnId: 'desktop-active' } } };
      const body = Buffer.from(JSON.stringify({ type: 'response', requestId: request.requestId, ...response }));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    }
  });
});
await new Promise<void>((done) => desktop.listen(join(home, 'ipc/ipc.sock'), done));
const http = createHttpServer();
const server = new WebSocketServer({ server: http });
server.on('connection', (socket) => socket.on('message', (bytes) => {
  const request = JSON.parse(String(bytes));
  calls.push({ server: request.method, params: request.params });
  if (request.method === 'thread/resume' && !resumeError) loaded = true;
  if (request.method === 'thread/queue/add' && consumeQueue) {
    const text = request.params.input[0].text;
    const timestamp = new Date().toISOString();
    appendFileSync(rollout, [
      { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', id: 'writer-input', content: [{ type: 'input_text', text }] } },
      { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Writer received queued work.' }] } },
      { type: 'event_msg', timestamp, payload: { type: 'task_complete', last_agent_message: 'Writer received queued work.' } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  }
  const result = request.method === 'thread/resume' ? { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [] } }
    : request.method === 'thread/turns/list' ? { data: active ? [{ id: 'server-active', status: 'inProgress' }] : [{ id: 'completed-turn', status: 'completed' }] }
    : request.method === 'turn/start' ? { turn: { id: 'server-started', status: 'inProgress', items: [] } }
    : request.method === 'turn/steer' ? { turnId: 'server-active' } : { queuedSubmission: { id: 'synthetic-queue' } };
  socket.send(JSON.stringify({ id: request.id, ...(resumeError && request.method === 'thread/resume' ? { error: { code: -32600, message: resumeError } } : !loaded && request.method === 'turn/start' ? { error: { code: -32600, message: 'thread not found: synthetic' } } : serverStartError && request.method === 'turn/start' ? { error: { message: 'start unavailable' } } : uncertain && request.method === 'turn/steer' ? { error: { message: 'connection closed' } } : { result }) }));
}));
await new Promise<void>((done) => http.listen(join(home, 'app-server-control/app-server-control.sock'), done));
let ws: WebSocket | undefined;
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
try {
  await app.spaceRuntimeService.ready();
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connection failed')); });
  const send = (mode?: string, describe = false, adapters = false, receipt?: { executionId: string; inputId: string }, start = false) => new Promise<any>((done, fail) => {
    const ipcPath = join(home, 'ipc/ipc.sock');
    if (owner === 'offline' && existsSync(ipcPath)) renameSync(ipcPath, `${ipcPath}.offline`);
    else if (owner !== 'offline' && existsSync(`${ipcPath}.offline`)) renameSync(`${ipcPath}.offline`, ipcPath);
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
    ws!.onmessage = (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer); replies.push(reply);
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: start ? { name: 'work.start', input: { adapter: 'codex-desktop', place: { machine: hostname(), folder: join(run, 'workspace'), name: 'Synthetic' }, title: 'Synthetic opening', message: 'Synthetic opening message' } } : receipt ? { name: 'work.status', input: { ref: { adapter: 'codex-desktop', id: 'synthetic' }, receipt } } : adapters ? { name: 'work.adapters', input: {} } : describe ? { name: 'operations.describe', input: { name: 'work.send' } } : { name: 'work.send', input: { ref: { adapter: 'codex-desktop', id: 'synthetic' }, message: 'synthetic marker', ...(mode ? { mode } : {}) } }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const first = await send();
  if (action === 'ownership') {
    assert.equal(first.ok, true, 'a saved worker must open and deliver through Desktop');
    assert.equal(first.value.steeredIntoTurnId, 'desktop-active');
    assert.deepEqual(JSON.parse(readFileSync(openLog, 'utf8').trim().split('\n')[0]), ['-g', 'codex://threads/synthetic']);
    assert(!calls.some((call) => (call as { server?: string }).server), 'Desktop ownership failure must not touch the shared app-server');
    owner = 'owned';
    assert.equal((await send()).value.steeredIntoTurnId, 'desktop-active');
    refuse = true;
    assert.equal((await send()).value.startedTurnId, 'desktop-started');
    owner = 'refused';
    const refused = await send();
    assert.equal(refused.reason, 'not_delivered');
    assert.match(refused.detail, /request-version-mismatch/);
    assert(!calls.some((call) => (call as { server?: string }).server), 'Desktop owner must remain the sole writer');
    owner = 'owned';
    const started = await send(undefined, false, false, undefined, true);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.value.ref.id, 'synthetic-new');
    assert(calls.some((call) => (call as { desktop?: string; params?: { conversationId?: string } }).desktop === 'thread-follower-start-turn' && (call as { params?: { conversationId?: string } }).params?.conversationId === 'synthetic-new'));
    assert(!calls.some((call) => (call as { server?: string }).server), 'new work must not use shared server');
    writeFileSync(join(run, 'fail-bootstrap-exit'), '7');
    const beforeFailedBootstrap = calls.length;
    await assert.rejects(() => send(undefined, false, false, undefined, true), /bootstrap exited with 7/);
    assert(!calls.slice(beforeFailedBootstrap).some((call) => (call as { desktop?: string }).desktop === 'thread-follower-start-turn'), 'failed bootstrap cannot hand off');
  } else if (action === 'reproduce') {
    assert.equal(first.value.queuedSubmissionId, 'synthetic-queue');
    assert(!calls.some((call) => (call as { server?: string }).server === 'turn/steer'));
  } else {
    const discovery = await send(undefined, false, true);
    assert.equal(discovery.ok, true);
    const codex = discovery.value.find((adapter: { id: string }) => adapter.id === 'codex-desktop');
    assert(codex.capabilities.includes('steer'), 'Codex must advertise its implemented steer capability');
    const hyperneo = discovery.value.find((adapter: { id: string }) => adapter.id === 'hyperneo');
    assert(!hyperneo.capabilities.includes('steer'), 'Do not advertise steer for adapters without a steer method');
    const description = await send(undefined, true);
    assert.equal(description.found, true);
    assert(description.description.includes('For Codex, choose mode steer'));
    assert(description.description.includes('HyperNeo sessions and Space agents support auto, not explicit steer'));
    assert.equal(first.value.steeredIntoTurnId, 'server-active');
    assert.equal(first.value.queuedSubmissionId, undefined);
    assert.equal((await send('steer')).value.steeredIntoTurnId, 'server-active');
    assert.equal((await send('queue')).value.queuedSubmissionId, 'synthetic-queue');
    active = false; loaded = false;
    const before = calls.length;
    assert.equal((await send('steer')).reason, 'not_delivered');
    assert(!calls.slice(before).some((call) => (call as { server?: string }).server === 'thread/queue/add'));
    const idle = await send();
    assert.equal(idle.ok, true);
    assert.equal(idle.value.delivered, true);
    assert.equal(idle.value.startedTurnId, 'server-started');
    assert.equal(idle.value.queuedSubmissionId, undefined);
    assert(!calls.slice(before).some((call) => (call as { server?: string }).server === 'thread/queue/add'));
    assert(calls.slice(before).some((call) => {
      const request = call as { server?: string; params?: { threadId?: string; input?: { text: string }[] } };
      return request.server === 'turn/start' && request.params?.threadId === 'synthetic' && request.params.input?.[0].text.includes('synthetic marker');
    }));
    loaded = false; resumeError = 'rollout unavailable';
    const resumeBefore = calls.length;
    const resumeFailed = await send();
    assert.equal(resumeFailed.reason, 'not_delivered');
    assert.match(resumeFailed.detail, /rollout unavailable/);
    assert(!calls.slice(resumeBefore).some((call) => ['turn/start', 'thread/queue/add'].includes((call as { server: string }).server)));
    resumeError = 'thread synthetic already has an active writer'; owner = 'offline'; consumeQueue = true;
    const writerBefore = calls.length;
    const writerDelivered = await send();
    assert.equal(writerDelivered.ok, true, JSON.stringify(writerDelivered));
    assert(description.description.includes('already has an active writer'));
    assert.equal(writerDelivered.value.delivered, true);
    assert.equal(writerDelivered.value.queuedSubmissionId, 'synthetic-queue');
    assert.deepEqual(writerDelivered.value.receipt, { executionId: 'synthetic', inputId: 'writer-input' });
    assert(!calls.slice(writerBefore).some((call) => (call as { server?: string }).server === 'turn/start'));
    const writerRead = await send(undefined, false, false, writerDelivered.value.receipt);
    assert.equal(writerRead.value.inputEvidence.state, 'observed');
    assert(writerRead.value.inputEvidence.exchange.some((entry: { role: string; text: string }) => entry.role === 'agent' && entry.text === 'Writer received queued work.'));
    consumeQueue = false;
    const writerPending = await send();
    assert.equal(writerPending.ok, true);
    assert.equal(writerPending.value.delivered, false);
    assert.equal(writerPending.value.receipt, undefined);
    assert.equal(writerPending.value.queuedSubmissionId, 'synthetic-queue');
    resumeError = ''; owner = 'offline';
    serverStartError = true;
    const serverRefused = await send();
    assert.equal(serverRefused.reason, 'not_delivered');
    assert.match(serverRefused.detail, /start unavailable/);
    serverStartError = false;
    active = true; uncertain = true;
    const unknown = calls.length;
    assert.equal((await send()).reason, 'not_delivered');
    assert(!calls.slice(unknown).some((call) => (call as { server?: string }).server === 'thread/queue/add'));
    owner = 'owned'; uncertain = false;
    assert.equal((await send('steer')).value.steeredIntoTurnId, 'desktop-active');
    refuse = true;
    const rejected = await send('steer');
    assert.equal(rejected.reason, 'not_delivered');
    assert.match(rejected.detail, /NoActiveTurn/);
    const ownedBefore = calls.length;
    const started = await send();
    assert.equal(started.value.delivered, true);
    assert.equal(started.value.startedTurnId, 'desktop-started');
    assert.equal(started.value.queuedSubmissionId, undefined);
    startError = true;
    const impossible = await send();
    assert.equal(impossible.ok, false);
    assert.equal(impossible.reason, 'not_delivered');
    assert.match(impossible.detail, /start unavailable/);
    assert(!calls.slice(ownedBefore).some((call) => (call as { server?: string }).server === 'thread/queue/add'));
    assert(logs.length > 0, 'retained routing diagnostics required');
  }
  console.log(`${action} PASS: ${run}/evidence/observed.json`);
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ action, replies, calls, logs }, null, 2));
  ws?.close(); await app.cleanup(); unsubscribe();
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((done) => server.close(() => done()));
  await new Promise<void>((done) => http.close(() => done()));
  await new Promise<void>((done) => desktop.close(() => done()));
}
