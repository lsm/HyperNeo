process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
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
const options = ['Long-lived work-type sessions', 'One session per task', 'One session per PR', 'Keep current settings'];
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('No HTTP in synthetic strategy question proof'); }) as typeof fetch;
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, verbose: false });
let ws: WebSocket | undefined;
try {
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop(); assert(![8399, 8499].includes(app.server.port));
  await app.db.updateGlobalSettings({ language: 'en', neo: { packs: ['coding'] } });
  ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const pending = new Map<string, (reply: { error?: unknown; data?: unknown }) => void>();
  ws.onmessage = event => { const reply = JSON.parse(String(event.data)); pending.get(reply.requestId ?? reply.id)?.(reply); };
  const rpc = (method: string, data: unknown) => new Promise<any>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
    pending.set(id, reply => {
      pending.delete(id); clearTimeout(timer); evidence.push({ method, data, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    });
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const op = (name: string, input: unknown) => rpc('operation.invoke', { name, input });
  const root = (await rpc('session.create', { title: 'Synthetic Neo', workspacePath: join(run, 'workspace'), config: { queryMode: 'manual' } })).sessionId as string;
  const back: WorkRef = { adapter: 'hyperneo', id: (await rpc('session.create', { title: 'backend', workspacePath: join(run, 'workspace'), config: { queryMode: 'manual' } })).sessionId };
  const neo = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  neo.deliverForward = async () => {};
  const db = app.db.getDatabase();
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  for (const id of ['earlier', 'feature', 'other'])
    store.openAsk({ id, projectId: null, sessionId: root, originMessageId: null, title: id, request: 'Synthetic', createdAt: 1 });
  const earlier = store.addTodo(crypto.randomUUID(), 'earlier', { title: 'Done slice', instruction: 'Synthetic', named: null, check: null, doneWhen: 'Done' }, 2, repo);
  db.prepare('INSERT INTO neo_todo_sessions (todo_id, target, ref) VALUES (?, ?, ?)').run(earlier.id, JSON.stringify({ verb: 'start', adapter: 'hyperneo', name: 'backend' }), JSON.stringify(back));
  db.prepare("UPDATE neo_todos SET state = 'done' WHERE id = ?").run(earlier.id);
  const ready = (askId: string) => {
    const item = store.addTodo(crypto.randomUUID(), askId, { approvedAt: 1, title: 'Next slice', instruction: 'Synthetic slice; reply ok.', named: null, check: { pack: 'coding', kind: 'pr_merged', params: {} }, doneWhen: 'Done' }, 3, repo);
    sessions.create(item.id, { verb: 'start', adapter: 'hyperneo', name: 'backend' });
    return item;
  };
  const dispatched = async (label: string, askId: string) => {
    const item = ready(askId);
    const outcome = await neo.todoRunner.start(item.id);
    const row = { surface: 'todo runner start', label, outcome, todo: store.getTodo(item.id), target: sessions.get(item.id), ref: sessions.readRef(item.id) };
    evidence.push(row);
    return row;
  };
  const pack = neo.packs().find((candidate) => candidate.id === 'coding')!;
  const status = async (ref: WorkRef) => ({ kind: 'completed' as const, value: await op('work.status', { ref }) });
  const decided = async (label: string, askId: string) => {
    const item = ready(askId);
    const decision = await pack.workerTarget!(item, sessions.get(item.id)!, status, (input) =>
      invokeOperation(app.sessionManager.getOperationRegistry(), 'pack.preferences.ask', { askId, ...input }, { source: 'internal', role: 'neo', sessionId: root }));
    evidence.push({ surface: 'coding pack workerTarget', label, decision });
    return decision;
  };
  const cards = async () => (await op('neo.snapshot', {})).todoAsks.flatMap((entry: any) => entry.questions).filter((q: any) => q.text?.startsWith('Choose one of these settings?'));
  const strategies = async () => (await op('pack.preferences.list', {})).preferences.filter((row: any) => row.key === 'sessionStrategy');

  const first = await dispatched('the first dispatch in the repo works long-lived and asks', 'feature');
  assert.equal(first.todo?.state, 'doing');
  assert.deepEqual(first.target, { verb: 'send', ref: back });
  let asked = await cards();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, 'choice');
  assert.deepEqual(asked[0].options, options);
  assert(asked[0].text.includes('### github\\.com/synthetic/sessions'), 'the card names the repository');
  assert.deepEqual(await strategies(), []);

  assert.deepEqual(await decided('another ask in the repo while the question is open', 'other'), { value: { verb: 'start', adapter: 'hyperneo', name: 'backend-2' } });
  assert.equal((await cards()).length, 1);
  assert.deepEqual(await strategies(), []);

  assert.equal((await op('neo.question.answer', { questionId: asked[0].id, answer: options[1] })).ok, true);
  const saved = await strategies();
  assert.deepEqual(saved.map((row: any) => ({ scope: row.scope, value: row.value, setBy: row.setBy })), [{ scope: { kind: 'repo', key: repo.toLowerCase() }, value: 'per_task', setBy: 'human' }]);

  assert.deepEqual(await decided('after the human picks per-task, new work starts its own session', 'other'), { value: { verb: 'start', adapter: 'hyperneo', name: 'backend' } });
  asked = await cards();
  assert.equal(asked.filter((q: any) => q.state === 'open').length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM neo_pack_preference_proposals WHERE request_id LIKE 'coding.sessionStrategy:%'").get().n, 1);
  console.log(`PASS: the first coding dispatch in a repo kept long-lived reuse and opened one session-strategy choice; a dispatch from another ask stayed long-lived (backend-2) without asking again and nothing was saved; the human picked per-task, which was saved with human provenance, and the next dispatch started its own session without a new question. Evidence: ${run}/evidence/strategy-question.json`);
} finally {
  writeFileSync(join(run, 'evidence/strategy-question.json'), JSON.stringify(evidence, null, 2));
  ws?.close(); await app.cleanup();
  globalThis.fetch = network;
}
