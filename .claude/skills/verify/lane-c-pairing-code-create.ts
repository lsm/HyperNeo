import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  if (!/SELECT\s+COUNT\(\*\)[\s\S]*FROM\s+paired_devices|SELECT\s+1\s+FROM\s+paired_devices|human_device_resets|INSERT\s+INTO\s+pairing_codes/i.test(args[0])) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return (...values: unknown[]) => {
      if (measuring && ['get', 'all', 'iterate', 'run', 'values'].includes(String(key))) {
        mainSqlAttempts++;
        throw new Error('pairing code creation SQL reached main');
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
        worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic committed code creation reply lost; outcome unknown', cancelable: true }));
        return;
      }
      receive?.call(worker, event);
    });
    worker.postMessage = ((message: { id: number; op?: string; lane?: string; args?: unknown }) => {
      if (message.op === 'pairing.createCode.write') {
        assert.equal(message.lane, 'write'); commandPosts++;
        if (rejectNextWrite) {
          rejectNextWrite = false;
          queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic code creation admission rejected before commit', cancelable: true })));
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
type Receipt = { ok: boolean; reason?: string; codeId: string; code: string; expiresAt: number; approval: string };
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
  const count = () => inspect(() => (raw.prepare('SELECT COUNT(*) AS n FROM pairing_codes').get() as { n: number }).n);
  const check = (receipt: Receipt) => inspect(() => {
    assert.equal(receipt.ok, true); assert(/^[A-Z2-7]{10}$/.test(receipt.code));
    const row = raw.prepare('SELECT code_hash, approved_at, expires_at FROM pairing_codes WHERE id=?').get(receipt.codeId) as { code_hash: string; approved_at: number | null; expires_at: number };
    assert.equal(row.code_hash, createHash('sha256').update(receipt.code).digest('hex')); assert.equal(row.expires_at, receipt.expiresAt); assert.equal(row.approved_at !== null, receipt.approval === 'approved');
    assert(!JSON.stringify(raw.prepare('SELECT * FROM pairing_codes').all()).includes(receipt.code));
  });
  const base = `http://127.0.0.1:${app.server.port}`;
  const connect = async (credential?: string) => {
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const transport = new WebSocketClientTransport({ url: base.replace('http','ws') + '/ws', autoReconnect: false, createSocket: (url) => credential ? new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } }) : new WebSocket(url) });
    transports.push(transport); hub.registerTransport(transport); await transport.initialize(); return hub;
  };
  const local = await connect();
  const create = (name: string, hub = local) => hub.request<Receipt>('operation.invoke', { name: 'device.pair.create', input: { kind: 'human', name } });
  const pair = async (receipt: Receipt) => {
    const response = await nativeFetch(base + '/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: receipt.code, name: 'Synthetic human' }) });
    assert.equal(response.status, 200); return await response.json() as { deviceId: string; credential: string };
  };
  const cli = async (kind = 'human') => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const child = spawn('bun', [join(root, 'packages/cli/main.ts'), 'pair', '--kind', kind, '--name', 'Synthetic CLI'], { cwd: root, env: { ...process.env, HYPERNEO_SESSION_DOOR: join(run, 'data/session-door.sock') }, stdio: ['ignore','pipe','pipe'] });
    let output = ''; let errorText = '';
    child.stdout!.on('data', (chunk) => { output += String(chunk); }); child.stderr!.on('data', (chunk) => { errorText += String(chunk); });
    const exit = await new Promise<number>((done, fail) => { child.once('error', fail); child.once('close', (code) => done(code ?? -1)); });
    let receipt: Receipt; try { receipt = JSON.parse(output); } catch { throw new Error('Synthetic CLI did not return JSON; exit ' + exit); }
    assert.equal(exit, receipt.ok ? 0 : 1); assert.equal(errorText.includes('ENOTFOUND'), false); return receipt;
  };
  let previous = performance.now(); let maxLoopLagMs = 0;
  timer = setInterval(() => { const now = performance.now(); maxLoopLagMs = Math.max(maxLoopLagMs, now - previous - 5); previous = now; }, 5);
  measuring = true;
  const coldAt = performance.now(); let first: Receipt;
  try { first = await create('Synthetic bootstrap'); } catch (error) { evidence.coldError = String(error); throw error; }
  evidence.coldMs = performance.now() - coldAt; assert.equal(first.approval, 'approved'); check(first); evidence.bootstrapApprovedAndCommitted = true;
  const firstDevice = await pair(first); const human = await connect(firstDevice.credential);
  const pending = await create('Synthetic pending'); assert.equal(pending.approval, 'pending'); check(pending); evidence.unpairedBecomesPending = true;
  const trusted = await create('Synthetic approved', human); assert.equal(trusted.approval, 'approved'); check(trusted); evidence.activeHumanApproves = true;
  const warmAt = performance.now(); const beforeConcurrent = count();
  const warm = await Promise.all(Array.from({ length: 5 }, (_, i) => create(`Synthetic concurrent ${i}`)));
  warm.forEach((r) => { assert.equal(r.approval, 'pending'); check(r); }); assert.equal(new Set(warm.map((r) => r.codeId)).size, 5); assert.equal(count(), beforeConcurrent + 5); evidence.concurrentMs = performance.now() - warmAt; evidence.concurrentReceipts = 5;
  const cliAt = performance.now(); const cliPending = await cli(); assert.equal(cliPending.approval, 'pending'); check(cliPending); evidence.cliRoundTripMs = performance.now() - cliAt; evidence.realSessionDoorPending = true;
  inspect(() => repo.revokeDevice(firstDevice.deviceId, Date.now())); const beforeRefusal = count();
  assert.match((await create('Synthetic stale approver', human)).reason!, /^no_human_device/); assert.match((await create('Synthetic missing human')).reason!, /^no_human_device/); assert.match((await cli()).reason!, /^no_human_device/); assert.equal(count(), beforeRefusal); evidence.currentRevokedAndMissingHumanRefused = true;
  inspect(() => raw.prepare('INSERT INTO human_device_resets(id, reset_at, devices_json) VALUES (?, ?, ?)').run('synthetic-reset', Date.now(), '[]'));
  const recovery = await cli(); assert.equal(recovery.approval, 'approved'); check(recovery); assert.match((await cli('relay')).reason!, /^no_human_device/); evidence.realSessionDoorRecoveryHumanOnly = true;
  const replacement = await pair(recovery); const replacementHub = await connect(replacement.credential);
  raw.exec('CREATE TABLE synthetic_code_lock(value INTEGER); INSERT INTO synthetic_code_lock VALUES(0)');
  lock = new SQLite(app.db.getDbPath()); lock.exec('BEGIN IMMEDIATE'); lock.prepare('UPDATE synthetic_code_lock SET value=1').run();
  lock.prepare('UPDATE paired_devices SET revoked_at=? WHERE id=?').run(Date.now(), replacement.deviceId);
  const beforeHeld = count(); let settled = false; const heldAt = performance.now(); const held = create('Synthetic queued approver', replacementHub).finally(() => { settled = true; });
  await new Promise((done) => setTimeout(done, 20)); assert.equal(settled, false); assert.equal(count(), beforeHeld);
  const healthAt = performance.now(); assert.equal((await local.request<{ status: string }>('system.health', {})).status, 'ok'); evidence.healthWhileHeldMs = performance.now() - healthAt;
  const outside = (raw.prepare('SELECT value FROM synthetic_code_lock').get() as { value: number }).value; const inside = (lock.prepare('SELECT value FROM synthetic_code_lock').get() as { value: number }).value;
  assert.equal(outside, 0); assert.equal(inside, 1); evidence.writerIsolation = { outside, inside };
  lock.exec('COMMIT'); lock.close(); lock = undefined; assert.match((await held).reason!, /^no_human_device/); assert.equal(count(), beforeHeld); evidence.heldMs = performance.now() - heldAt; evidence.queuedApprovalRechecksRevocation = true;
  inspect(() => { const code = repo.createCode('human', null, true, Date.now()); repo.redeem(code.code, 'Synthetic fixture human', Date.now()); });
  const beforeRollback = count(); raw.exec("CREATE TRIGGER reject_synthetic_code BEFORE INSERT ON pairing_codes WHEN NEW.name='Synthetic rollback' BEGIN SELECT RAISE(ABORT, 'synthetic code insert failure'); END");
  evidence.rollbackFailure = await create('Synthetic rollback').then(() => 'unexpected success', String); assert.match(String(evidence.rollbackFailure), /insert failure/); assert.equal(count(), beforeRollback); raw.exec('DROP TRIGGER reject_synthetic_code');
  rejectNextWrite = true; evidence.beforeCommitFailure = await create('Synthetic before commit').then(() => 'unexpected success', String); assert.match(String(evidence.beforeCommitFailure), /before commit/); assert.equal(count(), beforeRollback);
  const beforePosts = commandPosts; loseNextReceipt = true; evidence.lostReceiptFailure = await create('Synthetic lost receipt').then(() => 'unexpected success', String); assert.match(String(evidence.lostReceiptFailure), /outcome unknown/); assert.equal(count(), beforeRollback + 1);
  await new Promise((done) => setTimeout(done, 100)); assert.equal(commandPosts, beforePosts + 1); assert.equal(count(), beforeRollback + 1); evidence.unknownOutcomeNotReplayed = true;
  const recovered = await create('Synthetic writer recovered'); check(recovered); assert.equal(count(), beforeRollback + 2); evidence.writerRecovered = true;
  assert.equal(mainSqlAttempts, 0); evidence.maxLoopLagMs = maxLoopLagMs; assert(maxLoopLagMs < 1000);
  evidence.latencyUnder250ms = [evidence.coldMs, evidence.concurrentMs, evidence.healthWhileHeldMs, evidence.heldMs].every((ms) => Number(ms) < 250); assert.equal(evidence.latencyUnder250ms, true);
  evidence.rssBytes = process.memoryUsage().rss; evidence.walBytes = statSync(`${app.db.getDbPath()}-wal`).size;
} finally {
  measuring = false; if (timer) clearInterval(timer); if (lock) { try { lock.exec('ROLLBACK'); } catch {} lock.close(); }
  try { await Promise.all(transports.map((transport) => transport.close())); await Promise.all([...processors].map((processor) => processor.stop())); await app?.cleanup(); }
  finally { SQLite.prototype.prepare = prepare; JobQueueProcessor.prototype.start = start; globalThis.Worker = NativeWorker; globalThis.fetch = nativeFetch; evidence.mainSqlAttempts = mainSqlAttempts; evidence.timings = timings; writeFileSync(join(run, 'evidence/pairing-code-create.json'), JSON.stringify(evidence, null, 2)); }
}
console.log('ok pairing code RPC/CLI receipts commit on the writer with current authorization and no main SQL or replay');
