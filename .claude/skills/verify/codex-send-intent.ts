import { strict as assert } from 'node:assert';
import { mkdirSync, existsSync, writeFileSync, appendFileSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
import { startCodexDesktopTurn, steerCodexDesktopTurn } from '../../../packages/daemon/src/lib/drivers/codex-desktop-handoff.ts';
import { spawnProcess } from '../../../packages/daemon/src/lib/runtime-spawn/index.ts';
import { mock } from 'bun:test';
import { codexWorkerSandbox } from '../../../packages/daemon/src/lib/drivers/worker-sandbox.ts';

const [action, portText, runText] = process.argv.slice(2);
const port = Number(portText);
const run = resolve(runText);
assert(['verify', 'reproduce'].includes(action));
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
const bin = join(run, 'bin');
assert.equal(process.env.PATH?.split(':')[0], bin, 'Put the synthetic launcher on PATH before starting Bun');
mkdirSync(bin, { recursive: true });
const openLog = join(run, 'evidence/desktop-open.jsonl');
const runningFlag = join(run, 'desktop-running');
const refuseOpen = join(run, 'refuse-open');
writeFileSync(runningFlag, 'running');
writeFileSync(join(bin, 'ps'), `#!/usr/bin/env bun\nimport { existsSync } from 'node:fs';\nif(existsSync(${JSON.stringify(runningFlag)}))console.log('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT');\n`, {mode:0o700});
writeFileSync(join(bin, 'open'), `#!/usr/bin/env bun\nimport { appendFileSync, existsSync } from 'node:fs';\nappendFileSync(${JSON.stringify(openLog)}, JSON.stringify({ args: process.argv.slice(2), pid: process.pid })+String.fromCharCode(10));\nprocess.exit(existsSync(${JSON.stringify(refuseOpen)}) ? 1 : 0);\n`, { mode: 0o700 });
assert.equal(Bun.which('open'), join(bin, 'open'), 'Never run the host Desktop launcher in this journey');
const home = join(run, 'home/.codex');
mkdirSync(join(home, 'ipc'), { recursive: true });
mkdirSync(join(home, 'app-server-control'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const rollout = join(run, 'synthetic-rollout.jsonl');
writeFileSync(rollout, '');
const db = new Database(join(home, 'state_5.sqlite'));
db.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT);
CREATE TABLE projects (id TEXT, name TEXT);
CREATE TABLE project_roots (project_id TEXT, path TEXT);
INSERT INTO threads VALUES ('synthetic', 'Synthetic', '', '', '/tmp/synthetic', 'desktop', 0, 1, '/missing-synthetic.jsonl');`);
db.prepare('UPDATE threads SET rollout_path = ?').run(rollout);
db.close();
const worker = join(run, 'worker');
mkdirSync(join(worker, '.git'), { recursive: true });
let prepared = true;
mock.module('../../../packages/daemon/src/lib/drivers/worker-sandbox.ts', () => ({
  resumeWorkerSandbox: async () => prepared ? codexWorkerSandbox(worker) : null,
}));
const workerDb = new Database(join(home, 'state_5.sqlite'));
workerDb.prepare('UPDATE threads SET cwd=?').run(worker);
workerDb.close();
let owner = 'missing';
let ownerReadyAt = 0;
let openedReadyAt = 0;
let active = true;
let loaded = true;
let resumeError = '';
let failedStep = '';
let pendingText = '';
let uncertain = false;
let refuse = false;
let startError = false;
let serverStartError = false;
let queueFault = '';
let collide = false;
let reverseCollision = false;
const collisionRequests: { request: { id: unknown; params: { clientUserMessageId: string; input: { text: string }[] } }; reply: (result: unknown) => void }[] = [];
const collisions: unknown[] = [];
const calls: unknown[] = [];
const logs: unknown[] = [];
const replies: unknown[] = [];
const timings: unknown[] = [];
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
      if(owner==='delayed' && Date.now()>=ownerReadyAt)owner='owned';
      if(request.method==='thread-owner-discovery' && owner==='missing' && !existsSync(refuseOpen)
        && existsSync(openLog) && readFileSync(openLog,'utf8').includes('codex://threads/synthetic')) {
        if(!openedReadyAt)openedReadyAt=Date.now()+400;
        if(Date.now()>=openedReadyAt)owner='owned';
      }
      if(request.method==='thread-owner-discovery' && owner==='missing' && request.params?.conversationId==='synthetic'
        ){
        const timer=setTimeout(()=>{
          if(socket.destroyed)return;
          const body=Buffer.from(JSON.stringify({type:'response',requestId:request.requestId,resultType:'error',error:'no-client-found'}));
          const header=Buffer.alloc(4);header.writeUInt32LE(body.length);socket.write(Buffer.concat([header,body]));
        },10_000);
        socket.once('close',()=>clearTimeout(timer));
        continue;
      }
      const response = request.method === 'initialize' ? { resultType: 'success', result: { clientId: 'synthetic-client' } }
        : request.method === 'thread-owner-discovery' ? (owner === 'owned' || request.params?.conversationId === 'new-handoff-control') ? { resultType: 'success', handledByClientId: 'fixture-owner' } : { resultType: 'error', error: (owner === 'missing' || owner === 'delayed') ? 'no-client-found' : 'request-version-mismatch' }
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
  if (request.method === failedStep) {
    socket.close();
    return;
  }
  if (request.method === 'thread/loaded/list') {
    socket.send(JSON.stringify({ id: request.id, result: { data: loaded ? ['synthetic'] : [], nextCursor: null } }));
    return;
  }
  if (!loaded && ['thread/settings/update', 'thread/queue/add'].includes(request.method)) {
    socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: 'thread not found: synthetic' } }));
    return;
  }
  if (request.method === 'thread/queue/add' && collide) {
    collisionRequests.push({ request, reply: result => socket.send(JSON.stringify({ id: request.id, result })) });
    if (collisionRequests.length === 2) {
      if (reverseCollision) collisionRequests.reverse();
      const first = collisionRequests[0].request.params, timestamp = new Date().toISOString();
      appendFileSync(rollout, [
        { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', id: first.clientUserMessageId, content: [{ type: 'input_text', text: first.input[0].text }] } },
        { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First concurrent reply only.' }] } },
        { type: 'event_msg', timestamp, payload: { type: 'task_complete', last_agent_message: 'First concurrent reply only.' } },
      ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
      collisionRequests.forEach((entry, index) => entry.reply({ queuedSubmission: { id: `collision-${index}` } }));
    }
    return;
  }
  if (request.method === 'thread/queue/add' && queueFault) {
    if (queueFault === 'refused') socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: 'thread synthetic already has an active writer' } }));
    else if (queueFault === 'unsupported') socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'method not found' } }));
    else socket.close();
    return;
  }
  if (request.method === 'thread/resume' && !resumeError) loaded = true;
  if (request.method === 'thread/queue/add') pendingText = request.params.input[0].text;
  const result = request.method === 'thread/resume' ? { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [] } }
    : request.method === 'thread/turns/list' ? { data: active ? [{ id: 'server-active', status: 'inProgress' }] : [{ id: 'completed-turn', status: 'completed' }] }
    : request.method === 'turn/start' ? { turn: { id: 'server-started', status: 'inProgress', items: [] } }
    : request.method === 'turn/steer' ? { turnId: 'server-active' } : request.method==='thread/unsubscribe' ? {status:'unsubscribed'} : { queuedSubmission: { id: 'synthetic-queue' } };
  socket.send(JSON.stringify({ id: request.id, ...(resumeError && request.method === 'thread/resume' ? { error: { code: -32600, message: resumeError } } : !loaded && request.method === 'turn/start' ? { error: { code: -32600, message: 'thread not found: synthetic' } } : serverStartError && request.method === 'turn/start' ? { error: { message: 'start unavailable' } } : uncertain && request.method === 'turn/steer' ? { error: { message: 'connection closed' } } : { result }) }));
  if(request.method==='turn/start' && loaded && !serverStartError) setTimeout(()=>{
    if(socket.readyState===1)socket.send(JSON.stringify({method:'turn/completed',params:{threadId:'synthetic',turn:{id:'server-started',status:'completed'}}}));
  },10);
}));
await new Promise<void>((done) => http.listen(join(home, 'app-server-control/app-server-control.sock'), done));
let ws: WebSocket | undefined;
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
try {
  await app.spaceRuntimeService.ready();
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connection failed')); });
  const send = (mode?: string, describe = false, adapters = false, receipt?: { executionId: string; inputId: string }, message = 'synthetic marker') => new Promise<any>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
    const listener = (event: MessageEvent) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer); ws!.removeEventListener('message', listener); replies.push(reply);
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.addEventListener('message', listener);
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: receipt ? { name: 'work.status', input: { ref: { adapter: 'codex-desktop', id: 'synthetic' }, receipt } } : adapters ? { name: 'work.adapters', input: {} } : describe ? { name: 'operations.describe', input: { name: 'work.send' } } : { name: 'work.send', input: { ref: { adapter: 'codex-desktop', id: 'synthetic' }, message, ...(mode ? { mode } : {}) } }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  await startCodexDesktopTurn(join(home, 'ipc/ipc.sock'), spawnProcess, 'new-handoff-control', { threadId: 'new-handoff-control', input: [{ type: 'text', text: 'synthetic opening turn', text_elements: [] }] });
  assert(calls.some(call => {
    const request = call as { desktop?: string; params?: { conversationId?: string } };
    return request.desktop === 'thread-follower-start-turn' && request.params?.conversationId === 'new-handoff-control';
  }), 'New-thread control must open and hand off its first turn');
  owner = 'missing';
  let marked = calls.length;
  const steered = await send();
  assert.equal(steered.ok, true, JSON.stringify(steered));
  assert.equal(steered.value.delivered, true);
  assert.equal(steered.value.steeredIntoTurnId, 'desktop-active');
  assert(!calls.slice(marked).some(call => (call as { server?: string }).server), 'Automatic send must never resume or enqueue on the app-server while Desktop owns the thread');
  assert(calls.slice(marked).some(call => (call as { desktop?: string }).desktop === 'thread-follower-steer-turn'));
  assert(readFileSync(openLog, 'utf8').includes('codex://threads/synthetic'), 'An ownerless thread is opened in Desktop for delivery');
  refuse = true;
  marked = calls.length;
  const restarted = await send();
  assert.equal(restarted.ok, true, JSON.stringify(restarted));
  assert.equal(restarted.value.delivered, true);
  assert.equal(restarted.value.startedTurnId, 'desktop-started');
  assert(!calls.slice(marked).some(call => (call as { server?: string }).server), 'No app-server writer may start while Desktop owns the thread');
  refuse = false;
  unlinkSync(runningFlag);
  for (const turnActive of [true, false]) {
    active = turnActive;
    loaded = turnActive;
    owner = 'missing';
    const marked = calls.length;
    const pending = await send();
    assert.equal(pending.ok, true, JSON.stringify(pending));
    assert.equal(pending.value.queuedSubmissionId, 'synthetic-queue');
    assert.equal(pending.value.delivered, false);
    assert.equal(pending.value.receipt, undefined);
    assert(!calls.slice(marked).some(call => (call as { desktop?: string }).desktop));
    assert(!calls.slice(marked).some(call => ['turn/start', 'turn/steer'].includes((call as { server?: string }).server ?? '')));
    assert.equal(loaded, true, 'Saved idle thread must be loaded before enqueue');
    assert.equal(calls.slice(marked).filter(call => (call as { server?: string }).server === 'thread/resume').length, turnActive ? 0 : 1);
    active = false;
    const text = pendingText;
    const timestamp = new Date().toISOString();
    appendFileSync(rollout, [
      { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', id: 'writer-input', content: [{ type: 'input_text', text }] } },
      { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Writer received queued work.' }] } },
      { type: 'event_msg', timestamp, payload: { type: 'task_complete', last_agent_message: 'Writer received queued work.' } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');

    const receipt = { executionId: 'synthetic', inputId: 'writer-input' };
    const observed = await send(undefined, false, false, receipt);
    assert.equal(observed.value.inputEvidence.state, 'observed');
    assert(observed.value.inputEvidence.exchange.some((entry: { role: string; text: string }) => entry.role === 'user' && entry.text.includes('synthetic marker')));
    assert(observed.value.inputEvidence.exchange.some((entry: { role: string; text: string }) => entry.role === 'agent' && entry.text === 'Writer received queued work.'));
    assert.equal(calls.slice(marked).filter(call => (call as { server?: string }).server === 'thread/queue/add').length, 1);
    writeFileSync(rollout, '');
  }
  for (const step of ['thread/loaded/list', 'thread/resume', 'thread/settings/update']) {
    loaded = false; failedStep = step;
    const before = calls.length;
    const failure = await send();
    assert.equal(failure.ok, false);
    assert.equal(failure.reason, 'not_delivered');
    assert.equal(failure.notSent, true);
    assert(failure.detail.includes(step), JSON.stringify(failure));
    assert(!calls.slice(before).some(call => (call as { server?: string }).server === 'thread/queue/add'));
  }
  failedStep = ''; loaded = true;
  for (const { identical, reverse } of [false, true].flatMap(identical => [false, true].map(reverse => ({ identical, reverse })))) {
    collide = true; reverseCollision = reverse; collisionRequests.length = 0;
    const prefix = 'same prefix '.repeat(20), firstText = `${prefix} first`;
    const secondText = `${prefix} ${identical ? 'first' : 'second'}`;
    const results = await Promise.all([send(undefined, false, false, undefined, firstText), send(undefined, false, false, undefined, secondText)]);
    const first = results.find(result => result.value?.queuedSubmissionId === 'collision-0');
    const second = results.find(result => result.value?.queuedSubmissionId === 'collision-1');
    collisions.push({ identical, reverse, first, second });
    const receipt = { executionId: 'synthetic', inputId: collisionRequests[0].request.params.clientUserMessageId };
    assert.deepEqual(first.value, { delivered: true, queuedSubmissionId: 'collision-0', receipt });
    assert.deepEqual(second.value, { delivered: false, queuedSubmissionId: 'collision-1' }, 'The unconsumed submission must not borrow another input receipt');
    const observed = await send(undefined, false, false, receipt);
    assert.equal(observed.value.inputEvidence.state, 'observed');
    assert(observed.value.inputEvidence.exchange.some((entry: { role: string; text: string }) => entry.role === 'user' && entry.text === collisionRequests[0].request.params.input[0].text));
    assert(observed.value.inputEvidence.exchange.some((entry: { role: string; text: string }) => entry.role === 'agent' && entry.text === 'First concurrent reply only.'));
    writeFileSync(rollout, ''); collide = false;
  }
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nconst args=process.argv.slice(2);\nif(args[0]!=='queue'||!args[1]?.startsWith('--thread=')||!args[2]?.startsWith('--message='))process.exit(2);\nconst timestamp=new Date().toISOString();\nappendFileSync(${JSON.stringify(rollout)},JSON.stringify({type:'response_item',timestamp,payload:{type:'message',role:'user',id:'foreign-cli-input',content:[{type:'input_text',text:args[2].slice('--message='.length)}]}})+'\\n');\nawait Bun.write(Bun.stdout,'cli-accepted\\n');\n`, { mode: 0o700 });
  prepared = false;
  queueFault = 'unsupported';
  const cli = await send();
  assert.deepEqual(cli.value, { delivered: false, queuedSubmissionId: 'cli-accepted' }, 'CLI queue acceptance cannot borrow a concurrent transcript receipt');
  writeFileSync(rollout, '');
  for (const fault of ['refused', 'lost-reply']) {
    queueFault = fault;
    const before = calls.length;
    const result = await send();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_delivered');
    assert.equal(result.notSent, fault === 'refused' ? true : undefined, 'Only a definite refusal permits automatic retry');
    assert.equal(calls.slice(before).filter(call => (call as { server?: string }).server === 'thread/queue/add').length, 1);
  }
  queueFault = '';
  writeFileSync(runningFlag, 'running');
  owner = 'owned';
  assert.equal((await send('steer')).value.steeredIntoTurnId, 'desktop-active');
  refuse = true;
  const before = calls.length;
  assert.equal((await send('steer')).reason, 'not_delivered');
  assert(!calls.slice(before).some(call => (call as { server?: string }).server === 'thread/queue/add'));
  const opens = readFileSync(openLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(opens.length, 2, 'Only new-thread creation and the first ownerless automatic send open Desktop');
  console.log(`${action} PASS: ${run}/evidence/observed.json`);
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ action, replies, calls, logs, timings, collisions }, null, 2));
  ws?.close(); await app.cleanup(); unsubscribe();
  prepared = false;
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((done) => server.close(() => done()));
  await new Promise<void>((done) => http.close(() => done()));
  await new Promise<void>((done) => desktop.close(() => done()));
}
