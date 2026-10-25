import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'workspace'), { recursive: true });
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const socket = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
const connected = new Promise<void>((done, fail) => { socket.onopen = () => done(); socket.onerror = () => fail(new Error('RPC connect failed')); });
const report: Record<string, unknown> = { port: app.server.port };
try {
  assert.notEqual(app.server.port, 8399);
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await connected;
  const rpc = (name: string, input: unknown) => new Promise<any>((done, fail) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => fail(new Error(`${name} timed out`)), 10000);
    socket.onmessage = (event) => { const reply = JSON.parse(String(event.data)); if (reply.requestId !== id) return;
      clearTimeout(timeout); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    socket.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const root = 'neo:10000000-0000-4000-8000-000000008773';
  await app.db.createSession({ id: root, title: 'Synthetic notification proof', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const db = app.db.getDatabase();
  const prepare = db.prepare.bind(db);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  db.transaction(() => {
    const ask = prepare("INSERT INTO neo_asks (id,session_id,title,request,created_at,updated_at) VALUES (?,?,'Synthetic card','',?,?)");
    for (let i = 0; i < 101; i++) ask.run(`a${i}`, root, i + 1, i + 1);
    prepare("INSERT INTO neo_todos (id,ask_id,position,title,done_when,state,report,created_at,updated_at) VALUES ('t0','a0',0,'Failed old work','Observed','failed','Exact failure evidence',1,1)").run();
    prepare("INSERT INTO neo_questions (id,ask_id,text,kind,state,created_at) VALUES ('q0','a0','Synthetic question','reply','open',1)").run();
  })();
  const mainQueries: string[] = [];
  db.prepare = ((sql: string) => { if (/\bFROM neo_(asks|todos|questions|todo_sessions)\b/i.test(sql)) mainQueries.push(sql); return prepare(sql); }) as typeof db.prepare;
  const snapshot = await rpc('neo.snapshot', {});
  assert(!snapshot.todoAsks.some((entry: any) => entry.ask.id === 'a0'), 'target must really be outside snapshot window');
  const target = await rpc('neo.ask.read', { askId: 'a0' });
  Object.assign(report, { snapshotCount: snapshot.todoAsks.length, target, mainQueries });
  assert.equal(target.ok, true);
  assert.equal(target.entry.ask.id, 'a0');
  assert.equal(target.entry.todos[0].id, 't0');
  assert.equal(target.entry.todos[0].report, 'Exact failure evidence');
  assert.equal(target.entry.questions[0].id, 'q0');
  const gone = await rpc('neo.ask.read', { askId: 'missing' });
  assert.equal(gone.ok, false);
  assert(gone.reason.startsWith('not_found:'));
  assert.equal(mainQueries.length, 0);
  report.verified = true;
  console.log(JSON.stringify({ verified: true, snapshotCount: snapshot.todoAsks.length, readAsk: target.entry.ask.id, mainQueries: mainQueries.length }));
} finally {
  socket.close(); await app.cleanup();
  writeFileSync(join(run, 'evidence/notification-ask-read.json'), JSON.stringify(report, null, 2));
}
