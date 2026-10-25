import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';

const [mode, directory] = process.argv.slice(2);
assert(['before', 'verify', 'reproduce-race'].includes(mode));
const run = resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'workspace'), { recursive: true });
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const report: Record<string, unknown> = { mode, port: app.server.port };
const socket = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
const connected = new Promise<void>((done, fail) => { socket.onopen = () => done(); socket.onerror = () => fail(new Error('RPC connect failed')); });
let lock: ReturnType<typeof spawn> | undefined;
let measure = false;
let previous = performance.now();
let maxLagMs = 0;
const timer = setInterval(() => { const now = performance.now(); if (measure) maxLagMs = Math.max(maxLagMs, now - previous - 10); previous = now; }, 10);
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
  const root = 'neo:10000000-0000-4000-8000-000000008724';
  const worker = '10000000-0000-4000-8000-000000008724';
  for (const id of [root, worker]) await app.db.createSession({ id, title: 'Synthetic todo gateway', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const db = app.db.getDatabase();
  const prepare = db.prepare.bind(db);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const todos = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  todos.openAsk({ id: 'gateway-ask', projectId: null, sessionId: root, originMessageId: null, title: 'Synthetic gateway card', request: 'Observe committed worker status', createdAt: 1 });
  todos.addTodo('gateway-todo', 'gateway-ask', { title: 'Observe synthetic worker', doneWhen: 'Observed', check: null, instruction: null, named: null }, 1);
  prepare("UPDATE neo_todos SET state='doing', started_at=1 WHERE id='gateway-todo'").run();
  sessions.bind('gateway-todo', { adapter: 'hyperneo', id: worker }, 1);
  if (mode !== 'before') {
    todos.addTodo('gateway-late', 'gateway-ask', { title: 'Late recorded worker', doneWhen: 'Observed', check: null, instruction: null, named: null }, 1);
    prepare("UPDATE neo_todos SET state='doing', started_at=1 WHERE id='gateway-late'").run();
    prepare('INSERT INTO neo_todo_sessions(todo_id,target) VALUES (?,?)').run('gateway-late', '{}');
    const call = app.db.gateway.call.bind(app.db.gateway);
    app.db.gateway.call = (async (op, method, ...args) => {
      const result = await call(op, method, ...args);
      if (op.name === 'neo.todoSessionReads' && method === 'unrecordedStarts')
        sessions.recordRef('gateway-late', { adapter: 'hyperneo', id: worker }, 1);
      return result;
    }) as typeof app.db.gateway.call;
  }
  const mainQueries: string[] = [];
  db.prepare = ((sql: string) => {
    if (/SELECT s.todo_id AS todoId(?:, s.ref)? FROM neo_todo_sessions|UPDATE neo_todo_sessions\s+SET live_status|MIN\(next.started_at/i.test(sql)) mainQueries.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  prepare("UPDATE job_queue SET run_at=0 WHERE queue='neo.work.driver.refresh' AND status='pending'").run();
  const job = prepare("SELECT id FROM job_queue WHERE queue='neo.work.driver.refresh' AND status='pending' LIMIT 1").get() as { id: string };
  assert(job);
  await app.jobProcessor.tick();
  const until = Date.now() + 15000;
  let finished = false;
  while (Date.now() < until) {
    const row = prepare('SELECT status, error FROM job_queue WHERE id=?').get(job.id) as { status: string; error: string | null };
    if (row.status === 'completed') { finished = true; break; }
    assert(!['failed', 'dead'].includes(row.status), row.error ?? row.status);
    await new Promise((done) => setTimeout(done, 25));
  }
  assert(finished, 'real scheduled Neo refresh completed');
  const live = sessions.readLiveStatus('gateway-todo');
  assert(live, 'real worker status was recorded');
  report.liveStatus = live;
  const prs = new CodingTodoPrRepository(db);
  report.window = mode === 'before' ? prs.window('gateway-todo') : await prs.readWindow('gateway-todo');
  report.mainQueries = mainQueries;
  report.snapshot = await rpc('operation.invoke', { name: 'neo.snapshot', input: {} });
  assert(JSON.stringify(report.snapshot).includes('Observe synthetic worker'), 'Neo snapshot returns the seeded work card');
  if (mode !== 'before') {
    report.lateRecordedTodo = todos.getTodo('gateway-late');
    const snapshot = report.snapshot as { todoAsks: { todos: { id: string; state: string }[] }[] };
    const shown = snapshot.todoAsks.flatMap((entry) => entry.todos).find((todo) => todo.id === 'gateway-late');
    assert.equal(shown?.state, mode === 'reproduce-race' ? 'failed' : 'doing');
    if (mode === 'reproduce-race') assert.equal(todos.getTodo('gateway-late')?.state, 'failed', 'baseline falsely fails a newly bound todo');
    else {
      assert.equal(todos.getTodo('gateway-late')?.state, 'doing');
      assert.equal(todos.getTodo('gateway-late')?.reason, null);
    }
  }
  if (mode === 'reproduce-race') report.raceReproduced = true;
  else if (mode === 'before') assert(mainQueries.length > 0, 'baseline reproduces main-thread SQL');
  else {
    assert.equal(mainQueries.length, 0, 'target recovery reads and live write must leave main');
    lock = spawn('/usr/bin/python3', ['-c', "import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()", join(run, 'data/daemon.db')], { stdio: ['ignore', 'pipe', 'pipe'] });
    const released = new Promise<void>((done, fail) => { lock!.once('error', fail); lock!.once('exit', (code) => code === 0 ? done() : fail(new Error('synthetic writer failed'))); });
    await new Promise<void>((done) => lock!.stdout!.once('data', (data) => { assert(String(data).includes('locked')); done(); }));
    maxLagMs = 0; previous = performance.now(); measure = true;
    const start = performance.now();
    const updated = live === 'running' ? 'done' : 'running';
    const write = sessions.write('recordLive', 'gateway-todo', updated, undefined);
    const healthStart = performance.now();
    report.health = await rpc('system.health', {});
    const healthMs = performance.now() - healthStart;
    assert(await write);
    const writeMs = performance.now() - start;
    await released;
    lock = undefined;
    measure = false;
    report.contention = { healthMs, writeMs, maxLagMs, affectedWriteUnder250ms: writeMs < 250 };
    assert(writeMs > 1000, 'separate worker waits for lock');
    assert(healthMs < 250, 'health stays responsive');
    assert(maxLagMs < 1000, 'main event loop stays responsive');
    assert.equal(sessions.readLiveStatus('gateway-todo'), updated);
  }
  report.verified = true;
  console.log(JSON.stringify({ mode, live, mainQueries: mainQueries.length, contention: report.contention }));
} finally {
  clearInterval(timer); lock?.kill(); socket.close(); await app.cleanup();
  writeFileSync(join(run, 'evidence/todo-session-gateway.json'), JSON.stringify(report, null, 2));
}
