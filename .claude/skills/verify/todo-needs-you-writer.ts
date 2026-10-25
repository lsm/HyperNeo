import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const [mode, directory] = process.argv.slice(2);
assert(['before', 'verify'].includes(mode));
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
let recording = false;
let lock: ReturnType<typeof spawn> | undefined;
let previous = performance.now(), maxLagMs = 0;
const timer = setInterval(() => { const now = performance.now(); if (recording) maxLagMs = Math.max(maxLagMs, now - previous - 10); previous = now; }, 10);
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
  const root = 'neo:10000000-0000-4000-8000-000000008789';
  const worker = '10000000-0000-4000-8000-000000008789';
  for (const id of [root, worker]) await app.db.createSession({ id, title: 'Synthetic needs-you', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const db = app.db.getDatabase();
  const prepare = db.prepare.bind(db);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const todos = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const id = 'needs-you-todo';
  todos.openAsk({ id: 'needs-you-ask', projectId: null, sessionId: root, originMessageId: null, title: 'Synthetic needs-you card', request: 'Ask the human once', createdAt: 1 });
  todos.addTodo(id, 'needs-you-ask', { title: 'Worker needs the human', doneWhen: 'Observed', check: null, instruction: null, named: null }, 1);
  prepare("UPDATE neo_todos SET state='doing', started_at=1 WHERE id=?").run(id);
  sessions.bind(id, { adapter: 'hyperneo', id: worker }, 1);
  prepare('UPDATE sessions SET status=? WHERE id=?').run('pending_worktree_choice', worker);
  const mainQueries: string[] = [];
  db.prepare = ((sql: string) => {
    if (recording && /UPDATE neo_todo_sessions\s+SET needs_you_since|SELECT needs_you_since AS since/i.test(sql)) mainQueries.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  const claimCalls: { roundTripMs: number; failed: boolean }[] = [];
  const call = app.db.gateway.call.bind(app.db.gateway);
  app.db.gateway.call = (async (op, method, ...args) => {
    if (op.name !== 'neo.todoSessionWrites' || method !== 'claimNeedsYou') return call(op, method, ...args);
    const start = performance.now();
    try { const result = await call(op, method, ...args); claimCalls.push({ roundTripMs: performance.now() - start, failed: false }); return result; }
    catch (error) { claimCalls.push({ roundTripMs: performance.now() - start, failed: true }); throw error; }
  }) as typeof app.db.gateway.call;
  const notes = () => (prepare("SELECT count(*) AS n FROM job_queue WHERE queue='neo_notes' AND json_extract(payload,'$.messageUuid') LIKE ?").get(`neo-todo:${id}:%`) as { n: number }).n;
  const refresh = async () => {
    prepare("UPDATE job_queue SET run_at=0 WHERE queue='neo.work.driver.refresh' AND status='pending'").run();
    const job = prepare("SELECT id FROM job_queue WHERE queue='neo.work.driver.refresh' AND status='pending' LIMIT 1").get() as { id: string } | null;
    assert(job, 'scheduled refresh exists');
    const start = performance.now();
    recording = true;
    await app.jobProcessor.tick();
    const healthStart = performance.now();
    await rpc('system.health', {});
    const healthMs = performance.now() - healthStart;
    const deadline = Date.now() + 15000;
    while (true) {
      const row = prepare('SELECT status,error FROM job_queue WHERE id=?').get(job.id) as { status: string; error: string | null };
      if (row.status === 'completed') break;
      assert(!['failed', 'dead'].includes(row.status), row.error ?? row.status);
      assert(Date.now() < deadline, 'scheduled refresh completed');
      await new Promise((done) => setTimeout(done, 10));
    }
    recording = false;
    return { jobMs: performance.now() - start, healthMs };
  };
  db.exec("CREATE TRIGGER reject_incident BEFORE UPDATE OF needs_you_since ON neo_todo_sessions BEGIN SELECT RAISE(ABORT, 'synthetic incident refusal'); END");
  report.refused = await refresh();
  report.afterRefusal = { needsYouSince: sessions.readNeedsYouSince(id), notes: notes() };
  assert.deepEqual(report.afterRefusal, { needsYouSince: null, notes: 0 }, 'no notification before a successful claim');
  db.exec('DROP TRIGGER reject_incident');
  mainQueries.length = 0;
  report.success = await refresh();
  report.afterSuccess = { needsYouSince: sessions.readNeedsYouSince(id), notes: notes() };
  assert.equal(notes(), 1);
  assert.notEqual(sessions.readNeedsYouSince(id), null);
  report.repeated = await refresh();
  assert.equal(notes(), 1, 'one note per incident');
  report.mainQueries = [...mainQueries];
  report.snapshot = await rpc('operation.invoke', { name: 'neo.snapshot', input: {} });
  const shown = (report.snapshot as { todoAsks: { todos: { id: string; state: string }[] }[] }).todoAsks.flatMap((entry) => entry.todos).find((todo) => todo.id === id);
  assert(shown && ['doing', 'blocked'].includes(shown.state), 'the real snapshot keeps the followed card');
  if (mode === 'before') assert(mainQueries.length > 0, 'baseline incident SQL remains on main');
  else assert.equal(mainQueries.length, 0, 'incident admission leaves main');
  sessions.recordNeedsYouSince(id, null);
  prepare("UPDATE neo_todos SET state='doing', blocked_by=NULL WHERE id=?").run(id);
  if (mode === 'verify') {
    const claims = await Promise.all([sessions.write('claimNeedsYou', id, 10), sessions.write('claimNeedsYou', id, 11)]);
    report.concurrentWinners = claims.filter(Boolean).length;
    assert.equal(report.concurrentWinners, 1, 'one writer claim can notify');
    sessions.recordNeedsYouSince(id, null);
  }
  maxLagMs = 0;
  lock = spawn('/usr/bin/python3', ['-c', "import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()", join(run, 'data/daemon.db')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const released = new Promise<void>((done, fail) => { lock!.once('error', fail); lock!.once('exit', (code) => code === 0 ? done() : fail(new Error('synthetic lock holder failed'))); });
  await new Promise<void>((done) => lock!.stdout!.once('data', (data) => { assert(String(data).includes('locked')); done(); }));
  const start = performance.now();
  recording = true;
  const write = mode === 'before' ? Promise.resolve().then(() => {
    const since = sessions.readNeedsYouSince(id);
    const todo = todos.getTodo(id);
    if (since !== null || !todo || !(todo.state === 'doing' || (todo.state === 'blocked' && todo.blockedBy === 'worker'))) return null;
    sessions.recordNeedsYouSince(id, 12);
    return todo;
  }) : sessions.write('claimNeedsYou', id, 12);
  const healthStart = performance.now();
  await rpc('system.health', {});
  const healthMs = performance.now() - healthStart;
  assert.equal((await write)?.id, id);
  const writeMs = performance.now() - start;
  await released;
  lock = undefined;
  await new Promise((done) => setTimeout(done, 20));
  recording = false;
  report.contention = { writeMs, healthMs, maxLagMs, affectedWriteUnder250ms: writeMs < 250 };
  assert(writeMs > 1000, 'the affected write still waits for the held lock');
  assert.equal(sessions.readNeedsYouSince(id), 12);
  if (mode === 'before') assert(healthMs > 1000, 'baseline main SQL blocks health');
  else { assert(healthMs < 250, 'worker wait leaves health responsive'); assert(maxLagMs < 1000); }
  report.claimCalls = claimCalls;
  report.verified = true;
  console.log(JSON.stringify(report));
} finally {
  clearInterval(timer);
  lock?.kill();
  socket.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/todo-needs-you-writer.json'), JSON.stringify(report, null, 2));
}
