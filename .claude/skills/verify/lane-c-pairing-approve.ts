import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
const { DevicePairingRepository } = await import('../../../packages/daemon/src/storage/repositories/device-pairing-repository.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const NativeWorker = globalThis.Worker;
const nativeFetch = globalThis.fetch;
const start = JobQueueProcessor.prototype.start;
const prepare = SQLite.prototype.prepare;
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
const transports: InstanceType<typeof WebSocketClientTransport>[] = [];
const timings: { roundTripMs: number; requestBytes: number; replyBytes: number; encodeMs: number }[] = [];
let measuring = false;
let mainSqlAttempts = 0;
let rejectNextWrite = false;
let loseNextReceipt = false;
let commandPosts = 0;
SQLite.prototype.prepare = function (...args) {
  const statement = Reflect.apply(prepare, this, args);
  if (!/SELECT\s+1\s+FROM\s+paired_devices|UPDATE\s+pairing_codes\s+SET\s+approved_at/i.test(args[0])) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return (...values: unknown[]) => {
      if (measuring && ['get', 'all', 'iterate', 'run', 'values'].includes(String(key))) {
        mainSqlAttempts++;
        throw new Error('pairing approval SQL reached main');
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
        worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic committed approval reply lost; outcome unknown', cancelable: true }));
        return;
      }
      receive?.call(worker, event);
    });
    worker.postMessage = ((message: { id: number; op?: string; lane?: string; args?: unknown }) => {
      if (message.op === 'pairing.approveCode.write') {
        assert.equal(message.lane, 'write'); commandPosts++;
        if (rejectNextWrite) {
          rejectNextWrite = false;
          queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic approval admission rejected before commit', cancelable: true })));
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
globalThis.fetch = (() => { throw new Error('External HTTP refused by pairing fixture'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
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
  const raw = app.db.getDatabase(); await waitForSdkBodyCopy(raw);
  const repo = new DevicePairingRepository(raw);
  const inspect = <T>(fn: () => T): T => { const previous = measuring; measuring = false; try { return fn(); } finally { measuring = previous; } };
  const seed = () => repo.createCode('human', 'Synthetic phone', false, Date.now());
  const activeCode = repo.createCode('human', 'Synthetic approver', true, Date.now());
  const active = repo.redeem(activeCode.code, 'Synthetic approver', Date.now())!;
  const connect = async (credential?: string) => {
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app!.server.port}/ws`, autoReconnect: false, createSocket: (url) => credential ? new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } }) : new WebSocket(url) });
    transports.push(transport); hub.registerTransport(transport); await transport.initialize();
    return hub;
  };
  const human = await connect(active.credential);
  const unpaired = await connect();
  const approve = (id: string, hub = human) => hub.request<{ ok: boolean; reason?: string }>('operation.invoke', { name: 'device.pair.approve', input: { codeId: id } });
  const approvedAt = (id: string) => inspect(() => (raw.prepare('SELECT approved_at FROM pairing_codes WHERE id = ?').get(id) as { approved_at: number | null }).approved_at);
  const redeem = (code: string) => nativeFetch(`http://127.0.0.1:${app!.server.port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Synthetic phone' }) });
  const first = seed(); assert.equal((await redeem(first.code)).status, 403);
  let previous = performance.now(); let maxLoopLagMs = 0;
  timer = setInterval(() => { const now = performance.now(); maxLoopLagMs = Math.max(maxLoopLagMs, now - previous - 5); previous = now; }, 5);
  measuring = true;
  const at = performance.now();
  try { evidence.firstReceipt = await approve(first.id); } catch (error) { evidence.coldError = String(error); throw error; }
  evidence.coldMs = performance.now() - at;
  assert.deepEqual(evidence.firstReceipt, { ok: true }); assert.notEqual(approvedAt(first.id), null);
  assert.equal((await redeem(first.code)).status, 200); evidence.approvedCodeRedeems = true;
  const duplicate = seed(); const warmAt = performance.now();
  const replies = await Promise.all([approve(duplicate.id), approve(duplicate.id)]);
  assert.equal(replies.filter((r) => r.ok).length, 1); assert(replies.some((r) => r.reason?.startsWith('not_pending')));
  evidence.concurrentMs = performance.now() - warmAt; evidence.concurrentWinnerCount = 1;
  const denied = seed(); assert.match((await approve(denied.id, unpaired)).reason!, /not_paired/); assert.equal(approvedAt(denied.id), null); evidence.unpairedRefused = true;
  const expired = seed(); raw.prepare('UPDATE pairing_codes SET expires_at = ? WHERE id = ?').run(Date.now() - 1, expired.id);
  assert.match((await approve(expired.id)).reason!, /not_pending/); assert.equal(approvedAt(expired.id), null); evidence.expiredRefused = true;
  const revokedCode = repo.createCode('human', 'Synthetic revoked approver', true, Date.now());
  const revoked = repo.redeem(revokedCode.code, 'Synthetic revoked approver', Date.now())!;
  const stale = await connect(revoked.credential); repo.revokeDevice(revoked.device.id, Date.now());
  assert.match((await approve(denied.id, stale)).reason!, /not_paired/); assert.equal(approvedAt(denied.id), null); evidence.staleApproverRefused = true;
  raw.exec('CREATE TABLE synthetic_pairing_lock(value INTEGER); INSERT INTO synthetic_pairing_lock VALUES(0)');
  const heldCode = seed(); lock = new SQLite(app.db.getDbPath()); lock.exec('BEGIN IMMEDIATE'); lock.prepare('UPDATE synthetic_pairing_lock SET value=1').run();
  let settled = false; const heldAt = performance.now(); const held = approve(heldCode.id).finally(() => { settled = true; });
  await new Promise((done) => setTimeout(done, 20)); assert.equal(settled, false); assert.equal(approvedAt(heldCode.id), null);
  const healthAt = performance.now(); assert.equal((await unpaired.request<{ status: string }>('system.health', {})).status, 'ok'); evidence.healthWhileHeldMs = performance.now() - healthAt;
  const outside = (raw.prepare('SELECT value FROM synthetic_pairing_lock').get() as { value: number }).value;
  const inside = (lock.prepare('SELECT value FROM synthetic_pairing_lock').get() as { value: number }).value;
  assert.equal(outside, 0); assert.equal(inside, 1); evidence.writerIsolation = { outside, inside };
  lock.exec('ROLLBACK'); lock.close(); lock = undefined; assert.equal((await held).ok, true); assert.notEqual(approvedAt(heldCode.id), null); evidence.heldMs = performance.now() - heldAt;
  const rollback = seed(); raw.exec(`CREATE TRIGGER reject_synthetic_approval AFTER UPDATE OF approved_at ON pairing_codes WHEN NEW.id='${rollback.id}' BEGIN SELECT RAISE(ABORT, 'synthetic approval trigger failure'); END`);
  evidence.rollbackFailure = await approve(rollback.id).then(() => 'unexpected success', String); assert.match(String(evidence.rollbackFailure), /trigger failure/); assert.equal(approvedAt(rollback.id), null);
  raw.exec('DROP TRIGGER reject_synthetic_approval');
  const before = seed(); rejectNextWrite = true; evidence.beforeCommitFailure = await approve(before.id).then(() => 'unexpected success', String); assert.match(String(evidence.beforeCommitFailure), /before commit/); assert.equal(approvedAt(before.id), null);
  const lost = seed(); const beforePosts = commandPosts; loseNextReceipt = true;
  evidence.lostReceiptFailure = await approve(lost.id).then(() => 'unexpected success', String); assert.match(String(evidence.lostReceiptFailure), /outcome unknown/); assert.notEqual(approvedAt(lost.id), null);
  await new Promise((done) => setTimeout(done, 100)); assert.equal(commandPosts, beforePosts + 1); evidence.unknownOutcomeNotReplayed = true;
  const recovery = seed(); assert.equal((await approve(recovery.id)).ok, true); assert.notEqual(approvedAt(recovery.id), null); evidence.writerRecovered = true;
  assert.equal(mainSqlAttempts, 0); evidence.maxLoopLagMs = maxLoopLagMs; assert(maxLoopLagMs < 1000);
  evidence.latencyUnder250ms = [evidence.coldMs, evidence.concurrentMs, evidence.healthWhileHeldMs, evidence.heldMs].every((ms) => Number(ms) < 250); assert.equal(evidence.latencyUnder250ms, true);
  evidence.rssBytes = process.memoryUsage().rss; evidence.walBytes = statSync(`${app.db.getDbPath()}-wal`).size;
} finally {
  measuring = false; if (timer) clearInterval(timer); if (lock) { try { lock.exec('ROLLBACK'); } catch {} lock.close(); }
  await Promise.all(transports.map((transport) => transport.close())); await Promise.all([...processors].map((processor) => processor.stop())); await app?.cleanup();
  SQLite.prototype.prepare = prepare; JobQueueProcessor.prototype.start = start; globalThis.Worker = NativeWorker; globalThis.fetch = nativeFetch;
  evidence.mainSqlAttempts = mainSqlAttempts; evidence.timings = timings;
  writeFileSync(join(run, 'evidence/pairing-approve.json'), JSON.stringify(evidence, null, 2));
}
console.log('ok paired-human approval commits on the writer before receipt, without main SQL or unknown-outcome replay');
