import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { syntheticCodexDesktop } from './codex-desktop-peer.ts';

const [mode, directory] = process.argv.slice(2);
assert(['before', 'verify'].includes(mode));
const run = resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const dir of ['home/.codex/app-server-control', 'workspace', 'evidence', 'bin'])
  mkdirSync(join(run, dir), { recursive: true });
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const codex = join(run, 'home/.codex');
const rollout = join(codex, 'synthetic.jsonl');
writeFileSync(rollout, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Earlier synthetic task.' } })}\n`);
const state = new Database(join(codex, 'state_5.sqlite'));
state.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, updated_at_ms INTEGER); CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT)');
state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT, git_branch TEXT)');
state.prepare("INSERT INTO threads VALUES ('synthetic-thread','Synthetic worker','','',?,'vscode',0,1,?,NULL)").run(join(run, 'workspace'), rollout);
state.close();
let recording = false;
let effects = 0;
const closeDesktop = await syntheticCodexDesktop(run, {
  start: () => { effects++; recording = true; return `synthetic-turn-${effects}`; },
});
const peer = Bun.serve({
  unix: join(codex, 'app-server-control/app-server-control.sock'),
  fetch(request, server) { return server.upgrade(request) ? undefined : new Response('websocket only', { status: 400 }); },
  websocket: {
    message(socket, data) {
      const message = JSON.parse(String(data));
      if (!('id' in message)) return;
      assert.notEqual(message.method, 'turn/start', 'Desktop owns the synthetic turn');
      const result = message.method === 'thread/turns/list' ? { data: [] }
        : message.method === 'turn/start' ? { turn: { id: `synthetic-turn-${effects}` } } : {};
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    },
  },
});
const evidence: Record<string, unknown> = { mode };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let socket: WebSocket | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  assert.notEqual(app.server.port, 8399);
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  socket = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { socket!.onopen = () => done(); socket!.onerror = () => fail(new Error('RPC connection failed')); });
  const health = () => new Promise<number>((done, fail) => {
    const start = performance.now();
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => fail(new Error('Health timed out')), 10000);
    socket!.onmessage = (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timeout);
      if (reply.error) fail(new Error(JSON.stringify(reply.error)));
      else done(performance.now() - start);
    };
    socket!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'system.health', data: {}, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const dispatchCalls: unknown[] = [];
  const call = app.db.gateway.call.bind(app.db.gateway);
  app.db.gateway.call = (async (op, method, ...args) => {
    if (op.name !== 'neo.todoSessionWrites' || method !== 'recordDispatch') return call(op, method, ...args);
    const start = performance.now();
    const healthy = health();
    try {
      const result = await call(op, method, ...args);
      const roundTripMs = performance.now() - start;
      dispatchCalls.push({ roundTripMs, argsBytes: Buffer.byteLength(JSON.stringify(args)), resultBytes: Buffer.byteLength(JSON.stringify(result)), healthMs: await healthy });
      return result;
    } catch (error) {
      dispatchCalls.push({ failed: true, roundTripMs: performance.now() - start, healthMs: await healthy });
      throw error;
    }
  }) as typeof app.db.gateway.call;
  evidence.dispatchCalls = dispatchCalls;
  let previous = performance.now(), maxLagMs = 0;
  timer = setInterval(() => { const now = performance.now(); if (recording) maxLagMs = Math.max(maxLagMs, now - previous - 10); previous = now; }, 10);
  evidence.rssBefore = process.memoryUsage().rss;
  const root = 'neo:10000000-0000-4000-8000-000000008712';
  await app.db.createSession({ id: root, title: 'Synthetic dispatch', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const db = app.db.getDatabase();
  const prepare = db.prepare.bind(db);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  new NeoAskTodoRepository(db).openAsk({ id: 'dispatch-ask', projectId: null, sessionId: root, originMessageId: null, title: 'Synthetic receipts', request: 'Retain committed dispatch evidence', createdAt: 1 });
  const sessions = new NeoTodoSessionRepository(db);
  const queries: string[] = [];
  db.prepare = ((sql: string) => {
    if (recording && /UPDATE neo_todo_sessions\s+SET (?:ref|input_before)|SELECT target, ref, actual_model/i.test(sql)) queries.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  const handler = createOperationMcpHandler(() => app!.sessionManager.getOperationRegistry(), () => ({ sessionId: root, role: 'neo' }));
  const add = async (title: string) => {
    const reply = await handler({ name: 'neo.todo.add', input: { askId: 'dispatch-ask', title, doneWhen: 'Facts retained', instruction: 'Only a synthetic opening instruction', target: { verb: 'send', ref: { adapter: 'codex-desktop', id: 'synthetic-thread' } }, start: true } });
    recording = false;
    assert.equal(reply.content[0].type, 'text');
    return JSON.parse(reply.content[0].text);
  };
  const start = performance.now();
  const success = await add('Successful dispatch');
  evidence.success = success;
  evidence.rpcMs = performance.now() - start;
  assert.equal(success.ok, true, JSON.stringify(success));
  assert.equal(success.todo.state, 'doing');
  assert.deepEqual(sessions.readSent(success.todo.id)?.delivery, { delivered: true, startedTurnId: 'synthetic-turn-1' });
  evidence.mainQueries = [...queries];
  if (mode === 'before') assert(queries.length > 0);
  else assert.equal(queries.length, 0, 'dispatch assignment/receipt persistence leaves main');
  const warmMs: number[] = [];
  for (let n = 0; n < 3; n++) {
    const start = performance.now();
    assert.equal((await add(`Warm dispatch ${n}`)).ok, true);
    warmMs.push(performance.now() - start);
  }
  evidence.warmRpcMs = warmMs;
  db.exec("CREATE TRIGGER reject_receipt BEFORE UPDATE OF sent_opening ON neo_todo_sessions BEGIN SELECT RAISE(ABORT, 'synthetic receipt refusal'); END");
  const failed = await add('Refused receipt');
  evidence.failure = failed;
  assert.match(failed.message, /synthetic receipt refusal/);
  const id = (prepare("SELECT id FROM neo_todos WHERE title='Refused receipt'").get() as { id: string }).id;
  evidence.failedRef = sessions.readRef(id);
  evidence.failedSent = sessions.readSent(id);
  evidence.externalEffects = effects;
  assert.equal(effects, 5, 'each external effect ran once without replay');
  assert.equal(sessions.inputs.list(id).length, 1);
  assert.deepEqual(sessions.inputs.list(id)[0].outcome?.delivery, { delivered: true, startedTurnId: 'synthetic-turn-5' });
  if (mode === 'before') assert(evidence.failedRef, 'baseline partially records the worker before receipt refusal');
  else assert.equal(evidence.failedRef, null, 'receipt refusal rolls back the worker assignment');
  assert.equal(evidence.failedSent, null);
  evidence.maxLagMs = maxLagMs;
  evidence.rssAfter = process.memoryUsage().rss;
  evidence.walBytes = statSync(join(run, 'data/daemon.db-wal')).size;
  evidence.affectedRpcUnder250ms = Number(evidence.rpcMs) < 250 && warmMs.every((ms) => ms < 250);
  assert(maxLagMs < 1000);
  evidence.verified = true;
  console.log(JSON.stringify({ mode, mainQueries: queries.length, rpcMs: evidence.rpcMs, warmMs, dispatchCalls, maxLagMs, affectedRpcUnder250ms: evidence.affectedRpcUnder250ms, failedRef: evidence.failedRef, externalEffects: effects }));
} finally {
  clearInterval(timer);
  socket?.close();
  await app?.cleanup();
  peer.stop(true);
  await closeDesktop();
  writeFileSync(join(run, 'evidence/todo-dispatch-writer.json'), JSON.stringify(evidence, null, 2));
}
