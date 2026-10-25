import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
assert(!existsSync(join(run, 'data/daemon.db')));
for (const dir of ['evidence', 'workspace', 'bin']) mkdirSync(join(run, dir), { recursive: true });
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const report: Record<string, unknown> = { mode, port: app.server.port };
const socket = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
const connected = new Promise<void>((done, fail) => { socket.onopen = () => done(); socket.onerror = () => fail(new Error('RPC connect failed')); });
let recording = false;
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
  const root = 'neo:10000000-0000-4000-8000-000000008712';
  const worker = '10000000-0000-4000-8000-000000008712';
  for (const id of [root, worker]) await app.db.createSession({ id, title: 'Synthetic progress', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const db = app.db.getDatabase();
  const prepare = db.prepare.bind(db);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const todos = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  todos.openAsk({ id: 'progress-ask', projectId: null, sessionId: root, originMessageId: null, title: 'Synthetic progress card', request: 'Observe one committed status', createdAt: 1 });
  todos.addTodo('progress-todo', 'progress-ask', { title: 'Atomic worker progress', doneWhen: 'Observed', check: null, instruction: null, named: null }, 1);
  prepare("UPDATE neo_todos SET state='doing', started_at=1 WHERE id='progress-todo'").run();
  sessions.bind('progress-todo', { adapter: 'hyperneo', id: worker }, 1);
  sessions.recordLive('progress-todo', 'needs_you', undefined);
  sessions.recordNeedsYouSince('progress-todo', 900);
  const mainQueries: string[] = [];
  db.prepare = ((sql: string) => {
    if (recording && /UPDATE neo_todo_sessions\s+SET (?:started_at|checked_at|needs_you_since)|SELECT needs_you_since AS since/i.test(sql)) mainQueries.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  const progressCalls: { roundTripMs: number; failed: boolean }[] = [];
  const call = app.db.gateway.call.bind(app.db.gateway);
  app.db.gateway.call = (async (op, method, ...args) => {
    if (op.name !== 'neo.todoSessionWrites' || method !== 'recordProgress') return call(op, method, ...args);
    const start = performance.now();
    try { const result = await call(op, method, ...args); progressCalls.push({ roundTripMs: performance.now() - start, failed: false }); return result; }
    catch (error) { progressCalls.push({ roundTripMs: performance.now() - start, failed: true }); throw error; }
  }) as typeof app.db.gateway.call;
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
  db.exec("CREATE TRIGGER reject_progress_check BEFORE UPDATE OF checked_at ON neo_todo_sessions BEGIN SELECT RAISE(ABORT, 'synthetic check refusal'); END");
  report.refused = await refresh();
  report.afterRefusal = { live: sessions.readLiveStatus('progress-todo'), needsYouSince: sessions.readNeedsYouSince('progress-todo'), check: sessions.readCardCheck('progress-todo') };
  report.refusedSnapshot = await rpc('operation.invoke', { name: 'neo.snapshot', input: {} });
  assert.equal((report.afterRefusal as { live: string }).live, mode === 'before' ? 'running' : 'needs_you');
  assert.equal((report.afterRefusal as { needsYouSince: number | null }).needsYouSince, mode === 'before' ? null : 900);
  assert.equal((report.afterRefusal as { check: unknown }).check, null);
  db.exec('DROP TRIGGER reject_progress_check');
  prepare("UPDATE neo_todos SET state='doing', blocked_by=NULL, blocked_reason=NULL, next_action=NULL WHERE id='progress-todo'").run();
  mainQueries.length = 0;
  report.success = await refresh();
  report.mainQueries = [...mainQueries];
  report.afterSuccess = { live: sessions.readLiveStatus('progress-todo'), needsYouSince: sessions.readNeedsYouSince('progress-todo'), check: sessions.readCardCheck('progress-todo') };
  assert.equal((report.afterSuccess as { live: string }).live, 'running');
  assert.equal((report.afterSuccess as { needsYouSince: unknown }).needsYouSince, null);
  assert.equal((report.afterSuccess as { check: { unchecked: boolean } }).check.unchecked, false);
  const snapshot = await rpc('operation.invoke', { name: 'neo.snapshot', input: {} }) as { todoAsks: { todos: { id: string; state: string }[] }[] };
  const shown = snapshot.todoAsks.flatMap((entry) => entry.todos).find((todo) => todo.id === 'progress-todo');
  assert.equal(shown?.state, 'doing');
  report.successSnapshot = snapshot;
  if (mode === 'before') assert(mainQueries.length > 0, 'baseline progress SQL remains on main');
  else assert.equal(mainQueries.length, 0, 'progress writes and reset lookup leave main');
  report.progressCalls = progressCalls;
  report.maxLagMs = maxLagMs;
  assert(maxLagMs < 1000);
  report.verified = true;
  console.log(JSON.stringify({ mode, afterRefusal: report.afterRefusal, mainQueries: mainQueries.length, refused: report.refused, success: report.success, progressCalls, maxLagMs }));
} finally {
  clearInterval(timer);
  socket.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/todo-progress-writer.json'), JSON.stringify(report, null, 2));
}
