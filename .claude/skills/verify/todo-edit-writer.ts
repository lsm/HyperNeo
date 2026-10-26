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
import type { NeoTodo as FullTodo } from '../../../packages/shared/src/types/neo-ask.ts';

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
const db = app.db.getDatabase(), prepare = db.prepare.bind(db), todos = new NeoAskTodoRepository(db);
let recording = 0, mainSql = 0, measureLag = false, maxLagMs = 0, previous = performance.now();
let lock: ReturnType<typeof spawn> | undefined;
let lockExit: Promise<void> | undefined;
const timer = setInterval(() => { const now = performance.now(); if (measureLag) maxLagMs = Math.max(maxLagMs, now - previous - 10); previous = now; }, 10);
db.prepare = ((sql: string) => { if (recording && /neo_todos|neo_asks|neo_questions|pack_coding_pr_claims/.test(sql)) mainSql++; return prepare(sql); }) as typeof db.prepare;
const report: Record<string, unknown> = { mode, surface: 'real neo.todo.edit RPC and neo.snapshot' };
type Receipt = { ok: false; reason: string } | { ok: true; todo: NeoTodo; todos: NeoTodo[]; records?: string[] };
const edit = async (input: unknown) => {
  recording++;
  try { return await hub.request<Receipt>('operation.invoke', { name: 'neo.todo.edit', input }); }
  finally { recording--; }
};
const visible = async (id: string) => (await hub.request<{ ok: true; entry: { todos: FullTodo[] } }>('operation.invoke', { name: 'neo.ask.read', input: { askId: 'ask' } })).entry.todos.find(todo => todo.id === id)!;
const url = (n: number) => `https://github.com/synthetic/edit/pull/${n}`;
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await transport.connect();
  const root = 'neo:10000000-0000-4000-8000-000000008940';
  await app.db.createSession({ id: root, title: 'Synthetic edit', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  todos.openAsk({ id: 'ask', projectId: null, sessionId: root, originMessageId: null, title: 'Edit', request: 'Atomic RPC edits', createdAt: 1 });
  for (const id of ['first', 'second', 'report']) todos.addTodo(id, 'ask', { title: id, doneWhen: 'Merged', check: id === 'report' ? null : { pack: 'coding', kind: 'pr_merged', params: { urls: id === 'first' ? [url(1)] : [] } }, instruction: 'Synthetic work', named: null }, 1);
  prepare("UPDATE neo_todos SET state='doing', started_at=2 WHERE id='first'").run();
  todos.askQuestion('stale-start', 'ask', { text: 'Start?', kind: 'start', options: null, multiple: false, yesLabel: null, noLabel: null, startTodos: ['first'] }, 3);
  db.exec("CREATE TRIGGER refuse_edit_stamp BEFORE UPDATE OF updated_at ON neo_asks BEGIN SELECT RAISE(ABORT, 'synthetic edit refusal'); END");
  let refused: string | null = null;
  try { await edit({ todoId: 'first', title: 'Must roll back' }); }
  catch (error) { refused = String(error); }
  assert(refused?.includes('synthetic edit refusal'));
  const observed = { title: todos.getTodo('first')!.title, question: todos.getQuestion('stale-start')!.state, visibleTitle: (await visible('first')).title };
  report.refused = { error: refused, observed };
  if (mode === 'before') {
    assert.deepEqual(observed, { title: 'Must roll back', question: 'retired', visibleTitle: 'Must roll back' });
    assert(mainSql > 0);
    report.baselineReproduced = true;
  } else {
    assert.deepEqual(observed, { title: 'first', question: 'open', visibleTitle: 'first' });
    db.exec('DROP TRIGGER refuse_edit_stamp');
    assert.equal((await edit({ todoId: 'first', title: 'Committed title' })).ok, true);
    assert.equal((await visible('first')).title, 'Committed title');
    const concurrent = await Promise.all(['first', 'second'].map(todoId => edit({ todoId, addUrls: [url(2)] })));
    assert(concurrent.every(result => result.ok));
    assert.equal(concurrent.filter(result => result.ok && result.records?.some(record => record.startsWith('pr_already_tracked:'))).length, 1);
    assert.deepEqual(todos.getTodo('first')!.check?.params.urls, [url(1), url(2)]);
    report.concurrent = concurrent.map(result => result.ok ? { id: result.todo.id, urls: result.todo.check?.params.urls, records: result.records ?? [] } : result);
    const text = 'Complete edit evidence 🦊\n'.repeat(25000).trim();
    const full = await edit({ todoId: 'report', done: 'reported', evidence: text });
    assert(full.ok && full.todo.state === 'closed_unverified' && full.todo.report === text);
    assert.equal((await visible('report')).report, text);
    report.fullReport = { bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), replyBytes: Buffer.byteLength(JSON.stringify(full)), state: full.todo.state };
    const required = { pack: 'core', kind: 'evidence', params: { path: join(run, 'kept.txt') } };
    const changedCheck = await edit({ todoId: 'report', check: required });
    assert(changedCheck.ok);
    assert.deepEqual(changedCheck.todo.check, required);
    assert.equal(changedCheck.todo.doneWhen, `File ${required.params.path} exists.`);
    report.changedCheck = changedCheck.todo.check;
    assert.equal(mainSql, 0);
    lock = spawn('/usr/bin/python3', ['-c', "import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()", app.db.getDbPath()], { stdio: ['ignore', 'pipe', 'pipe'] });
    lockExit = new Promise<void>((done, fail) => { lock!.once('error', fail); lock!.once('exit', code => code === 0 ? done() : fail(new Error('synthetic lock failed'))); });
    await new Promise<void>(done => lock!.stdout!.once('data', () => done()));
    measureLag = true;
    const began = performance.now();
    const held = edit({ todoId: 'first', title: 'Held lock committed' });
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
    assert.equal((await visible('first')).title, 'Held lock committed');
    assert.equal(mainSql, 0);
    report.verified = true;
  }
} finally {
  clearInterval(timer);
  db.prepare = prepare;
  lock?.kill();
  await lockExit?.catch(() => {});
  await transport.close();
  await app.cleanup();
  globalThis.fetch = network;
  report.mainSql = mainSql;
  writeFileSync(join(run, 'evidence/todo-edit-writer.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
