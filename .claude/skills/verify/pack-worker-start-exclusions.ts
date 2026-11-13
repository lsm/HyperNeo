import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { packWorkerStartFixture } from '../../../packages/daemon/tests/unit/helpers/pack-worker-start.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP refused in generic pack proof'); }) as typeof fetch;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
let ws: WebSocket | undefined;
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  const world = packWorkerStartFixture(db);
  const registry = app.sessionManager.getOperationRegistry();
  const replacements = new Map(world.operations.map(op => [op.name, op]));
  const proofRegistry = createOperationRegistry(registry.entries.map(op => replacements.get(op.name) ?? op));
  app.sessionManager.setOperationRegistryProvider(() => proofRegistry);
  await world.open();
  const ask = world.store.listOpenAsks()[0];
  const author = await world.invoke('neo.todo.add', { after: [], askId: ask.id, ...world.draft('Author'), start: false });
  world.bind(author.todo.id, 'author');
  const prior = await world.invoke('neo.todo.add', { after: [], askId: ask.id, ...world.draft('Earlier actor'), start: false });
  world.bind(prior.todo.id, 'prior');
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const rpc = (input: unknown) => new Promise<{ ok: boolean; todo: { id: string; state: string; blockedBy: string | null; reason: string | null } }>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error('RPC timed out')), 10000);
    ws!.onmessage = event => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer); evidence.push({ input, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name: 'neo.todo.add', input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const started = await rpc({ askId: ask.id, ...world.draft('Independent worker', [author.todo.id, prior.todo.id]) });
  assert(started.ok, JSON.stringify(started));
  evidence.push({ surface: 'core binding and receipt', todo: world.store.getTodo(started.todo.id), binding: world.sessions.readCard(started.todo.id), delivery: world.sessions.inputs.list(started.todo.id), starts: world.calls });
  assert.equal(world.sessions.readRef(started.todo.id)?.id, 'independent');
  assert.equal(started.todo.state, 'doing');
  assert.equal(started.todo.blockedBy, null);
  assert.equal(world.sessions.inputs.list(started.todo.id).length, 1);
  const denied = await rpc({ askId: ask.id, ...world.draft('Missing identity', ['missing']) });
  assert.equal(denied.todo.state, 'failed');
  assert(denied.todo.reason?.includes('missing_worker_binding'));
  assert.equal(world.calls.length, 1);
  assert.deepEqual(world.sessions.inputs.list(denied.todo.id), []);
  assert.equal(world.sessions.readRef(denied.todo.id), null);
  assert.deepEqual(db.prepare('SELECT count(*) AS n FROM pack_facts').get(), { n: 0 });
  evidence.push({ denied: world.store.getTodo(denied.todo.id), journal: world.sessions.inputs.list(denied.todo.id) });
  console.log('PASS: real RPC core add/start excludes both bound workers; core owns the independent binding/receipt, and a refused start has neither delivery nor worker.');
} finally {
  writeFileSync(join(run, 'evidence/pack-worker-start-exclusions.json'), JSON.stringify(evidence, null, 2));
  ws?.close();
  await app.cleanup();
  globalThis.fetch = originalFetch;
}
