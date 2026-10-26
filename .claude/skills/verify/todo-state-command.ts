import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const [mode, directory] = process.argv.slice(2);
assert(['before', 'verify', 'missing-before'].includes(mode));
const run = resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const dir of ['evidence', 'workspace', 'bin']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const report: Record<string, unknown> = { mode, port: app.server.port };
const socket = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
const connected = new Promise<void>((done, fail) => { socket.onopen = () => done(); socket.onerror = () => fail(new Error('RPC connect failed')); });
let recording = false, measureLag = false;
let lock: ReturnType<typeof spawn> | undefined;
let previous = performance.now(), maxLagMs = 0;
const timer = setInterval(() => { const now = performance.now(); if (measureLag) maxLagMs = Math.max(maxLagMs, now - previous - 10); previous = now; }, 10);
try {
  assert.notEqual(app.server.port, 8399);
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await connected;
  const rpc = (method: string, data: unknown) => new Promise<unknown>((done, fail) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => fail(new Error(`${method} timed out`)), 10000);
    socket.onmessage = (event) => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timeout); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    socket.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const root = 'neo:10000000-0000-4000-8000-000000008821';
  await app.db.createSession({ id: root, title: 'Synthetic state commit', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const db = app.db.getDatabase();
  const prepare = db.prepare.bind(db);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const todos = new NeoAskTodoRepository(db);
  const id = 'first', reportText = 'Complete state command report 🦊\n'.repeat(20_000);
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  todos.openAsk({ id: 'state-ask', projectId: null, sessionId: root, originMessageId: null, title: 'Atomic ordered state', request: 'Commit without dispatch', createdAt: 1 });
  for (const todoId of [id, 'next']) todos.addTodo(todoId, 'state-ask', { title: todoId, doneWhen: 'Observed', check: null, instruction: 'Continue synthetic work', named: null }, 1);
  prepare("UPDATE neo_todos SET state='doing', started_at=2, report=? WHERE id=?").run(reportText, id);
  todos.askQuestion('stale-start', 'state-ask', { text: 'Start first?', kind: 'start', options: null, multiple: false, noLabel: null, yesLabel: null, startTodos: [id] }, 3);
  const mainQueries: string[] = [];
  db.prepare = ((sql: string) => {
    if (recording && /neo_todos|neo_asks|neo_questions|neo_todo_sessions/.test(sql)) mainQueries.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  const calls: { roundTripMs: number; failed: boolean }[] = [];
  const apply = async (now: number) => {
    const started = performance.now();
    recording = true;
    try {
      let startNext: string | null = null;
      const result = mode === 'before' ? { todo: await todos.recompute(todos.getTodo(id)!, {}, now, { state: 'done', evidence: 'Complete' }, async (next) => { startNext = next; }), startNext } : await todos.write('commitState', id, {}, now, { state: 'done', evidence: 'Complete' });
      calls.push({ roundTripMs: performance.now() - started, failed: false });
      return result;
    } catch (error) { calls.push({ roundTripMs: performance.now() - started, failed: true }); throw error; }
    finally { recording = false; }
  };
  const snapshot = () => rpc('operation.invoke', { name: 'neo.snapshot', input: {} });
  const card = (value: unknown) => (value as { todoAsks: { ask: { id: string }; doneCount: number; todos: { id: string; state: string }[] }[] }).todoAsks.find((entry) => entry.ask.id === 'state-ask');
  report.beforeSnapshot = await snapshot();
  db.exec("CREATE TRIGGER refuse_ask_stamp BEFORE UPDATE OF updated_at ON neo_asks BEGIN SELECT RAISE(ABORT, 'synthetic ask stamp refusal'); END");
  await assert.rejects(apply(10), /synthetic ask stamp refusal/);
  report.afterRefusal = { todoState: todos.getTodo(id)!.state, questionState: todos.getQuestion('stale-start')!.state, askUpdatedAt: todos.getAsk('state-ask')!.updatedAt };
  assert.equal((report.afterRefusal as { todoState: string }).todoState, mode === 'before' ? 'done' : 'doing');
  assert.equal((report.afterRefusal as { questionState: string }).questionState, mode === 'before' ? 'retired' : 'open');
  report.refusedSnapshot = await snapshot();
  assert.equal(card(report.refusedSnapshot)?.doneCount, mode === 'before' ? 1 : 0);
  db.exec('DROP TRIGGER refuse_ask_stamp');
  prepare("UPDATE neo_todos SET state='doing', evidence=NULL, finished_at=NULL WHERE id=?").run(id);
  prepare("UPDATE neo_questions SET state='open', retired_reason=NULL, start_todos=? WHERE id=?").run(JSON.stringify([id]), 'stale-start');
  const rssBefore = process.memoryUsage().rss;
  const walBefore = statSync(join(run, 'data/daemon.db-wal'), { throwIfNoEntry: false })?.size ?? 0;
  mainQueries.length = 0;
  const committed = await apply(11);
  report.mainQueries = [...mainQueries];
  assert(committed.todo, 'an existing todo returns its committed state');
  assert.equal(committed.todo.state, 'done');
  assert.equal(committed.startNext, 'next');
  assert.equal(todos.getTodo('next')!.state, 'todo', 'the build command does not dispatch');
  assert.equal(todos.getQuestion('stale-start')!.state, 'retired');
  assert.equal(hash(committed.todo.report!), hash(reportText));
  report.result = { state: committed.todo.state, startNext: committed.startNext, reportBytes: Buffer.byteLength(committed.todo.report!), reportHash: hash(committed.todo.report!), replyBytes: Buffer.byteLength(JSON.stringify(committed)), rssDeltaBytes: process.memoryUsage().rss - rssBefore, walGrowthBytes: (statSync(join(run, 'data/daemon.db-wal'), { throwIfNoEntry: false })?.size ?? 0) - walBefore };
  report.committedSnapshot = await snapshot();
  assert.equal(card(report.committedSnapshot)?.doneCount, 1);
  assert.equal(card(report.committedSnapshot)?.todos.find((todo) => todo.id === 'next')?.state, 'todo');
  if (mode === 'before') assert(mainQueries.length > 0);
  else assert.equal(mainQueries.length, 0, 'only the newly built command leaves main here');
  if (mode !== 'before') {
    const missingCases = [];
    for (const gone of ['unknown-state-id', 'deleted-state-id']) {
      if (gone === 'deleted-state-id') {
        todos.addTodo(gone, 'state-ask', { title: 'Deleted before admission', doneWhen: 'Observed', instruction: null, check: null, named: null }, 11);
        prepare('DELETE FROM neo_todos WHERE id=?').run(gone);
      }
      const beforeMissing = { todos: todos.listTodos('state-ask'), questions: todos.listQuestions('state-ask'), ask: todos.getAsk('state-ask') };
      let result: unknown = null, error: string | null = null;
      try { result = await todos.write('commitState', gone, {}, 20, { state: 'done', evidence: 'Late completion' }); }
      catch (caught) { error = String(caught); }
      missingCases.push({ kind: gone, result, error });
      if (mode === 'missing-before') assert(error?.includes('askId'), 'baseline missing IDs reject with the opaque dereference error');
      else { assert.equal(error, null); assert.deepEqual(result, { todo: null, startNext: null }); }
      assert.deepEqual({ todos: todos.listTodos('state-ask'), questions: todos.listQuestions('state-ask'), ask: todos.getAsk('state-ask') }, beforeMissing);
    }
    report.missingCases = missingCases;
    report.missingSnapshot = await snapshot();
    assert.equal(card(report.missingSnapshot)?.doneCount, 1);
    assert.equal(card(report.missingSnapshot)?.todos.find((todo) => todo.id === 'next')?.state, 'todo');
  }
  prepare("UPDATE neo_todos SET state='doing' WHERE id=?").run(id);
  maxLagMs = 0;
  lock = spawn('/usr/bin/python3', ['-c', "import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()", join(run, 'data/daemon.db')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const released = new Promise<void>((done, fail) => { lock!.once('error', fail); lock!.once('exit', (code) => code === 0 ? done() : fail(new Error('synthetic lock holder failed'))); });
  await new Promise<void>((done) => lock!.stdout!.once('data', (data) => { assert(String(data).includes('locked')); done(); }));
  const start = performance.now();
  measureLag = true;
  const write = Promise.resolve().then(() => apply(12));
  const healthStart = performance.now();
  await rpc('system.health', {});
  const healthMs = performance.now() - healthStart;
  assert.equal((await write).todo?.id, id);
  const writeMs = performance.now() - start;
  await released;
  lock = undefined;
  await new Promise((done) => setTimeout(done, 20));
  measureLag = false;
  report.contention = { writeMs, healthMs, maxLagMs, affectedWriteUnder250ms: writeMs < 250 };
  assert(writeMs > 1000, 'the affected write still waits for the held lock');
  assert.equal(todos.getTodo(id)!.state, 'done');
  if (mode === 'before') assert(healthMs > 1000, 'baseline main SQL blocks health');
  else { assert(healthMs < 250, 'worker wait leaves health responsive'); assert(maxLagMs < 1000); }
  report.calls = calls;
  report.runtimeCallersMoved = false;
  report.verified = true;
  console.log(JSON.stringify(report));
} finally {
  clearInterval(timer);
  lock?.kill();
  socket.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/todo-state-command.json'), JSON.stringify(report, null, 2));
}
