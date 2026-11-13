import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createWorkVerbOperations } from '../../../packages/daemon/src/lib/drivers/work-operations.ts';
import type { WorkAdapter, WorkSummary } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { readReusableWorkers, recordStartedWork } from '../../../packages/daemon/src/storage/work-started-sessions.ts';
import { packWorkerStartFixture } from '../../../packages/daemon/tests/unit/helpers/pack-worker-start.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const cases: unknown[] = [];
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  const place = { machine: 'fixture', name: 'Fixture', folder: join(run, 'workspace') };
  let candidates: WorkSummary[] = [];
  const busy = new Set<string>();
  const sent: string[] = [];
  const fresh: string[] = [];
  const worker = (id: string): WorkSummary => ({ ref: { adapter: 'fixture', id }, title: id, place, status: 'done', lastActivityAt: 1 });
  const adapter: WorkAdapter = {
    id: 'fixture', capabilities: ['find', 'send', 'start'],
    find: () => [{ place, work: candidates, lastActivityAt: 1, openCount: candidates.length, archivedCount: 0, adapters: ['fixture'] }],
    status: async ref => ({ ok: true, value: { ...worker(ref.id), status: busy.has(ref.id) ? 'running' : 'done' } }),
    send: async ref => { sent.push(ref.id); return { ok: true, value: { delivered: true } }; },
    start: async () => { const id = `fresh-${fresh.length}`; fresh.push(id); return { ok: true, value: worker(id) }; },
  };
  const registry = createOperationRegistry(createWorkVerbOperations({
    adapters: () => [adapter], remote: { list: () => [], invoke: async () => ({}) }, daemonName: 'fixture',
    freeWorkers: (id, todoId, sessionId) => readReusableWorkers(db, id, todoId, sessionId),
    recordStarted: ref => recordStartedWork(db, ref),
    startPlace: input => ({ value: { ...input, place } }),
  }));
  const world = packWorkerStartFixture(db, {
    invoke: (name, input) => invokeOperation(registry, name, input, { source: 'internal', role: 'neo', sessionId: 'fixture-neo' }),
  });
  const open = async () => { await world.open(); return world.store.listOpenAsks()[0].id; };
  const bind = async (askId: string, id: string, at: number) => {
    const result = await world.invoke('neo.todo.add', { after: [], askId, ...world.draft(id), instruction: null, target: undefined });
    world.bind(result.todo.id, id);
    world.store.updateTodo(world.store.getTodo(result.todo.id)!, { state: 'done', startedAt: at }, at);
    assert.equal(world.store.getTodo(result.todo.id)?.state, 'done');
    return result.todo.id;
  };
  const start = async (askId: string, title: string, expected: string, excluded: string[] = []) => {
    const before = sent.length;
    const result = await world.invoke('neo.todo.add', { after: [], askId, ...world.draft(title, excluded) });
    const ref = world.sessions.readRef(result.todo.id);
    const inputs = world.sessions.inputs.list(result.todo.id);
    assert.equal(ref?.id, expected, JSON.stringify(result));
    assert.equal(result.todo.state, 'doing');
    assert.equal(inputs.length, 1);
    cases.push({ title, expected, actual: ref, sent: sent.slice(before), inputs: inputs.length, exclusions: world.calls.at(-1)?.input.excludeRefs });
  };

  const ask = await open();
  await bind(ask, 'follow-older', 10);
  await bind(ask, 'follow-latest', 20);
  recordStartedWork(db, { adapter: 'fixture', id: 'follow-other' });
  candidates = ['follow-other', 'follow-older', 'follow-latest'].map(worker);
  await start(ask, 'Follow-up', 'follow-latest');

  const busyAsk = await open();
  await bind(busyAsk, 'busy-older', 30);
  await bind(busyAsk, 'busy-latest', 40);
  recordStartedWork(db, { adapter: 'fixture', id: 'busy-other' });
  busy.add('busy-latest');
  candidates = ['busy-other', 'busy-latest', 'busy-older'].map(worker);
  await start(busyAsk, 'Busy follow-up', 'busy-older');

  const reviewAsk = await open();
  const author = await bind(reviewAsk, 'review-author', 60);
  await bind(reviewAsk, 'review-independent', 50);
  candidates = ['review-author', 'review-independent'].map(worker);
  await start(reviewAsk, 'Independent review', 'review-independent', [author]);

  const oldAsk = await open();
  await bind(oldAsk, 'borrow-oldest', 70);
  world.store.settleAsk(world.store.getAsk(oldAsk)!, 'done', 'Observed', 100);
  const recentAsk = await open();
  await bind(recentAsk, 'borrow-recent', 80);
  world.store.settleAsk(world.store.getAsk(recentAsk)!, 'done', 'Observed', 200);
  const newAsk = await open();
  candidates = ['borrow-recent', 'borrow-oldest'].map(worker);
  await start(newAsk, 'Borrow oldest', 'borrow-oldest');

  const unavailableAsk = await open();
  await bind(unavailableAsk, 'no-free-worker', 90);
  busy.add('no-free-worker');
  candidates = [worker('no-free-worker')];
  await start(unavailableAsk, 'No idle worker', 'fresh-0');
  assert.deepEqual(fresh, ['fresh-0']);
  assert(!sent.includes('review-author'));
  process.stdout.write('PASS: core todo starts prefer ask affinity, refresh busy workers, respect pack exclusions, borrow oldest settled ask, and start fresh when needed\n');
} finally {
  writeFileSync(join(run, 'evidence/ask-worker-affinity.json'), JSON.stringify(cases, null, 2));
  await app.cleanup();
}
