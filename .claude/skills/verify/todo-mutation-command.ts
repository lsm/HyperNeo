import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import type { neoTodoMutations } from '../../../packages/daemon/src/storage/repositories/neo-todo-mutation-writes.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
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
const db = app.db.getDatabase(), prepare = db.prepare.bind(db), todos = new NeoAskTodoRepository(db);
let recording = false, mainSql = 0, measureLag = false, maxLagMs = 0, previous = performance.now();
let lock: ReturnType<typeof spawn> | undefined;
let lockExit: Promise<void> | undefined;
const timer = setInterval(() => { const now = performance.now(); if (measureLag) maxLagMs = Math.max(maxLagMs, now - previous - 10); previous = now; }, 10);
db.prepare = ((sql: string) => { if (recording && /neo_todos|neo_asks|neo_questions|pack_coding_pr_claims/.test(sql)) mainSql++; return prepare(sql); }) as typeof db.prepare;
const report: Record<string, unknown> = { mode, runtimeCallersMoved: false };
type Commit = InstanceType<typeof neoTodoMutations.Repository>['commit'];
const apply = async (input: Parameters<Commit>[0], checked?: Parameters<Commit>[1]) => {
  recording = true;
  try { const { neoTodoMutations } = await import('../../../packages/daemon/src/storage/repositories/neo-todo-mutation-writes.ts'); return await app.db.gateway.call(neoTodoMutations, 'commit', structuredClone(input), structuredClone(checked), 10); }
  finally { recording = false; }
};
const rpc = <R>(name: string, input: unknown) => hub.request<R>('operation.invoke', { name, input });
const snapshot = () => rpc<NeoSnapshot>('neo.snapshot', {});
const visible = async (id: string) => (await snapshot()).todoAsks.flatMap((entry) => entry.todos).find((todo) => todo.id === id)!;
const url = (number: number) => `https://github.com/synthetic/mutation/pull/${number}`;
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await transport.connect();
  const root = 'neo:10000000-0000-4000-8000-000000008935';
  await app.db.createSession({ id: root, title: 'Synthetic mutations', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  todos.openAsk({ id: 'ask', projectId: null, sessionId: root, originMessageId: null, title: 'Atomic mutations', request: 'Preserve writer admission', createdAt: 1 });
  for (const id of ['first', 'second']) todos.addTodo(id, 'ask', { title: id, doneWhen: 'Merged', check: { pack: 'coding', kind: 'pr_merged', params: { urls: id === 'first' ? [url(1)] : [] } }, instruction: 'Complete synthetic work', named: null }, 1);
  prepare("UPDATE neo_todos SET state='doing', started_at=2 WHERE id='first'").run();
  todos.askQuestion('stale-start', 'ask', { text: 'Start first?', kind: 'start', options: null, multiple: false, yesLabel: null, noLabel: null, startTodos: ['first'] }, 3);
  db.exec("CREATE TRIGGER refuse_mutation_stamp BEFORE UPDATE OF updated_at ON neo_asks BEGIN SELECT RAISE(ABORT, 'synthetic mutation refusal'); END");
  let refused: string | null = null;
  try {
    if (mode === 'before') {
      recording = true;
      try { await rpc('neo.todo.edit', { todoId: 'first', title: 'Must roll back' }); }
      finally { recording = false; }
    }
    else await apply({ kind: 'edit', todoId: 'first', title: 'Must roll back' });
  } catch (error) { refused = String(error); }
  assert(refused?.includes('synthetic mutation refusal'));
  const after = { title: todos.getTodo('first')!.title, question: todos.getQuestion('stale-start')!.state, visibleTitle: (await visible('first')).title };
  report.refused = { error: refused, observed: after };
  if (mode === 'before') {
    assert(after.title !== 'first' || after.question !== 'open', 'legacy RPC must expose its partial mutation');
    assert(mainSql > 0);
    report.baselineReproduced = true;
  } else {
    assert.deepEqual(after, { title: 'first', question: 'open', visibleTitle: 'first' });
    db.exec('DROP TRIGGER refuse_mutation_stamp');
    assert.equal((await apply({ kind: 'edit', todoId: 'first', title: 'Committed title' })).ok, true);
    assert.equal((await visible('first')).title, 'Committed title');
    const edits = await Promise.all(['first', 'second'].map((todoId) => apply({ kind: 'edit', todoId, addUrls: [url(2)] })));
    assert(edits.every((result) => result.ok));
    assert.equal(edits.filter((result) => result.ok && result.records?.some((record) => record.startsWith('pr_already_tracked:'))).length, 1);
    report.concurrent = edits.map((result) => result.ok ? { id: result.todo.id, urls: result.todo.check?.params.urls, records: result.records ?? [] } : result);
    const current = todos.getTodo('first')!;
    assert.deepEqual(current.check?.params.urls, [url(1), url(2)]);
    const stale = await apply({ kind: 'close', todoId: 'first', reason: 'Stale result' }, { check: { ...current.check!, params: { urls: [url(1)] } }, result: { done: true, evidence: 'Old check' } });
    assert(!stale.ok && stale.reason.includes('todo_changed'));
    const question = todos.askQuestion('human', 'ask', { text: 'Human still deciding', kind: 'reply', todoId: 'first', options: null, multiple: false, yesLabel: null, noLabel: null, startTodos: null }, 4);
    const blocked = await apply({ kind: 'close', todoId: 'first', reason: 'Merged' }, { check: current.check, result: { done: true, evidence: 'Passed' } });
    assert(!blocked.ok && blocked.reason.includes('card_unanswered'));
    todos.retireQuestion(question, 'Synthetic decision completed', null, 5);
    const unverified = await apply({ kind: 'close', todoId: 'first', reason: 'Work reported' }, { check: current.check, result: { done: false, evidence: null } });
    assert(unverified.ok && unverified.todo.state === 'closed_unverified');
    assert.equal((await visible('first')).state, 'closed_unverified');
    report.unverified = { state: unverified.todo.state, startNext: unverified.startNext };
    const done = await apply({ kind: 'close', todoId: 'first', reason: 'Verified merged' }, { check: current.check, result: { done: true, evidence: 'Passed' } });
    assert(done.ok && done.todo.state === 'done');
    assert.equal((await visible('first')).state, 'done');
    assert.equal(todos.getTodo('second')!.state, 'todo');
    const text = 'Complete synthetic result 🦊\n'.repeat(20000);
    const reported = await apply({ kind: 'edit', todoId: 'first', done: 'reported', evidence: text });
    assert(reported.ok && reported.todo.report === text);
    assert.equal(todos.getTodo('first')!.report, text);
    report.fullReport = { bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(reported.todo.report).digest('hex'), replyBytes: Buffer.byteLength(JSON.stringify(reported)) };
    assert.equal(mainSql, 0);
    lock = spawn('/usr/bin/python3', ['-c', "import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()", app.db.getDbPath()], { stdio: ['ignore', 'pipe', 'pipe'] });
    lockExit = new Promise<void>((done, fail) => { lock!.once('error', fail); lock!.once('exit', (code) => code === 0 ? done() : fail(new Error('synthetic lock failed'))); });
    await new Promise<void>((done) => lock!.stdout!.once('data', () => done()));
    measureLag = true;
    const started = performance.now();
    const held = apply({ kind: 'edit', todoId: 'first', title: 'Held lock committed' });
    const healthStart = performance.now();
    await hub.request('system.health', {});
    const healthMs = performance.now() - healthStart;
    assert.equal((await held).ok, true);
    const writeMs = performance.now() - started;
    await lockExit;
    lock = undefined;
    measureLag = false;
    report.contention = { writeMs, healthMs, maxLagMs, affectedWriteUnder250ms: writeMs < 250 };
    assert(writeMs > 1000);
    assert(healthMs < 250);
    assert(maxLagMs < 250);
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
  writeFileSync(join(run, 'evidence/todo-mutation-command.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ mode, verified: report.verified, baselineReproduced: report.baselineReproduced, mainSql, contention: report.contention }));
