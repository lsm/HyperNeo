import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session } from '@hyperneo/shared';
import type { SessionSchedule } from '@hyperneo/shared/types/session-schedule';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.equal(process.env[key], undefined);
for (const name of ['home', 'workspace', 'bin', 'evidence']) mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { JobQueueProcessor } = await import('../../../packages/daemon/src/storage/job-queue-processor.ts');
const { Database: SQLite } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const NativeWorker = globalThis.Worker;
const nativeFetch = globalThis.fetch;
const start = JobQueueProcessor.prototype.start;
const prepare = SQLite.prototype.prepare;
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
let measuring = false;
let mainSqlAttempts = 0;
let rejectNextWrite = false;
let loseNextReceipt = false;
const timings: { roundTripMs: number; requestBytes: number; replyBytes: number; encodeMs: number }[] = [];
SQLite.prototype.prepare = function (...args) {
  const statement = Reflect.apply(prepare, this, args);
  if (!/\bsession_schedules\b/i.test(args[0]) && !/(?:INSERT\s+INTO|SELECT\s+\*\s+FROM)\s+job_queue\b/i.test(args[0])) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return (...values: unknown[]) => {
      if (measuring && ['get', 'all', 'iterate', 'run', 'values'].includes(String(key))) {
        mainSqlAttempts++;
        throw new Error('session schedule creation SQL reached main');
      }
      return Reflect.apply(value, target, values);
    };
  } });
};
globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
  const worker = new NativeWorker(url, options);
  if (String(url).endsWith('/db-gateway-worker.ts')) {
    const post = worker.postMessage.bind(worker);
    const sent = new Map<number, { at: number; bytes: number }>();
    const lost = new Set<number>();
    let receive: ((event: MessageEvent) => void) | null = null;
    Object.defineProperty(worker, 'onmessage', { configurable: true, get: () => receive, set: (handler: typeof receive) => { receive = handler; } });
    worker.addEventListener('message', (event) => {
      const { data } = event;
      const request = sent.get(data.id);
      if (request) {
        sent.delete(data.id);
        if (!data.error) {
          const at = performance.now(); const encoded = JSON.stringify(data.result);
          timings.push({ roundTripMs: at - request.at, requestBytes: request.bytes, replyBytes: Buffer.byteLength(encoded), encodeMs: performance.now() - at });
        }
      }
      if (lost.delete(data.id) && !data.error) {
        worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic committed schedule reply lost; outcome unknown', cancelable: true }));
        return;
      }
      receive?.call(worker, event);
    });
    worker.postMessage = ((message: { id: number; op?: string; lane?: string; args?: unknown }) => {
      if (message.op === 'session.schedule.create.write') {
        assert.equal(message.lane, 'write');
        if (rejectNextWrite) {
          rejectNextWrite = false;
          queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic schedule admission rejected before commit', cancelable: true })));
          return;
        }
        sent.set(message.id, { at: performance.now(), bytes: Buffer.byteLength(JSON.stringify(message.args)) });
        if (loseNextReceipt) { loseNextReceipt = false; lost.add(message.id); }
      }
      post(message);
    }) as typeof worker.postMessage;
  }
  return worker;
} as unknown as typeof Worker;
globalThis.fetch = (() => { throw new Error('External HTTP refused by schedule fixture'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
let lock: InstanceType<typeof SQLite> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const evidence: Record<string, unknown> = {};
try {
  JobQueueProcessor.prototype.start = function () { processors.add(this); return start.call(this); };
  try {
    app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  } finally { JobQueueProcessor.prototype.start = start; }
  assert.notEqual(app.server.port, 8399);
  await Promise.all([...processors].map((processor) => processor.stop()));
  const session: Session = { id: 'schedule-recipient', title: 'Synthetic reminder target', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active',
    config: { queryMode: 'manual', model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0 },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0, titleGenerated: true, titleSetBy: 'user' } };
  await app.db.createSession(session);
  const raw = app.db.getDatabase();
  await waitForSdkBodyCopy(raw);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport); await transport.initialize();
  const create = (note: string, cadence: unknown = { kind: 'every', everyMs: 3_600_000 }) => hub.request<{ ok: boolean; schedule: SessionSchedule; reason?: string }>('operation.invoke', { name: 'schedule.session.create', input: { target: { adapter: 'hyperneo', id: session.id }, cadence, note } });
  const inspect = <T>(fn: () => T): T => { const previous = measuring; measuring = false; try { return fn(); } finally { measuring = previous; } };
  const counts = () => inspect(() => ({ schedules: (raw.prepare('SELECT COUNT(*) AS n FROM session_schedules').get() as { n: number }).n, jobs: (raw.prepare("SELECT COUNT(*) AS n FROM job_queue WHERE queue='sessionSchedule.fire'").get() as { n: number }).n }));
  const pair = (schedule: SessionSchedule) => inspect(() => {
    const stored = raw.prepare('SELECT id,pending_job_id,next_run_at FROM session_schedules WHERE id=?').get(schedule.id);
    assert.deepEqual({ ...stored }, { id: schedule.id, pending_job_id: schedule.pendingJobId, next_run_at: schedule.nextRunAt });
    const job = raw.prepare('SELECT status,run_at,payload FROM job_queue WHERE id=?').get(schedule.pendingJobId) as { status: string; run_at: number; payload: string };
    assert.equal(job.status, 'pending'); assert.equal(job.run_at, schedule.nextRunAt); assert.deepEqual(JSON.parse(job.payload), { scheduleId: schedule.id });
    return { schedule: { ...stored }, job: { ...job, payload: JSON.parse(job.payload) } };
  });
  let previous = performance.now(); let maxLoopLagMs = 0;
  timer = setInterval(() => { const now = performance.now(); maxLoopLagMs = Math.max(maxLoopLagMs, now - previous - 5); previous = now; }, 5);
  measuring = true;
  const coldAt = performance.now();
  let first: Awaited<ReturnType<typeof create>>;
  try { first = await create('cold reminder'); } catch (error) { evidence.coldError = String(error); throw error; }
  evidence.coldMs = performance.now() - coldAt;
  assert.equal(first.ok, true); assert.equal(first.schedule.status, 'active'); evidence.firstReceipt = first; evidence.firstCommittedPair = pair(first.schedule);
  const warmAt = performance.now();
  const replies = await Promise.all(Array.from({ length: 5 }, (_, i) => create(`warm reminder ${i}`)));
  replies.forEach((reply) => { assert.equal(reply.ok, true); pair(reply.schedule); });
  evidence.concurrentWarmMs = performance.now() - warmAt;
  assert.equal(new Set(replies.map((reply) => reply.schedule.pendingJobId)).size, 5);
  const invalid = await create('invalid', { kind: 'every', everyMs: 1000 });
  assert.equal(invalid.ok, false); assert.match(invalid.reason!, /invalid_cadence/);
  evidence.invalidCadenceRefused = true;
  raw.exec('CREATE TABLE synthetic_schedule_lock(value INTEGER); INSERT INTO synthetic_schedule_lock VALUES(0)');
  lock = new SQLite(app.db.getDbPath()); lock.exec('BEGIN IMMEDIATE'); lock.prepare('UPDATE synthetic_schedule_lock SET value=1').run();
  let settled = false; const heldAt = performance.now();
  const held = create('held writer reminder').finally(() => { settled = true; });
  await new Promise((done) => setTimeout(done, 20)); assert.equal(settled, false);
  const healthAt = performance.now(); assert.equal((await hub.request<{ status: string }>('system.health', {})).status, 'ok'); evidence.healthWhileHeldMs = performance.now() - healthAt;
  evidence.writerIsolation = { outside: (raw.prepare('SELECT value FROM synthetic_schedule_lock').get() as { value: number }).value, inside: (lock.prepare('SELECT value FROM synthetic_schedule_lock').get() as { value: number }).value };
  assert.deepEqual(evidence.writerIsolation, { outside: 0, inside: 1 });
  lock.exec('ROLLBACK'); lock.close(); lock = undefined;
  pair((await held).schedule); evidence.heldWriteMs = performance.now() - heldAt;
  const before = counts();
  raw.exec("CREATE TRIGGER reject_fixture_schedule BEFORE INSERT ON job_queue WHEN NEW.queue='sessionSchedule.fire' BEGIN SELECT RAISE(ABORT,'synthetic schedule enqueue failure'); END");
  evidence.rollbackFailure = await create('rollback').then(() => 'unexpected success', String);
  assert.match(String(evidence.rollbackFailure), /synthetic schedule enqueue failure/); assert.deepEqual(counts(), before);
  raw.exec('DROP TRIGGER reject_fixture_schedule');
  rejectNextWrite = true; evidence.beforeCommitFailure = await create('before commit').then(() => 'unexpected success', String);
  assert.match(String(evidence.beforeCommitFailure), /rejected before commit/); assert.deepEqual(counts(), before);
  loseNextReceipt = true; evidence.lostReceiptFailure = await create('lost receipt').then(() => 'unexpected success', String);
  assert.match(String(evidence.lostReceiptFailure), /outcome unknown/);
  await new Promise((done) => setTimeout(done, 100));
  assert.deepEqual(counts(), { schedules: before.schedules + 1, jobs: before.jobs + 1 }); evidence.unknownOutcomeNotReplayed = true;
  const recovered = await create('writer recovered'); pair(recovered.schedule); evidence.writerRecovered = true;
  assert.deepEqual(counts(), { schedules: before.schedules + 2, jobs: before.jobs + 2 });
  assert.equal((await hub.request<{ status: string }>('system.health', {})).status, 'ok');
  evidence.finalCommittedCounts = counts(); evidence.committedPairs = counts().schedules;
  evidence.mainSqlAttempts = mainSqlAttempts; assert.equal(mainSqlAttempts, 0);
  evidence.maxLoopLagMs = maxLoopLagMs; assert(maxLoopLagMs < 1000);
  evidence.latencyUnder250ms = [evidence.coldMs, evidence.concurrentWarmMs, evidence.healthWhileHeldMs, evidence.heldWriteMs].every((ms) => Number(ms) < 250); assert.equal(evidence.latencyUnder250ms, true);
  evidence.rssBytes = process.memoryUsage().rss; evidence.walBytes = statSync(`${app.db.getDbPath()}-wal`).size;
} finally {
  measuring = false; if (timer) clearInterval(timer); if (lock) { try { lock.exec('ROLLBACK'); } catch {} lock.close(); }
  await transport?.close(); await Promise.all([...processors].map((processor) => processor.stop())); await app?.cleanup();
  SQLite.prototype.prepare = prepare; JobQueueProcessor.prototype.start = start; globalThis.Worker = NativeWorker; globalThis.fetch = nativeFetch;
  evidence.mainSqlAttempts = mainSqlAttempts; evidence.timings = timings;
  writeFileSync(join(run, 'evidence/session-schedule-create.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok ordinary reminder RPC commits one schedule/wake pair on the writer without main fallback or unknown-outcome replay');
