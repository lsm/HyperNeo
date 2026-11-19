import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { reviewedWorkerListId } from '../../../packages/daemon/src/lib/neo/worker-ownership-apply.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
let socket: WebSocket | undefined;
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'home') }), disableWorktrees: true }, verbose: false });
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  const raw = app.db.getDatabase();
  const todos = new NeoAskTodoRepository(raw);
  const sessions = new NeoTodoSessionRepository(raw);
  todos.openAsk({ id: 'ask', sessionId: 'synthetic-neo', projectId: null, originMessageId: null, title: 'Synthetic', request: 'Synthetic', createdAt: 1 });
  for (const id of ['created', 'changed', 'sent', 'adopted', 'bound', 'named', 'claimed', 'released']) {
    raw.prepare('INSERT INTO work_started_sessions (adapter,id,started_at,claimed_by,released_at) VALUES (?, ?, ?, ?, ?)').run('claude-code', id, 1, id === 'claimed' ? 'todo-claimed' : null, id === 'released' ? 2 : null);
    if (['claimed', 'released'].includes(id)) continue;
    const todo = todos.addTodo(`todo-${id}`, 'ask', { title: id, doneWhen: 'Done', instruction: null, named: id === 'named' ? { session: 'human' } : null, check: null }, 1);
    const ref = { adapter: 'claude-code', id };
    const target = id === 'sent' ? { verb: 'send' as const, ref } : id === 'adopted' ? { verb: 'adopt' as const, ref } : { verb: 'start' as const, adapter: 'claude-code' };
    sessions.create(todo.id, target);
    if (id === 'bound') raw.prepare('UPDATE neo_todo_sessions SET target = ? WHERE todo_id = ?').run(JSON.stringify({ verb: 'bind', ref }), todo.id);
    raw.prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(JSON.stringify(ref), todo.id);
  }
  const before = raw.prepare('SELECT * FROM work_started_sessions ORDER BY id').all();
  socket = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { socket!.onopen = () => done(); socket!.onerror = () => fail(new Error('RPC connection failed')); });
  const invoke = (name: string, input: unknown) => new Promise<unknown>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error('RPC timed out')), 10000);
    socket!.onmessage = (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.requestId !== id) return;
      clearTimeout(timer);
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    socket!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const list = await invoke('neo.workerOwnership.candidates', {});
  const refused = await invoke('neo.workerOwnership.apply', {});
  const reviewed = ['created', 'changed', 'sent', 'adopted', 'bound', 'named', 'claimed', 'released'].map(id => ({ adapter: 'claude-code', id }));
  const reviewedListId = reviewedWorkerListId(reviewed);
  raw.prepare("UPDATE work_started_sessions SET claimed_by = 'later' WHERE id = 'changed'").run();
  const refusedWithId = await invoke('neo.workerOwnership.apply', { reviewedListId: 'synthetic-review', reviewed, criteria: 'start-unclaimed' });
  const applied = await invoke('neo.workerOwnership.apply', { reviewedListId, reviewed, criteria: 'start-unclaimed' });
  const again = await invoke('neo.workerOwnership.apply', { reviewedListId, reviewed, criteria: 'start-unclaimed' });
  const value = list as { notice: string; candidates: {id: string; evidence: {strength: string}}[] };
  assert.match(value.notice, /inferred, not proven/);
  assert.deepEqual(value.candidates.map((candidate) => candidate.id), ['changed', 'claimed', 'created']);
  assert.equal(value.candidates[1].evidence.strength, 'inferred, weak');
  assert.equal((refused as {accepted: boolean}).accepted, false);
  assert.equal((refusedWithId as {accepted: boolean}).accepted, false);
  assert.deepEqual(applied, { accepted: true, applied: 1, reviewed: reviewed.length });
  assert.deepEqual(again, { accepted: true, applied: 0, reviewed: reviewed.length });
  const after = raw.prepare('SELECT id, role FROM work_started_sessions ORDER BY id').all() as { id: string; role: string | null }[];
  assert.deepEqual(after.filter(row => row.role === 'worker').map(row => row.id), ['created']);
  assert.equal(before.length, after.length);
  writeFileSync(join(run, 'evidence/worker-ownership.json'), JSON.stringify({ list, refused, refusedWithId, applied, again, after }, null, 2));
  console.log(`PASS candidates=${value.candidates.length} applied=1 reapplied=0 protected=7`);
} finally { socket?.close(); await app.cleanup(); }
