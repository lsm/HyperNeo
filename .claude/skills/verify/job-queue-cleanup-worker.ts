import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { JOB_QUEUE_CLEANUP, LONG_HORIZON_AGENT_REMINDER_FIRE } from '../../../packages/daemon/src/lib/job-queue-constants.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
import { seedWorkFeedDeleteCorpus } from '../../../packages/daemon/tests/helpers/work-feed-delete-corpus.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { SDKBunWorkerBridge } from '../../../packages/daemon/tests/helpers/sdk-bun-worker-bridge.ts';

const run = resolve(process.argv[2]);
assert(run.startsWith('/private/tmp/'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')), 'requires fresh synthetic data');
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'home'), { recursive: true });
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const nativeWorker = globalThis.Worker;
if (process.env.VERIFY_WRITER_IPC === '1')
  globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
    return String(url).endsWith('/session-event-writer-worker.ts')
      ? new SDKBunWorkerBridge(String(url))
      : new nativeWorker(url, options);
  } as unknown as typeof Worker;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let probe: ReturnType<typeof spawn> | undefined;
let measuring = false;
const metrics: unknown[] = [];
const evidence: Record<string, unknown> = {
  surface: 'app-wired job_queue.cleanup job with independent system.health WebSocket RPC',
  workload: 'expired and retained synthetic jobs plus complete stored tool results',
  controlledSlowStatement: 'synthetic BEFORE DELETE trigger adds a 16000000-row recursive SQL expression to each cleanup family',
  notProofOfProductionPhysicalCause: true,
  runtime: Bun.version,
};
const mainTransactions: unknown[] = [];
const originalTransaction = Database.prototype.transaction;
Database.prototype.transaction = function (...args: Parameters<Database['transaction']>) {
  const stack = new Error('main transaction caller').stack;
  const transaction = Reflect.apply(originalTransaction, this, args);
  return new Proxy(transaction, { apply(target, self, values) {
    const started = performance.now();
    try { return Reflect.apply(target, self, values); }
    finally { if (measuring && performance.now() - started >= 250) mainTransactions.push({ ms: performance.now() - started, stack }); }
  } });
} as typeof Database.prototype.transaction;
const off = subscribeToStructuredLogs((event) => {
  if (measuring && ['hyperneo:daemon:sqlite.worker', 'hyperneo:daemon:sqlite.query'].includes(event.module ?? '')) metrics.push(event);
});
try {
  app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), disableWorktrees: true, disableGoalProcessing: true, sqlQueryObservability: { slowThresholdMs: 250, summaryIntervalMs: 300000, maxQueryGroups: 256, summaryQueryLimit: 20 } }, verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  seedWorkFeedDeleteCorpus(db, 12, 8192);
  const now = Date.now(), hour = 3600000;
  db.prepare('UPDATE job_queue SET run_at=? WHERE queue=? AND status=?').run(now+hour, JOB_QUEUE_CLEANUP, 'pending');
  const insert = db.prepare('INSERT INTO job_queue(id,queue,status,payload,priority,max_retries,retry_count,run_at,created_at,completed_at) VALUES(?,?,?,?,0,3,0,?,?,?)');
  for (const [id, queue, status, age] of [
    ['expired-completed', 'synthetic-expired', 'completed', 8*24*hour],
    ['expired-dead', 'synthetic-expired', 'dead', 8*24*hour],
    ['expired-failed', 'synthetic-expired', 'failed', 8*24*hour],
    ['expired-reminder', LONG_HORIZON_AGENT_REMINDER_FIRE, 'completed', 2*hour],
    ['keep-other-completed', 'synthetic-keep', 'completed', 2*hour],
    ['keep-reminder-completed', LONG_HORIZON_AGENT_REMINDER_FIRE, 'completed', hour/2],
    ['keep-reminder-dead', LONG_HORIZON_AGENT_REMINDER_FIRE, 'dead', 2*hour],
    ['keep-reminder-failed', LONG_HORIZON_AGENT_REMINDER_FIRE, 'failed', 2*hour],
    ['keep-old-pending', 'synthetic-keep', 'pending', 8*24*hour],
  ] as const) insert.run(id, queue, status, JSON.stringify({body:'complete synthetic result 🦊'.repeat(1000)}), now-Number(age), now-Number(age), now-Number(age));
  const keepJobs = () => db.prepare("SELECT id,queue,status,payload,completed_at FROM job_queue WHERE id LIKE 'keep-%' ORDER BY id").all();
  evidence.retainedJobsBefore = keepJobs();
  db.exec(`CREATE TRIGGER synthetic_cleanup_cost BEFORE DELETE ON job_queue
    WHEN OLD.id IN ('expired-completed','expired-reminder') BEGIN
      SELECT sum(n) FROM (WITH RECURSIVE cost(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM cost WHERE n<16000000) SELECT n FROM cost);
    END;`);
  const storedDigest = () => {
    const hash = createHash('sha256');
    for (const row of db.prepare('SELECT m.id, COALESCE(b.sdk_message, m.sdk_message) AS body FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq ORDER BY m.id').iterate()) hash.update(JSON.stringify(row));
    return hash.digest('hex');
  };
  evidence.storedBefore = storedDigest();
  evidence.searchBefore = db.prepare("SELECT kind,COUNT(*) n FROM message_search_content GROUP BY kind").all();
  const url = `ws://127.0.0.1:${app.server.port}/ws`;
  probe = spawn(process.execPath, ['-e', `const ws=new WebSocket(${JSON.stringify(url)});let stop=false,id=0,at=0;const samples=[];const send=()=>{if(stop){console.log(JSON.stringify({samples}));ws.close();return;}at=performance.now();ws.send(JSON.stringify({id:String(++id),type:'REQ',method:'system.health',data:{},sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}));};ws.onopen=()=>{console.log('READY');send();};ws.onmessage=e=>{const r=JSON.parse(e.data);if((r.requestId??r.id)!==String(id))return;if(r.error)throw new Error(JSON.stringify(r.error));samples.push(performance.now()-at);setTimeout(send,10);};process.stdin.on('data',()=>{stop=true;});setTimeout(()=>process.exit(2),60000).unref();`], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let probeOutput = '', probeErrors = '';
  probe.stdout!.on('data', (data) => { probeOutput += String(data); });
  probe.stderr!.on('data', (data) => { probeErrors += String(data); });
  const exited = new Promise((done, fail) => { probe!.once('exit', done); probe!.once('error', fail); });
  for (let i = 0; i < 500 && !probeOutput.includes('READY'); i++) await pause(10);
  assert(probeOutput.includes('READY'), probeErrors);
  let maxLagMs = 0, last = performance.now();
  timer = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - last - 10); last = now; }, 10);
  await pause(30);
  measuring = true;
  const job = app.jobQueue.enqueue({ queue: JOB_QUEUE_CLEANUP, payload: {}, runAt: Date.now() });
  const started = performance.now();
  app.jobProcessor.start();
  const deadline = Date.now() + 60000;
  let result = app.jobQueue.getJob(job.id)!;
  while (!['completed', 'dead'].includes(result.status) && Date.now() < deadline) {
    await pause(20);
    result = app.jobQueue.getJob(job.id)!;
  }
  evidence.jobMs = performance.now() - started;
  await app.jobProcessor.stop();
  await pause(30);
  measuring = false;
  clearInterval(timer); timer = undefined;
  probe.stdin!.end('stop');
  assert.equal(await exited, 0, probeErrors);
  const health = JSON.parse(probeOutput.trim().split('\n').at(-1)!).samples as number[];
  assert(health.length);
  evidence.maxLagMs = maxLagMs;
  evidence.maxHealthMs = Math.max(...health);
  evidence.healthReplies = health.length;
  evidence.metrics = metrics;
  evidence.mainTransactions = mainTransactions;
  evidence.maxConcurrent = Number(process.env.HYPERNEO_JOB_QUEUE_MAX_CONCURRENT ?? 5);
  evidence.responsivenessPass = maxLagMs < 1000 && Math.max(...health) < 250;
  evidence.job = result;
  evidence.storedAfter = storedDigest();
  evidence.remaining = db.prepare('SELECT kind, COUNT(*) n FROM message_search_content GROUP BY kind').all();
  evidence.syntheticTriggerSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='synthetic_cleanup_cost'").get();
  evidence.retainedJobsAfter = keepJobs();
  assert.equal(result.status, 'completed');
  assert.equal(evidence.storedBefore, evidence.storedAfter, 'stored full bodies changed');
  assert.deepEqual(evidence.retainedJobsAfter, evidence.retainedJobsBefore, 'retained jobs/payloads changed');
  assert.deepEqual(evidence.remaining, evidence.searchBefore, 'unrelated search rows changed');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM job_queue WHERE id LIKE 'expired-%'").get()?.n, 0);
  assert.equal((result.result as { deletedJobs: number }).deletedJobs, 4);
  assert.equal((metrics as { metadata: Record<string,unknown> }[]).filter((event) => event.metadata.operation === 'run' && String(event.metadata.normalizedSql).startsWith('delete from job_queue where') && Number(event.metadata.durationMs) >= 250).length, 2);
  console.log(JSON.stringify({ run, maxLagMs, maxHealthMs: evidence.maxHealthMs, jobMs: evidence.jobMs }));
  if (process.argv[3] === 'movement') {
    const slow = metrics as { message: string; metadata: Record<string, unknown> }[];
    assert(slow.some((event) => event.metadata.workerOperation === 'job-queue-cleanup' && event.metadata.workerKind === 'session-event-writer' && Number(event.metadata.durationMs) >= 250), 'target cleanup SQL did not execute on the existing writer');
    assert(!slow.some((event) => !event.metadata.workerKind && String(event.metadata.normalizedSql).startsWith('delete from job_queue where')), 'cleanup DELETE still ran on main');
    evidence.threadMovementVerified = true;
  } else {
  assert(maxLagMs < 1000, `main event loop blocked ${maxLagMs.toFixed(3)}ms`);
  assert(Number(evidence.maxHealthMs) < 250, 'independent health exceeded 250ms');
  }
} finally {
  if (timer) clearInterval(timer);
  probe?.kill();
  await app?.cleanup();
  off();
  globalThis.Worker = nativeWorker;
  Database.prototype.transaction = originalTransaction;
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify(evidence, null, 2));
}
