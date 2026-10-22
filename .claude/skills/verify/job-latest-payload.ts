import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { JobQueueRepository } from '../../../packages/daemon/src/storage/repositories/job-queue-repository.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const [mode, directory] = process.argv.slice(2);
const run = resolve(directory);
assert(['reproduce', 'verify'].includes(mode));
assert(run.startsWith('/private/tmp/'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'home'), { recursive: true });
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const report: Record<string, unknown> = { mode, runtime: Bun.version, syntheticOnly: true };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let probe: ReturnType<typeof spawn> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let measuring = false;
const calls: { queue: string; keys: string[]; ms: number; stack?: string }[] = [];
const statements: { sql: string; params: unknown[] }[] = [];
const originalRead = JobQueueRepository.prototype.getLatestByPayload;
const originalPrepare = Database.prototype.prepare;
JobQueueRepository.prototype.getLatestByPayload = function (queue, payload) {
  const started = performance.now();
  try { return originalRead.call(this, queue, payload); }
  finally { if (measuring) calls.push({ queue, keys: Object.keys(payload), ms: performance.now() - started, stack: new Error('synthetic caller').stack }); }
};
Database.prototype.prepare = function (sql: string) {
  const statement = originalPrepare.call(this, sql);
  if (!measuring || !sql.includes('ORDER BY created_at DESC, rowid DESC LIMIT 1')) return statement;
  return new Proxy(statement, { get(target, key) {
    if (key === 'get') return (...params: unknown[]) => { statements.push({ sql, params }); return Reflect.apply(target.get, target, params); };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
} as typeof Database.prototype.prepare;
const ws = { current: undefined as WebSocket | undefined };
try {
  app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  const put = db.prepare('INSERT INTO job_queue(id,queue,status,payload,priority,max_retries,retry_count,run_at,created_at,completed_at,error) VALUES(?,?,?,?,0,3,0,?,?,?,?)');
  const now = Date.now();
  const rows = 300000;
  const body = 'Complete synthetic stored report 🦊\n'.repeat(450);
  db.transaction(() => {
    for (let i = 0; i < rows; i++) {
      const payload = JSON.stringify({ to: { kind: 'session', sessionId: `other-${i}` }, sessionId: `other-${i}`, messageUuid: `other-${i}`, body });
      put.run(`synthetic-${i}`, i % 2 ? 'mailbox' : 'message_delivery', 'completed', payload, now, now + i, now, null);
    }
    put.run('target-old', 'mailbox', 'dead', JSON.stringify({ to: { sessionId: 'target' }, messageUuid: 'failed', body }), now, now, now, 'old error');
    put.run('target-new', 'mailbox', 'dead', JSON.stringify({ to: { sessionId: 'target' }, messageUuid: 'failed', body }), now, now, now, 'latest complete failure');
    put.run('delivery-error', 'message_delivery', 'dead', JSON.stringify({ sessionId: 'target', messageUuid: 'delivery-failed', body }), now, now, now, 'delivery error');
  })();
  const digest = () => {
    const hash = createHash('sha256');
    for (const row of db.prepare("SELECT id,queue,status,payload,error FROM job_queue WHERE id LIKE 'synthetic-%' OR id IN ('target-old','target-new','delivery-error') ORDER BY id").iterate()) hash.update(JSON.stringify(row));
    return hash.digest('hex');
  };
  report.storedBefore = digest();
  const url = `ws://127.0.0.1:${app.server.port}/ws`;
  ws.current = new WebSocket(url);
  await new Promise<void>((done, fail) => { ws.current!.onopen = () => done(); ws.current!.onerror = fail; });
  const socket = ws.current;
  const pending = new Map<string, (value: unknown) => void>();
  socket.onmessage = (event) => { const reply = JSON.parse(String(event.data)); pending.get(reply.requestId)?.(reply); };
  const rpc = (messageId: string) => new Promise<{ ms: number; reply: unknown }>((done, fail) => {
    const id = crypto.randomUUID(), start = performance.now();
    const timeout = setTimeout(() => fail(new Error('message.status timeout')), 30000);
    pending.set(id, (reply) => { pending.delete(id); clearTimeout(timeout); done({ ms: performance.now() - start, reply }); });
    socket.send(JSON.stringify({ id, type: 'REQ', method: 'operation.invoke', data: { name: 'message.status', input: { sessionId: 'target', messageId } }, sessionId: 'global', version: '1.0.0', timestamp: new Date().toISOString() }));
  });
  probe = spawn(process.execPath, ['-e', `const ws=new WebSocket(${JSON.stringify(url)});let stop=false,id=0,at=0;const samples=[];const send=()=>{if(stop){console.log(JSON.stringify({samples}));ws.close();return;}at=performance.now();ws.send(JSON.stringify({id:String(++id),type:'REQ',method:'system.health',data:{},sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}));};ws.onopen=()=>{console.log('READY');send();};ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.requestId!==String(id))return;if(r.error)throw new Error(JSON.stringify(r.error));samples.push(performance.now()-at);setTimeout(send,10);};process.stdin.on('data',()=>{stop=true;});setTimeout(()=>process.exit(2),60000).unref();`], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  probe.stdout!.on('data', (chunk) => { output += String(chunk); });
  probe.stderr!.on('data', (chunk) => { errors += String(chunk); });
  const exited = new Promise((done, fail) => { probe!.once('exit', done); probe!.once('error', fail); });
  for (let i = 0; i < 500 && !output.includes('READY'); i++) await pause(10);
  assert(output.includes('READY'), errors);
  let last = performance.now(), maxLagMs = 0;
  timer = setInterval(() => { const at = performance.now(); maxLagMs = Math.max(maxLagMs, at-last-10); last = at; }, 10);
  await pause(30);
  measuring = true;
  const results = [];
  for (const messageId of ['missing', 'failed']) { results.push({ messageId, ...await rpc(messageId) }); await pause(30); }
  measuring = false;
  clearInterval(timer); timer = undefined;
  probe.stdin!.end('stop');
  assert.equal(await exited, 0, errors);
  const health = JSON.parse(output.trim().split('\n').at(-1)!).samples as number[];
  const plans = statements.map(({ sql, params }) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params as string[]));
  report.results = results;
  report.calls = calls;
  report.plans = plans;
  report.maxLagMs = maxLagMs;
  report.maxHealthMs = Math.max(...health);
  report.rows = rows + 3;
  report.storedAfter = digest();
  assert.equal(report.storedAfter, report.storedBefore);
  assert.deepEqual((results[0].reply as { data: unknown }).data, { status: 'unknown' });
  assert.deepEqual((results[1].reply as { data: unknown }).data, { status: 'failed', reason: 'latest complete failure' });
  assert(calls.every(call => call.stack?.includes('readMessageEvidence')));
  console.log(JSON.stringify({ run, maxLagMs, maxHealthMs: report.maxHealthMs, rpcMs: results.map(r => r.ms), queryMs: calls.map(c => c.ms), plans }));
  if (mode === 'verify') { assert(maxLagMs < 250, `loop lag ${maxLagMs}ms`); assert(Number(report.maxHealthMs) < 250, 'health latency'); assert(results.every(r => r.ms < 250), 'message.status latency'); }
  else assert(results.some(r => r.ms > 250), 'synthetic query did not reproduce a hot-path breach');
} finally {
  if (timer) clearInterval(timer);
  probe?.kill(); ws.current?.close();
  await app?.cleanup();
  JobQueueRepository.prototype.getLatestByPayload = originalRead;
  Database.prototype.prepare = originalPrepare;
  writeFileSync(join(run, 'observed.json'), JSON.stringify(report, null, 2));
}
