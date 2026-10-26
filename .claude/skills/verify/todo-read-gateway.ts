import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

const [mode, directory] = process.argv.slice(2);
const run = resolve(directory);
assert(['before', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'workspace'), { recursive: true });
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const socket = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
const connected = new Promise<void>((done, fail) => { socket.onopen = () => done(); socket.onerror = () => fail(new Error('RPC connect failed')); });
const report: Record<string, unknown> = { mode, port: app.server.port };
let measuring = false;
let previous = performance.now();
let maxLagMs = 0;
const timer = setInterval(() => { const now = performance.now(); if (measuring) maxLagMs = Math.max(maxLagMs, now - previous - 10); previous = now; }, 10);
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
  const root = 'neo:10000000-0000-4000-8000-000000008711';
  await app.db.createSession({ id: root, title: 'Synthetic read proof', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const db = app.db.getDatabase();
  const prepare = db.prepare.bind(db);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const evidence = '完整 synthetic retained evidence '.repeat(5000);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  db.transaction(() => {
    const ask = prepare(`INSERT INTO neo_asks (id,session_id,title,request,created_at,updated_at) VALUES (?,?,'Synthetic read card','',1,1)`);
    const todo = prepare(`INSERT INTO neo_todos (id,ask_id,position,title,done_when,state,evidence,created_at,updated_at) VALUES (?, ?, ?, 'Synthetic read step', 'Observed', ?, ?, 1, 1)`);
    const session = prepare(`INSERT INTO neo_todo_sessions(todo_id,target,ref) VALUES (?,'{}',?)`);
    for (let i = 0; i < 376; i++) ask.run(`a${i}`, root);
    for (let i = 0; i < 1213; i++) {
      todo.run(`t${i}`, `a${i % 376}`, Math.floor(i / 376), i % 3 === 0 ? 'done' : 'todo', i === 0 ? evidence : null);
      if (i < 989) session.run(`t${i}`, JSON.stringify({ adapter: 'hyperneo', id: root }));
    }
  })();
  const mainQueries: string[] = [];
  db.prepare = ((sql: string) => {
    if (/\bFROM neo_(asks|todos|questions|todo_sessions)\b/i.test(sql)) mainQueries.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  measuring = true; previous = performance.now();
  const start = performance.now();
  const snapshot = await rpc('operation.invoke', { name: 'neo.snapshot', input: {} }) as { ok: boolean; todoAsks: { ask: { id: string }; todos: unknown[] }[] };
  const snapshotMs = performance.now() - start;
  assert(snapshot.ok && snapshot.todoAsks.length > 0, 'populated Neo snapshot');
  const pageStart = performance.now();
  const page = await rpc('operation.invoke', { name: 'neo.ask.doneTodos', input: { askId: 'a0', offset: 0, limit: 20 } }) as { ok: boolean; todos: { id: string; evidence: string }[]; doneCount: number; nextOffset: number | null };
  const donePageMs = performance.now() - pageStart;
  assert(page.ok);
  assert.deepEqual(page.todos.map((todo) => todo.id), ['t0', 't1128']);
  assert.equal(page.doneCount, 2);
  assert.equal(page.nextOffset, null);
  assert.equal(hash(page.todos[0].evidence), hash(evidence));
  const healthStart = performance.now();
  report.health = await rpc('system.health', {});
  const healthMs = performance.now() - healthStart;
  await new Promise((done) => setTimeout(done, 25));
  measuring = false;
  Object.assign(report, { counts: { asks: 376, todos: 1213, sessions: 989 }, snapshot, page: { ...page, todos: page.todos.map((todo) => ({ id: todo.id, evidenceHash: todo.evidence ? hash(todo.evidence) : null })) }, fullEvidenceHash: hash(evidence), mainQueries, snapshotMs, donePageMs, healthMs, maxLagMs, replyBytes: Buffer.byteLength(JSON.stringify(snapshot)) });
  if (mode === 'before') assert(mainQueries.length > 0, 'baseline main-thread reads reproduced');
  else { assert.equal(mainQueries.length, 0); assert(snapshotMs < 250); assert(donePageMs < 250); assert(healthMs < 250); assert(maxLagMs < 1000); }
  report.verified = true;
  console.log(JSON.stringify({ mode, mainQueries: mainQueries.length, snapshotMs, donePageMs, healthMs, maxLagMs, fullEvidenceHash: hash(evidence) }));
} finally {
  clearInterval(timer); socket.close(); await app.cleanup();
  writeFileSync(join(run, 'evidence/todo-read-gateway.json'), JSON.stringify(report, null, 2));
}
