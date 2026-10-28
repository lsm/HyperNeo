import { createHash } from 'node:crypto';
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
const { daemonPairingLimiter } = await import('../../../packages/daemon/src/lib/pairing/pairing-limiter.ts');
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
  if (!/UPDATE\s+pairing_codes\s+SET\s+(?:used_at|approved_at)|INSERT\s+INTO\s+paired_devices|human_device_resets|SELECT\s+1\s+FROM\s+pairing_codes/i.test(args[0])) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return (...values: unknown[]) => {
      if (measuring && ['get', 'all', 'iterate', 'run', 'values'].includes(String(key))) {
        mainSqlAttempts++;
        throw new Error('pairing redemption SQL reached main');
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
        worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic committed redemption reply lost; outcome unknown', cancelable: true }));
        return;
      }
      receive?.call(worker, event);
    });
    worker.postMessage = ((message: { id: number; op?: string; lane?: string; args?: unknown }) => {
      if (message.op === 'pairing.redeemCode.write') {
        assert.equal(message.lane, 'write'); commandPosts++;
        if (rejectNextWrite) {
          rejectNextWrite = false;
          queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic redemption admission rejected before commit', cancelable: true })));
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
  const seed = (approved = true) => inspect(() => repo.createCode('human', 'Synthetic phone', approved, Date.now()));
  const codeRow = (id: string) => inspect(() => ({ ...(raw.prepare('SELECT used_at, approved_at FROM pairing_codes WHERE id = ?').get(id) as { used_at: number | null; approved_at: number | null }) }));
  const deviceCount = () => inspect(() => (raw.prepare('SELECT COUNT(*) AS n FROM paired_devices').get() as { n: number }).n);
  const recoveryOpen = () => inspect(() => repo.humanRecoveryOpen());
  const reset = (id: string) => inspect(() => raw.prepare('INSERT INTO human_device_resets(id, reset_at, devices_json) VALUES (?, ?, ?)').run(id, Date.now(), '[]'));
  const base = `http://127.0.0.1:${app.server.port}`;
  const post = (code: string, name = 'Synthetic phone', browser = false) => nativeFetch(base + '/pair', { method: 'POST', headers: { 'content-type': 'application/json', ...(browser ? { origin: base } : {}) }, body: JSON.stringify({ code, name }) });
  const connect = async (credential?: string) => {
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const transport = new WebSocketClientTransport({ url: base.replace('http', 'ws') + '/ws', autoReconnect: false, createSocket: (url) => credential ? new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } }) : new WebSocket(url) });
    transports.push(transport); hub.registerTransport(transport); await transport.initialize(); return hub;
  };
  const health = await connect();
  const first = seed();
  let previous = performance.now(); let maxLoopLagMs = 0;
  timer = setInterval(() => { const now = performance.now(); maxLoopLagMs = Math.max(maxLoopLagMs, now - previous - 5); previous = now; }, 5);
  measuring = true;
  const coldAt = performance.now();
  const firstResponse = await post(first.code.toLowerCase());
  evidence.coldMs = performance.now() - coldAt; evidence.firstStatus = firstResponse.status;
  assert.equal(firstResponse.status, 200);
  const firstBody = await firstResponse.json() as { deviceId: string; credential: string; kind: string };
  assert.equal(firstBody.kind, 'human'); assert.match(firstBody.credential, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(codeRow(first.id).used_at, null);
  const storedHash = inspect(() => (raw.prepare('SELECT secret_hash FROM paired_devices WHERE id=?').get(firstBody.deviceId) as { secret_hash: string }).secret_hash);
  assert.equal(storedHash, createHash('sha256').update(firstBody.credential).digest('hex'));
  assert(!inspect(() => JSON.stringify(raw.prepare('SELECT * FROM paired_devices').all())).includes(firstBody.credential)); evidence.nativeCredentialStoredHashed = true;
  const authenticated = await connect(firstBody.credential);
  assert.equal((await authenticated.request<{ ok: boolean }>('operation.invoke', { name: 'device.pair.pending', input: {} })).ok, true); evidence.nativeCredentialAuthenticates = true;
  const browserCode = seed(); const browserResponse = await post(browserCode.code, 'Synthetic browser', true); assert.equal(browserResponse.status, 200);
  const browserBody = await browserResponse.json() as { deviceId: string; kind: string; credential?: string };
  assert.equal(browserBody.kind, 'human'); assert.equal(browserBody.credential, undefined);
  const cookie = browserResponse.headers.get('set-cookie')!; assert.match(cookie, /^hyperneo_device=[A-Za-z0-9_-]{43};/); assert(cookie.includes('HttpOnly')); assert(cookie.includes('SameSite=Strict')); assert(cookie.includes('Max-Age=34560000'));
  evidence.browserCookieRetained = true;
  const duplicate = seed(); const warmAt = performance.now(); const duplicateReplies = await Promise.all([post(duplicate.code), post(duplicate.code)]);
  assert.deepEqual(duplicateReplies.map((r) => r.status).sort(), [200, 401]); evidence.concurrentMs = performance.now() - warmAt; evidence.concurrentWinnerCount = 1;
  const pending = seed(false);
  for (let i = 0; i < 6; i++) { const response = await post(pending.code); assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'awaiting_approval' }); }
  assert.equal(codeRow(pending.id).used_at, null); evidence.pending403DoesNotRateLimit = true;
  const expired = seed(); inspect(() => raw.prepare('UPDATE pairing_codes SET expires_at = ? WHERE id = ?').run(Date.now() - 1, expired.id)); assert.equal((await post(expired.code)).status, 401); assert.equal(codeRow(expired.id).used_at, null); evidence.expiredRefused = true;
  reset('synthetic-recovery'); const replacementA = seed(); const replacementB = seed(); const beforeRecovery = deviceCount();
  const replacements = await Promise.all([post(replacementA.code), post(replacementB.code)]); assert.deepEqual(replacements.map((r) => r.status).sort(), [200, 403]); assert.equal(deviceCount(), beforeRecovery + 1); assert.equal(recoveryOpen(), false); evidence.oneRecoveryWinnerAndPeerInvalidated = true;
  raw.exec('CREATE TABLE synthetic_redeem_lock(value INTEGER); INSERT INTO synthetic_redeem_lock VALUES(0)');
  const heldCode = seed(); lock = new SQLite(app.db.getDbPath()); lock.exec('BEGIN IMMEDIATE'); lock.prepare('UPDATE synthetic_redeem_lock SET value=1').run();
  let settled = false; const heldAt = performance.now(); const held = post(heldCode.code).finally(() => { settled = true; });
  await new Promise((done) => setTimeout(done, 20)); assert.equal(settled, false); assert.equal(codeRow(heldCode.id).used_at, null);
  const healthAt = performance.now(); assert.equal((await health.request<{ status: string }>('system.health', {})).status, 'ok'); evidence.healthWhileHeldMs = performance.now() - healthAt;
  const outside = (raw.prepare('SELECT value FROM synthetic_redeem_lock').get() as { value: number }).value; const inside = (lock.prepare('SELECT value FROM synthetic_redeem_lock').get() as { value: number }).value;
  assert.equal(outside, 0); assert.equal(inside, 1); evidence.writerIsolation = { outside, inside };
  lock.exec('ROLLBACK'); lock.close(); lock = undefined; assert.equal((await held).status, 200); assert.notEqual(codeRow(heldCode.id).used_at, null); evidence.heldMs = performance.now() - heldAt;
  reset('synthetic-rollback'); const rollback = seed(); const rollbackPeer = seed(); const beforeRollback = deviceCount();
  raw.exec("CREATE TRIGGER reject_synthetic_device BEFORE INSERT ON paired_devices WHEN NEW.name='Synthetic rollback' BEGIN SELECT RAISE(ABORT, 'synthetic device insert failure'); END");
  const rolledBack = await post(rollback.code, 'Synthetic rollback'); assert.equal(rolledBack.status, 500); assert.equal(codeRow(rollback.id).used_at, null); assert.notEqual(codeRow(rollbackPeer.id).approved_at, null); assert.equal(recoveryOpen(), true); assert.equal(deviceCount(), beforeRollback); evidence.claimAndRecoveryRolledBack = true;
  raw.exec('DROP TRIGGER reject_synthetic_device');
  const before = seed(); rejectNextWrite = true; const beforeFailure = await post(before.code); assert.equal(beforeFailure.status, 500); assert.equal(codeRow(before.id).used_at, null); assert.equal(deviceCount(), beforeRollback); assert.equal(rejectNextWrite, false); evidence.beforeCommitFailureStatus = 500;
  const lost = seed(); const postsBeforeLost = commandPosts; const devicesBeforeLost = deviceCount(); loseNextReceipt = true;
  const lostResponse = await post(lost.code); assert.equal(lostResponse.status, 500); assert.equal(loseNextReceipt, false); assert.notEqual(codeRow(lost.id).used_at, null); assert.equal(deviceCount(), devicesBeforeLost + 1);
  await new Promise((done) => setTimeout(done, 100)); assert.equal(commandPosts, postsBeforeLost + 1); assert.equal(deviceCount(), devicesBeforeLost + 1); evidence.lostReceiptStatus = 500; evidence.unknownOutcomeNotReplayed = true;
  const recovery = seed(); assert.equal((await post(recovery.code)).status, 200); evidence.writerRecovered = true;
  daemonPairingLimiter.reset();
  for (let i = 0; i < 5; i++) assert.equal((await post('INVALIDCODE')).status, 401);
  assert.equal((await post('INVALIDCODE')).status, 429); evidence.failureRateLimitRetained = true;
  assert.equal(mainSqlAttempts, 0); evidence.maxLoopLagMs = maxLoopLagMs; assert(maxLoopLagMs < 1000);
  evidence.latencyUnder250ms = [evidence.coldMs, evidence.concurrentMs, evidence.healthWhileHeldMs, evidence.heldMs].every((ms) => Number(ms) < 250); assert.equal(evidence.latencyUnder250ms, true);
  evidence.rssBytes = process.memoryUsage().rss; evidence.walBytes = statSync(`${app.db.getDbPath()}-wal`).size;
} finally {
  measuring = false; if (timer) clearInterval(timer); if (lock) { try { lock.exec('ROLLBACK'); } catch {} lock.close(); }
  try { await Promise.all(transports.map((transport) => transport.close())); await Promise.all([...processors].map((processor) => processor.stop())); await app?.cleanup(); }
  finally {
    SQLite.prototype.prepare = prepare; JobQueueProcessor.prototype.start = start; globalThis.Worker = NativeWorker; globalThis.fetch = nativeFetch;
    evidence.mainSqlAttempts = mainSqlAttempts; evidence.timings = timings;
    writeFileSync(join(run, 'evidence/pairing-redeem.json'), JSON.stringify(evidence, null, 2));
  }
}
console.log('ok HTTP pairing redemption commits one device before success, preserving recovery/cookies/limits without main SQL or replay');
