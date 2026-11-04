import assert from 'node:assert/strict';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationRegistry, defineOperation } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { StartWorkInputSchema, StartWorkResultSchema } from '../../../packages/daemon/src/lib/drivers/work-operations.ts';
import { recordStartedWork, readFreeWorkers } from '../../../packages/daemon/src/storage/work-started-sessions.ts';
import { codingStageTodoFixture, stageDraft, stageParams, stageTarget } from '../../../packages/daemon/tests/unit/helpers/coding-stage-todos.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const evidence: unknown[] = [];
const starts: unknown[] = [];
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('HTTP refused in synthetic stage-todo proof'); }) as typeof fetch;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
let ws: WebSocket | undefined;
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  const fixture = codingStageTodoFixture(db);
  const registry = app.sessionManager.getOperationRegistry();
  const harness = defineOperation({ name: 'work.start', description: 'Synthetic worker chooser; no model.',
    inputSchema: StartWorkInputSchema, resultSchema: StartWorkResultSchema,
    execute: async input => {
      const ref = { adapter: 'fixture', id: ['author', 'reviewer', 'verifier'].find(id => !input.excludeRefs?.some(ref => ref.id === id))! };
      starts.push({ input, ref }); recordStartedWork(db, ref);
      return { ok: true as const, value: { ref, title: input.title, place: input.place!, status: 'running' as const, lastActivityAt: Date.now(), model: stageTarget.model } };
    },
  });
  const boundRegistry = createOperationRegistry(registry.entries.map(entry => entry.name === 'work.start' ? harness : entry));
  app.sessionManager.setOperationRegistryProvider(() => boundRegistry);
  ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`, join(run, 'data/local-rpc.credential'));
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC open failed')); });
  const rpc = (name: string, input: unknown) => new Promise<{ ok: boolean; reason?: string; todo?: { id: string; state: string; askId: string; evidence: string | null } }>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
    ws!.onmessage = event => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer); evidence.push({ name, input, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const review = await rpc('neo.todo.add', { askId: fixture.ask.id, ...stageDraft() });
  assert(review.ok, review.reason); assert(review.todo);
  assert.equal(review.todo.askId, fixture.ask.id);
  assert.equal(review.todo.state, 'doing');
  assert.equal(fixture.sessions.readRef(review.todo.id)?.id, 'reviewer');
  assert.equal(readFreeWorkers(db, 'fixture').has('reviewer'), false);
  assert(fixture.result(review.todo.id, 'fail'));
  const closedReview = await rpc('neo.todo.edit', { todoId: review.todo.id, done: 'met', evidence: 'Exact assigned review verdict observed.' });
  assert.equal(closedReview.todo?.state, 'done');
  assert.equal(readFreeWorkers(db, 'fixture').has('reviewer'), true);
  const verify = await rpc('neo.todo.add', { askId: fixture.ask.id, ...stageDraft('verify') });
  assert(verify.ok, verify.reason); assert(verify.todo);
  assert.equal(verify.todo.askId, fixture.ask.id);
  assert.equal(fixture.sessions.readRef(verify.todo.id)?.id, 'verifier');
  assert(fixture.result(verify.todo.id, 'inconclusive', 'qa'));
  const closedVerify = await rpc('neo.todo.edit', { todoId: verify.todo.id, done: 'met', evidence: 'Exact assigned Verify verdict observed.' });
  assert.equal(closedVerify.todo?.state, 'done');
  assert.equal(readFreeWorkers(db, 'fixture').has('verifier'), true);
  assert.equal(fixture.store.getTodo(fixture.author.id)?.state, 'doing');
  const draft = stageDraft();
  const next = await rpc('neo.todo.add', { askId: fixture.ask.id, ...draft, check: { ...draft.check, params: { ...stageParams, head: 'b'.repeat(40) } } });
  assert(next.ok, next.reason); assert(next.todo);
  assert.notEqual(next.todo.id, review.todo.id);
  assert.equal(next.todo.state, 'doing');
  assert.equal((await fixture.pack.todos!.check(fixture.store.getTodo(next.todo.id)!))?.done, false);
  assert.deepEqual(db.prepare('SELECT count(*) AS n FROM pack_facts').get(), { n: 0 });
  evidence.push({ starts, todos: fixture.store.listTodos(fixture.ask.id), bindings: fixture.store.listTodos(fixture.ask.id).map(todo => ({ id: todo.id, card: fixture.sessions.readCard(todo.id), deliveries: fixture.sessions.inputs.list(todo.id) })), verdicts: fixture.ledger.stageFacts.read(stageParams.url) });
  console.log('PASS: actual daemon core RPC starts separate Review/Verify todos, preserves independent bindings, closes fail/inconclusive stages, frees actors, leaves author doing and new head pending.');
} finally {
  writeFileSync(join(run, 'evidence/coding-stage-todos.json'), JSON.stringify({ evidence, starts }, null, 2));
  ws?.close(); await app.cleanup(); globalThis.fetch = network;
}
