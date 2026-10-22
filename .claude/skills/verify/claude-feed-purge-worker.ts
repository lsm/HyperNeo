import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
import { seedWorkFeedDeleteCorpus } from '../../../packages/daemon/tests/helpers/work-feed-delete-corpus.ts';
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
  surface: 'app-wired work.feed.claude job with independent system.health WebSocket RPC',
  workload: '1200 synthetic full stored tool results plus existing FTS/vector cleanup triggers',
  controlledSlowStatement: 'one synthetic BEFORE DELETE trigger runs an 32000000-row recursive SQL expression once',
  notProofOfProductionPhysicalCause: true,
  runtime: Bun.version,
};
const off = subscribeToStructuredLogs((event) => {
  if (measuring && ['hyperneo:daemon:sqlite.worker', 'hyperneo:daemon:sqlite.query'].includes(event.module ?? '')) metrics.push(event);
});
try {
  app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), disableWorktrees: true, disableGoalProcessing: true, sqlQueryObservability: { slowThresholdMs: 250, summaryIntervalMs: 300000, maxQueryGroups: 256, summaryQueryLimit: 20 } }, verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  seedWorkFeedDeleteCorpus(db, 1200, 8192);
  db.exec(`CREATE TABLE synthetic_purge_cost(used INTEGER);
    INSERT INTO synthetic_purge_cost VALUES(0);
    CREATE TRIGGER synthetic_purge_cost BEFORE DELETE ON message_search_content
    WHEN OLD.kind='claude' AND (SELECT used FROM synthetic_purge_cost)=0 BEGIN
      UPDATE synthetic_purge_cost SET used=1;
      SELECT sum(n) FROM (WITH RECURSIVE cost(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM cost WHERE n<32000000) SELECT n FROM cost);
    END;`);
  const storedDigest = () => {
    const hash = createHash('sha256');
    for (const row of db.prepare('SELECT m.id, COALESCE(b.sdk_message, m.sdk_message) AS body FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq ORDER BY m.id').iterate()) hash.update(JSON.stringify(row));
    return hash.digest('hex');
  };
  evidence.storedBefore = storedDigest();
  evidence.codexBefore = db.prepare("SELECT COUNT(*) n FROM message_search_content WHERE kind='codex'").get();
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
  const job = app.jobQueue.enqueue({ queue: 'work.feed.claude', payload: { scope: 'claude' }, runAt: Date.now() });
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
  evidence.job = result;
  evidence.storedAfter = storedDigest();
  evidence.remaining = db.prepare('SELECT kind, COUNT(*) n FROM message_search_content GROUP BY kind').all();
  evidence.probeRan = db.prepare('SELECT used FROM synthetic_purge_cost').get();
  assert.equal(result.status, 'completed');
  assert.equal(evidence.storedBefore, evidence.storedAfter, 'stored full bodies changed');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM message_search_content WHERE kind='claude'").get()?.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM message_search_content WHERE kind='codex'").get()?.n, 120);
  assert.equal((evidence.probeRan as { used: number }).used, 1);
  console.log(JSON.stringify({ run, maxLagMs, maxHealthMs: evidence.maxHealthMs, jobMs: evidence.jobMs }));
  assert(maxLagMs < 1000, `main event loop blocked ${maxLagMs.toFixed(3)}ms`);
  assert(Number(evidence.maxHealthMs) < 250, 'independent health exceeded 250ms');
} finally {
  if (timer) clearInterval(timer);
  probe?.kill();
  await app?.cleanup();
  off();
  globalThis.Worker = nativeWorker;
  writeFileSync(join(run, 'evidence/purge.json'), JSON.stringify(evidence, null, 2));
}
