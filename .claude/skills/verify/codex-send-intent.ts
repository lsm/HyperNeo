import { strict as assert } from 'node:assert';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';

const [action, portText, runText] = process.argv.slice(2);
const port = Number(portText);
const run = resolve(runText);
assert(['verify', 'reproduce'].includes(action));
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
const home = join(run, 'home/.codex');
mkdirSync(join(home, 'ipc'), { recursive: true });
mkdirSync(join(home, 'app-server-control'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const db = new Database(join(home, 'state_5.sqlite'));
db.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT);
CREATE TABLE projects (id TEXT, name TEXT);
CREATE TABLE project_roots (project_id TEXT, path TEXT);
INSERT INTO threads VALUES ('synthetic', 'Synthetic', '', '', '/tmp/synthetic', 'desktop', 0, 1, '/missing-synthetic.jsonl');`);
db.close();
let owner = 'refused';
let active = true;
let uncertain = false;
let refuse = false;
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
      calls.push({ desktop: request.method });
      const response = request.method === 'initialize' ? { resultType: 'success', result: { clientId: 'synthetic-client' } }
        : request.method === 'thread-owner-discovery' ? owner === 'owned' ? { resultType: 'success', handledByClientId: 'fixture-owner' } : { resultType: 'error', error: 'request-version-mismatch' }
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
  const result = request.method === 'thread/turns/list' ? { data: active ? [{ id: 'server-active', status: 'inProgress' }] : [] }
    : request.method === 'turn/steer' ? { turnId: 'server-active' } : { queuedSubmission: { id: 'synthetic-queue' } };
  socket.send(JSON.stringify({ id: request.id, ...(uncertain && request.method === 'turn/steer' ? { error: { message: 'connection closed' } } : { result }) }));
}));
await new Promise<void>((done) => http.listen(join(home, 'app-server-control/app-server-control.sock'), done));
let ws: WebSocket | undefined;
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
try {
  await app.spaceRuntimeService.ready();
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connection failed')); });
  const send = (mode?: string, describe = false) => new Promise<any>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
    ws!.onmessage = (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer); replies.push(reply);
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: describe ? { name: 'operations.describe', input: { name: 'work.send' } } : { name: 'work.send', input: { ref: { adapter: 'codex-desktop', id: 'synthetic' }, message: 'synthetic marker', ...(mode ? { mode } : {}) } }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const first = await send();
  if (action === 'reproduce') {
    assert.equal(first.value.queuedSubmissionId, 'synthetic-queue');
    assert(!calls.some((call) => (call as { server?: string }).server === 'turn/steer'));
  } else {
    const description = await send(undefined, true);
    assert.equal(description.found, true);
    assert(description.description.includes('For Codex, choose mode steer'));
    assert(description.description.includes('HyperNeo sessions and Space agents support auto, not explicit steer'));
    assert.equal(first.value.steeredIntoTurnId, 'server-active');
    assert.equal(first.value.queuedSubmissionId, undefined);
    assert.equal((await send('steer')).value.steeredIntoTurnId, 'server-active');
    assert.equal((await send('queue')).value.queuedSubmissionId, 'synthetic-queue');
    active = false;
    const before = calls.length;
    assert.equal((await send('steer')).reason, 'not_delivered');
    assert(!calls.slice(before).some((call) => (call as { server?: string }).server === 'thread/queue/add'));
    assert.equal((await send()).value.queuedSubmissionId, 'synthetic-queue');
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
