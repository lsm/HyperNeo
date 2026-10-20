import { strict as assert } from 'node:assert';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
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
const calls: unknown[] = [];
const logs: unknown[] = [];
const replies: unknown[] = [];
const unsubscribe = subscribeToStructuredLogs((event) => { if (event.module?.includes('codex-send')) logs.push(event); });
const http = createHttpServer();
const server = new WebSocketServer({ server: http });
server.on('connection', (socket) => socket.on('message', (bytes) => {
  const request = JSON.parse(String(bytes));
  calls.push({ server: request.method, params: request.params });
  if (request.method === 'thread/name/set') {
    assert.equal(request.params.threadId, 'synthetic');
    const own = new Database(join(home, 'state_5.sqlite'));
    own.prepare('UPDATE threads SET name = ?, title = ? WHERE id = ?').run(request.params.name, request.params.name, 'synthetic');
    own.close();
    socket.send(JSON.stringify({ method: 'thread/name/updated', params: { threadId: 'synthetic', threadName: request.params.name } }));
    socket.send(JSON.stringify({ id: request.id, result: {} }));
  } else socket.send(JSON.stringify({ id: request.id, result: {} }));
}));
await new Promise<void>((done) => http.listen(join(home, 'app-server-control/app-server-control.sock'), done));
let ws: WebSocket | undefined;
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
try {
  await app.spaceRuntimeService.ready();
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connection failed')); });
  const rpc = (name: string, input: unknown) => new Promise<any>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
    ws!.onmessage = (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer); replies.push({ name, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const ref = { adapter: 'codex-desktop', id: 'synthetic' };
  const discovery = await rpc('operations.describe', { name: 'work.rename' });
  if (action === 'reproduce') {
    assert.equal(discovery.found, false);
  } else {
    assert.equal(discovery.found, true);
    const renamed = await rpc('work.rename', { ref, title: ' HyperNeo backend ' });
    assert.deepEqual(renamed, { ok: true, value: { renamed: true, title: 'HyperNeo backend' } });
    assert.equal((await rpc('work.status', { ref })).value.title, 'HyperNeo backend');
    assert.equal((await rpc('work.rename', { ref: { adapter: 'claude-desktop', id: 'synthetic' }, title: 'ops' })).reason, 'not_supported');
    const invalid = await rpc('work.rename', { ref, title: 'invalid\nname' }).catch((error) => ({ code: String(error) }));
    assert(invalid.ok === false || invalid.code, 'invalid title must be rejected');
    assert.equal(calls.filter((call) => (call as { server?: string }).server === 'thread/name/set').length, 1);
  }
  console.log(`${action} PASS: ${run}/evidence/observed.json`);
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ action, replies, calls, logs }, null, 2));
  ws?.close(); await app.cleanup(); unsubscribe();
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((done) => server.close(() => done()));
  await new Promise<void>((done) => http.close(() => done()));
}
