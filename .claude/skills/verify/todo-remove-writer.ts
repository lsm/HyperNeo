import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { NeoTodo } from '../../../packages/shared/src/types/neo-ask.ts';
import type { NeoSnapshot } from '../../../packages/shared/src/types/neo-snapshot.ts';

const [mode, directory] = process.argv.slice(2);
assert(['before', 'verify'].includes(mode));
const run = resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const path of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, path), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP is disabled'); }) as typeof fetch;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
assert.notEqual(app.server.port, 8399);
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws` });
hub.registerTransport(transport);
const observer = new MessageHub({ defaultSessionId: 'global' });
const observerTransport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws` });
observer.registerTransport(observerTransport);
let observing = false, notifications = 0, internalNotifications = 0;
let refreshed: Promise<NeoSnapshot> | undefined;
let receivedChange: (() => void) | undefined;
const observedChange = new Promise<void>(done => { receivedChange = done; });
const stopObserving = observer.onEvent('neo.changed', () => {
  if (!observing) return;
  notifications++;
  refreshed = observer.request<NeoSnapshot>('operation.invoke', { name: 'neo.snapshot', input: {} });
  receivedChange?.();
});
const stopInternal = app.internalEventBus.subscribe('neo.changed', () => { if (observing) internalNotifications++; }, { subscriberName: 'verify.remove.changed' });
const db = app.db.getDatabase(), prepare = db.prepare.bind(db), todos = new NeoAskTodoRepository(db);
let recording = 0, mainSql = 0, measureLag = false, maxLagMs = 0, previous = performance.now();
let lock: ReturnType<typeof spawn> | undefined;
let lockExit: Promise<void> | undefined;
const timer = setInterval(() => { const now = performance.now(); if (measureLag) maxLagMs = Math.max(maxLagMs, now - previous - 10); previous = now; }, 10);
db.prepare = ((sql: string) => { if (recording && /neo_todos|neo_asks|neo_questions|neo_todo_sessions/.test(sql)) mainSql++; return prepare(sql); }) as typeof db.prepare;
const report: Record<string, unknown> = { mode, surface: 'real remove RPC and neo.snapshot' };
type Receipt = { ok: false; reason: string } | { ok: true; todo: NeoTodo; todos: NeoTodo[] };
const finish = async (kind: 'close' | 'remove', todoId: string) => {
  recording++;
  try { return await hub.request<Receipt>('operation.invoke', { name: `neo.todo.${kind}`, input: { todoId, reason: 'Synthetic decision' } }); }
  finally { recording--; }
};
const visible = async (id: string) => (await hub.request<NeoSnapshot>('operation.invoke', { name: 'neo.snapshot', input: {} })).todoAsks.flatMap(entry => entry.todos).find(todo => todo.id === id)!;
const root = 'neo:10000000-0000-4000-8000-000000008950';
const add = (id: string) => {
  todos.openAsk({ id, projectId: null, sessionId: root, originMessageId: null, title: id, request: 'Atomic finalization', createdAt: 1 });
  const todo = todos.addTodo(id, id, { title: id, doneWhen: 'Observed outcome', check: null, instruction: 'Synthetic work', named: null }, 1);
  todos.updateTodo(todo, { state: 'doing', startedAt: 2 }, 2);
  todos.askQuestion(`${id}-start`, id, { text: 'Start?', kind: 'start', options: null, multiple: false, yesLabel: null, noLabel: null, startTodos: [id] }, 3);
};
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await transport.connect();
  await observerTransport.connect();
  await app.db.createSession({ id: root, title: 'Synthetic finalization', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  for (const kind of ['remove'] as const) add(kind);
  db.exec("CREATE TRIGGER refuse_finalize_stamp BEFORE UPDATE OF updated_at ON neo_asks BEGIN SELECT RAISE(ABORT, 'synthetic finalization refusal'); END");
  await observer.request('system.health', {});
  observing = true;
  const refused = [];
  for (const kind of ['remove'] as const) {
    let error: string | null = null;
    try { await finish(kind, kind); } catch (failure) { error = String(failure); }
    assert(error?.includes('synthetic finalization refusal'));
    const observed = { state: todos.getTodo(kind)!.state, card: todos.getQuestion(`${kind}-start`)!.state, visibleState: (await visible(kind)).state };
    refused.push({ kind, error, observed });
    if (mode === 'before') assert(observed.state !== 'doing' || observed.card !== 'open');
    else assert.deepEqual(observed, { state: 'doing', card: 'open', visibleState: 'doing' });
  }
  report.refused = refused;
  await observer.request('system.health', {});
  report.rollbackNotifications = { websocket: notifications, internal: internalNotifications };
  if (mode === 'verify') assert.equal(notifications, 0, 'a rolled-back removal must not notify another client');
  if (mode === 'before') {
    assert(mainSql > 0);
    report.baselineReproduced = true;
  } else {
    db.exec('DROP TRIGGER refuse_finalize_stamp');
    const text = 'Complete finalization report 🦊\n'.repeat(25000);
    prepare('UPDATE neo_todos SET report = ?').run(text);
    const receipts = [];
    for (const kind of ['remove'] as const) {
      const result = await finish(kind, kind);
      assert(result.ok && result.todo.state === 'removed');
      assert(result.todo.report === text, 'removal receipt must retain the complete report');
      assert.equal((await visible(kind)).state, 'removed');
      const detail = await hub.request<{ ok: boolean; entry: { todos: NeoTodo[] } }>('operation.invoke', { name: 'neo.ask.read', input: { todoId: kind } });
      assert(detail.ok && detail.entry.todos.find(todo => todo.id === kind)?.report === text, 'opened card must retain the complete report');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([observedChange, new Promise((_, fail) => { timeout = setTimeout(() => fail(new Error('another client received no neo.changed after removal')), 1500); })]);
      } finally { clearTimeout(timeout); }
      await observer.request('system.health', {});
      const updated = await refreshed!;
      assert.equal(updated.todoAsks.flatMap(entry => entry.todos).find(todo => todo.id === kind)?.state, 'removed');
      assert.equal(notifications, 1);
      assert.equal(internalNotifications, 1);
      report.commitNotifications = { websocket: notifications, internal: internalNotifications, otherClientState: 'removed' };
      observing = false;
      receipts.push({ kind, state: result.todo.state, replyBytes: Buffer.byteLength(JSON.stringify(result)) });
    }
    report.receipts = receipts;
    report.fullReport = { bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') };
    assert.equal(mainSql, 0);
    add('held');
    lock = spawn('/usr/bin/python3', ['-c', "import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()", app.db.getDbPath()], { stdio: ['ignore', 'pipe', 'pipe'] });
    lockExit = new Promise<void>((done, fail) => { lock!.once('error', fail); lock!.once('exit', code => code === 0 ? done() : fail(new Error('synthetic lock failed'))); });
    await new Promise<void>(done => lock!.stdout!.once('data', () => done()));
    measureLag = true;
    const began = performance.now();
    const held = finish('remove', 'held');
    const healthStart = performance.now();
    await hub.request('system.health', {});
    const healthMs = performance.now() - healthStart;
    assert.equal((await held).ok, true);
    const writeMs = performance.now() - began;
    await lockExit;
    lock = undefined;
    measureLag = false;
    report.contention = { writeMs, healthMs, maxLagMs, affectedWriteUnder250ms: writeMs < 250 };
    assert(writeMs > 1000);
    assert(healthMs < 250 && maxLagMs < 250);
    assert.equal((await visible('held')).state, 'removed');
    assert.equal(mainSql, 0);
    report.verified = true;
  }
} finally {
  clearInterval(timer);
  report.notificationCounts = { websocket: notifications, internal: internalNotifications };
  observing = false;
  stopObserving();
  stopInternal();
  db.prepare = prepare;
  lock?.kill();
  await lockExit?.catch(() => {});
  await transport.close();
  await observerTransport.close();
  await app.cleanup();
  globalThis.fetch = network;
  report.mainSql = mainSql;
  writeFileSync(join(run, 'evidence/todo-remove-writer.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
