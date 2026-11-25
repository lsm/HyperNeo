process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';
import type { WorkRef } from '../../../packages/daemon/src/lib/drivers/types.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'workspace'), { recursive: true });
const evidence: unknown[] = [];
const repo = 'github.com/synthetic/sessions';
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('No HTTP in synthetic session target proof'); }) as typeof fetch;
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, verbose: false });
let ws: WebSocket | undefined;
try {
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop(); assert(![8399, 8499].includes(app.server.port));
  await app.db.updateGlobalSettings({ neo: { packs: ['coding'] } });
  ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const pending = new Map<string, (reply: { error?: unknown; data?: unknown }) => void>();
  ws.onmessage = event => { const reply = JSON.parse(String(event.data)); pending.get(reply.requestId ?? reply.id)?.(reply); };
  const rpc = (method: string, data: unknown) => new Promise<unknown>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
    pending.set(id, reply => {
      pending.delete(id); clearTimeout(timer); evidence.push({ method, data, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    });
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const session = async (title: string): Promise<WorkRef> => ({ adapter: 'hyperneo', id: ((await rpc('session.create', { title, workspacePath: join(run, 'workspace'), config: { queryMode: 'manual' } })) as { sessionId: string }).sessionId });
  const status = async (ref: WorkRef) => ({ kind: 'completed' as const, value: await rpc('operation.invoke', { name: 'work.status', input: { ref } }) });
  const [front, back] = [await session('frontend'), await session('backend')];
  const neo = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  const pack = neo.packs().find((candidate) => candidate.id === 'coding');
  assert(pack?.workerTarget, 'the coding pack declares workerTarget');
  const db = app.db.getDatabase();
  const store = new NeoAskTodoRepository(db);
  for (const id of ['feature', 'earlier'])
    store.openAsk({ id, projectId: null, sessionId: 'neo', originMessageId: null, title: id, request: 'Synthetic', createdAt: 1 });
  const todo = (askId: string) => store.addTodo(crypto.randomUUID(), askId, { title: 'Slice', instruction: 'Synthetic', named: null, check: null, doneWhen: 'Done' }, 2, repo);
  const worked = (askId: string, ref: WorkRef, name?: string) => {
    const item = todo(askId);
    db.prepare('INSERT INTO neo_todo_sessions (todo_id, target, ref) VALUES (?, ?, ?)').run(item.id, JSON.stringify(name ? { verb: 'start', adapter: 'hyperneo', name } : { verb: 'send', ref }), JSON.stringify(ref));
    db.prepare("UPDATE neo_todos SET state = 'done' WHERE id = ?").run(item.id);
    return item;
  };
  const decide = async (label: string, item: ReturnType<typeof todo>, target: Parameters<NonNullable<typeof pack.workerTarget>>[1]) => {
    const decision = await pack.workerTarget!(item, target, status);
    evidence.push({ surface: 'coding pack workerTarget', label, target, decision });
    return decision;
  };
  worked('earlier', front, 'frontend');
  const prior = worked('feature', back, 'backend');
  db.prepare('INSERT INTO pack_coding_feature_sessions (repo, feature_key, todo_id, reserved_at) VALUES (?, ?, ?, 1)').run(repo.toLowerCase(), 'feature', prior.id);
  const requested = { verb: 'start' as const, adapter: 'hyperneo', name: 'backend', place: { machine: hostname(), name: 'Synthetic', folder: join(run, 'workspace') } };
  const next = todo('feature');
  assert.deepEqual(await decide('a prior feature worker does not redirect the next start', next, requested), { value: requested });
  const addressed = { verb: 'send' as const, ref: front };
  assert.deepEqual(await decide('an explicit send keeps its author', todo('feature'), addressed), { value: addressed });
  assert.deepEqual(db.prepare('SELECT todo_id AS todoId FROM pack_coding_feature_sessions WHERE feature_key = ?').all('feature'), [{ todoId: prior.id }]);
  const sessions = new NeoTodoSessionRepository(db);
  const ready = store.addTodo(crypto.randomUUID(), 'feature', { approvedAt: 1, title: 'Next slice', instruction: 'Synthetic next slice; reply ok.', named: null, check: { pack: 'coding', kind: 'pr_merged', params: {} }, doneWhen: 'Done' }, 3, repo);
  sessions.create(ready.id, requested);
  const outcome = await neo.todoRunner.start(ready.id);
  const recorded = { outcome, todo: store.getTodo(ready.id), target: sessions.get(ready.id), ref: sessions.readRef(ready.id) };
  evidence.push({ surface: 'todo runner start', label: 'a ready slice retains its start target', ...recorded });
  assert.equal(recorded.todo?.state, 'doing', JSON.stringify(recorded));
  assert.deepEqual(recorded.target, requested);
  assert(recorded.ref, JSON.stringify(recorded));
  assert.notEqual(recorded.ref.id, back.id);
  assert.deepEqual(db.prepare('SELECT todo_id AS todoId FROM pack_coding_feature_sessions WHERE feature_key = ?').all('feature'), [{ todoId: prior.id }]);
  console.log('PASS: the real coding todo runner keeps the requested start and does not reserve or follow the previous feature worker.');
} finally {
  writeFileSync(join(run, 'evidence/session-target.json'), JSON.stringify(evidence, null, 2));
  ws?.close(); await app.cleanup();
  globalThis.fetch = network;
}
