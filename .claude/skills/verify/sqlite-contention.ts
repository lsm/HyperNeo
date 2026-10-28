import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { StructuredLogEvent } from '@hyperneo/shared';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { DbGateway } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { defineDbOp } from '../../../packages/daemon/src/storage/db-gateway/db-op.ts';
import { withBusyRetry } from '../../../packages/daemon/src/storage/busy-retry.ts';
import { runMessageSearchMerge } from '../../../packages/daemon/src/lib/message-search-merge.ts';
import { mirrorNeoWorkspaceProjectsAsync } from '../../../packages/daemon/src/lib/neo/project-mirror-async.ts';

if (process.env.NODE_ENV !== 'test') throw new Error('Synthetic proof requires NODE_ENV=test');
for (const entry of ['lib/message-search-merge-worker.ts', 'lib/neo/project-mirror-worker.ts']) {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, '../../../packages/daemon/src', entry)],
    target: 'bun',
    plugins: [{ name: 'no-worker-config-discovery', setup(build) {
      build.onLoad({ filter: /\/(config|credential-discovery)\.ts$/ }, ({ path }) => {
        throw new Error(`SQL worker must not load application configuration: ${path}`);
      });
    } }],
  });
  assert(result.success, `Worker loads without application configuration: ${entry}: ${result.logs.join('\n')}`);
}
const root = resolve(process.argv[2]);
mkdirSync(root, { recursive: true });
const path = join(root, 'synthetic.db');
if (existsSync(path)) throw new Error('Synthetic proof requires a fresh DB path');
const events: StructuredLogEvent[] = [];
const off = subscribeToStructuredLogs((event) => {
  if (event.module === 'hyperneo:daemon:sqlite.query') events.push(event);
});
const observed = { slowThresholdMs: 0, summaryIntervalMs: 25, maxQueryGroups: 50, summaryQueryLimit: 10 };
const db = new Database(path, { queryObservability: observed });
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE contention(value TEXT);
CREATE TABLE neo_project_workspaces(alias TEXT PRIMARY KEY, project_id TEXT);
CREATE TABLE work_started_sessions(adapter TEXT, id TEXT, started_at INTEGER, unusable_at INTEGER, PRIMARY KEY(adapter, id));
CREATE TABLE neo_todo_sessions(todo_id TEXT, ref TEXT);
CREATE TABLE neo_todos(id TEXT, ask_id TEXT, state TEXT);
CREATE TABLE neo_asks(id TEXT, status TEXT);
CREATE TABLE sessions(id TEXT PRIMARY KEY);
CREATE VIRTUAL TABLE message_search_fts USING fts5(body);`);
const gateway = new DbGateway(path, null, observed, () =>
  new Worker(new URL('./fixtures/sqlite-contention-worker.ts', import.meta.url).href, { type: 'module' })
);
const holder = defineDbOp({ name: 'test.holdWriter', mode: 'write', run: () => 'unused' });
const hold = async (delayMs: number) => {
  const signal = new SharedArrayBuffer(4);
  const call = gateway.run(holder, { signal, delayMs } as never);
  const deadline = Date.now() + 10_000;
  while (!Atomics.load(new Int32Array(signal), 0)) {
    if (Date.now() >= deadline) throw new Error('Holding worker did not acquire write transaction');
    await new Promise((done) => setTimeout(done, 2));
  }
  return { call };
};
try {
  const first = await hold(650);
  assert.equal(db.transaction(() => {
    db.run('INSERT INTO contention VALUES (?)', 'synthetic waiter');
    return 'waiter committed';
  }, 'immediate')(), 'waiter committed');
  Bun.sleepSync(120);
  assert.equal(await first.call, 'holder committed');
  const transactionEvents = events.filter((e) => e.metadata.operation === 'transaction');
  const held = transactionEvents.find((e) => e.metadata.workerOperation === 'test.holdWriter');
  assert(held, 'Forwarded holding writer is named');
  assert.equal(typeof held.metadata.workerRequestId, 'number');
  assert.equal(typeof held.metadata.workerTimestamp, 'number');
  assert(held.timestamp - Number(held.metadata.workerTimestamp) >= 100, 'Worker time survives delayed main receipt');
  type Phase = { phase: string; outcome: string; startedAt: number; finishedAt: number; durationMs: number };
  type Transaction = { id: string; boundary: string; phases: Phase[] };
  const holding = held.metadata.transaction as Transaction;
  assert.deepEqual(holding.phases.map((p) => p.phase), ['begin', 'body', 'commit']);
  assert(holding.phases[1].durationMs >= 600);
  const waiting = transactionEvents.filter((e) => !e.metadata.workerKind)
    .map((e) => e.metadata.transaction as Transaction)
    .find((t) => t.phases[0].durationMs >= 200);
  assert(waiting, 'Contending main transaction names its BEGIN acquisition wait');
  assert.equal(waiting.phases[0].outcome, 'acquired');
  const assertContentionIntervals = (holder: Transaction, waiter: Transaction) => {
    const heldBody = holder.phases[1], waitingBegin = waiter.phases[0];
    assert(heldBody.startedAt <= waitingBegin.finishedAt && waitingBegin.startedAt <= heldBody.finishedAt, 'Known holder body overlaps the waiter BEGIN interval');
    assert(heldBody.finishedAt <= waiter.phases[1].startedAt, 'Holder body completes before waiter body entry');
  };
  assertContentionIntervals(holding, waiting);
  const lateCommitStamp = structuredClone(holding);
  lateCommitStamp.phases[2].finishedAt = waiting.phases[1].finishedAt + 1000;
  assertContentionIntervals(lateCommitStamp, waiting);
  const unrelated = structuredClone(holding);
  for (const phase of unrelated.phases) { phase.startedAt += 10_000; phase.finishedAt += 10_000; }
  assert.throws(() => assertContentionIntervals(unrelated, waiting), /holder body overlaps/);
  db.exec('PRAGMA busy_timeout=10');
  const second = await hold(650);
  assert.throws(() => withBusyRetry(() => db.transaction(() => {
    db.run('INSERT INTO contention VALUES (?)', 'must not commit');
  }, 'immediate')()), /locked|busy/i);
  await second.call;
  const retry = events.filter((e) => e.message === 'sqlite.busy_retry');
  assert.deepEqual(retry.filter((e) => e.metadata.phase === 'sleep').map((e) => e.metadata.requestedMs), [25, 50]);
  assert(retry.some((e) => e.metadata.operationPhase === 'begin' && e.metadata.outcome === 'exhausted'));
  assert(retry.every((e) => typeof e.metadata.transactionId === 'string'));
  db.exec('PRAGMA busy_timeout=5000');
  const third = await hold(500);
  assert.equal(await runMessageSearchMerge(path).promise, 'merged');
  await third.call;
  const fourth = await hold(500);
  assert.equal(await mirrorNeoWorkspaceProjectsAsync({ getDbPath: () => path, getDatabase: () => db } as never, []), false);
  await fourth.call;
  for (const workerKind of ['message-search-merge', 'project-mirror']) {
    const log = events.find((e) => e.metadata.workerKind === workerKind && e.metadata.event === 'slow');
    assert(log, `${workerKind} forwards slow SQL`);
    assert.equal(typeof log.metadata.workerTimestamp, 'number');
    assert.equal(typeof log.metadata.workerRequestId, 'string');
  }
  const workerSummaries = events.filter((event) => event.metadata.workerKind && event.metadata.event === 'summary');
  assert(workerSummaries.length >= 2, 'Real workers publish window summaries');
  assert(workerSummaries.some((event) => event.metadata.reason === 'interval'));
  assert(workerSummaries.some((event) => event.metadata.reason === 'close'));
  assert(workerSummaries.every((event) => !('workerOperation' in event.metadata) && !('workerRequestId' in event.metadata)), 'Window summaries must not claim a single request identity');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM contention').get() as { n: number }).n, 5);
  const summary = { sourceCommit: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(), runtime: Bun.version, synthetic: true, holding, waiting, holderRequestId: held.metadata.workerRequestId, workerTimestamp: held.metadata.workerTimestamp, receivedAt: held.timestamp, retry: retry.map((e) => e.metadata), forwardedWorkers: ['db-gateway-write', 'message-search-merge', 'project-mirror'], rows: 5, orderingControls: { lateCommitStampAccepted: true, disjointHolderRejected: true }, workerSummaries: workerSummaries.map((event) => event.metadata) };
  writeFileSync(join(root, 'observed.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await gateway.close();
  db.close();
  off();
  writeFileSync(join(root, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
