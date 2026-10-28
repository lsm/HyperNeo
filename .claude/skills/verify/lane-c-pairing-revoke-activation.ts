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
const { onDeviceRevoked } = await import('../../../packages/daemon/src/lib/pairing/upgrade-auth.ts');
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
let mainConnection: InstanceType<typeof SQLite> | undefined;
let mainSqlAttempts = 0;
let rejectNextWrite = false;
let loseNextReceipt = false;
let commandPosts = 0;
let readPosts = 0;
let observerReadPosts = 0;
let rejectReads = 0;
let rejectReadsUntilClose = false;
const notifications: string[] = [];
const unsubscribe = onDeviceRevoked((id) => notifications.push(id));
SQLite.prototype.prepare = function (...args) {
  const connection = this;
  const statement = Reflect.apply(prepare, this, args);
  if (!/SELECT\s+1\s+FROM\s+paired_devices|UPDATE\s+paired_devices\s+SET\s+revoked_at/i.test(args[0])) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return (...values: unknown[]) => {
      if (measuring && connection === mainConnection && ['get', 'all', 'iterate', 'run', 'values'].includes(String(key))) {
        mainSqlAttempts++;
        throw new Error('pairing revocation SQL reached main');
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
        worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic committed revocation reply lost; outcome unknown', cancelable: true }));
        return;
      }
      receive?.call(worker, event);
    });
    worker.postMessage = ((message: { id: number; op?: string; lane?: string; args?: unknown }) => {
      if (message.op === 'pairing.state.read' || message.op === 'pairing.connectedDevices.read') {
        assert.equal(message.lane, 'read');
        const foreground = message.op === 'pairing.state.read';
        if (foreground) readPosts++; else observerReadPosts++;
        if ((foreground && rejectReads > 0) || rejectReadsUntilClose) {
          if (foreground) rejectReads--;
          queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic revocation read unavailable', cancelable: true })));
          return;
        }
      }
      if (message.op === 'pairing.revokeDevice.write') {
        assert.equal(message.lane, 'write'); commandPosts++;
        const args = message.args as { method: string; args: [string, { source: string; principal?: string; device?: { deviceId: string; kind: string } }, number] };
        assert.equal(args.method, 'revoke'); assert.deepEqual(Object.keys(args.args[1]).sort(), ['device','principal','source']);
        assert.equal(typeof args.args[0], 'string'); assert.equal(typeof args.args[1].source, 'string'); assert.equal(typeof args.args[2], 'number');
        if (args.args[1].device) assert.deepEqual(Object.keys(args.args[1].device).sort(), ['deviceId','kind']);
        if (rejectNextWrite) {
          rejectNextWrite = false;
          queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic revocation admission rejected before commit', cancelable: true })));
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
type Receipt = { ok: boolean; reason?: string };
try {
  JobQueueProcessor.prototype.start = function () { processors.add(this); return start.call(this); };
  try {
    app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  } finally { JobQueueProcessor.prototype.start = start; }
  assert.notEqual(app.server.port, 8399);
  await Promise.all([...processors].map((processor) => processor.stop()));
  const raw = app.db.getDatabase(); mainConnection = raw; await waitForSdkBodyCopy(raw);
  const repo = new DevicePairingRepository(raw);
  const inspect = <T>(fn: () => T): T => { const previous = measuring; measuring = false; try { return fn(); } finally { measuring = previous; } };
  const seed = (kind: 'human' | 'relay' = 'relay') => inspect(() => { const code = repo.createCode(kind, null, true, Date.now()); return repo.redeem(code.code, 'Synthetic device', Date.now())!; });
  const active = (id: string) => inspect(() => repo.isActiveDevice(id));
  const actor = seed('human'); const target = seed();
  const connect = async (credential?: string) => {
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app!.server.port}/ws`, autoReconnect: false, createSocket: (url) => credential ? new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } }) : new WebSocket(url) });
    let closed = false; transport.onConnectionChange((state) => { if (state === 'disconnected') closed = true; });
    transports.push(transport); hub.registerTransport(transport); await transport.initialize();
    return { hub, closed: () => closed };
  };
  const human = await connect(actor.credential); const victim = await connect(target.credential); const local = await connect();
  const revoke = (id: string, connection = human) => connection.hub.request<Receipt>('operation.invoke', { name: 'device.revoke', input: { deviceId: id } });
  const wait = async (predicate: () => boolean) => { const until = performance.now() + 2000; while (!predicate()) { assert(performance.now() < until, 'synthetic observation deadline exceeded'); await new Promise((done) => setTimeout(done, 5)); } };
  const cli = async (args: string[]) => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const child = spawn('bun', [join(root, 'packages/cli/main.ts'), ...args], { cwd: root, env: { ...process.env, HYPERNEO_SESSION_DOOR: join(run, 'data/session-door.sock') }, stdio: ['ignore','pipe','pipe'] });
    let output = ''; child.stdout!.on('data', (chunk) => { output += String(chunk); }); child.stderr!.resume();
    const exit = await new Promise<number>((done, fail) => { child.once('error', fail); child.once('close', (code) => done(code ?? -1)); }); assert.equal(exit, 0);
    return JSON.parse(output) as Receipt & { devices?: { id: string; revokedAt: number | null }[] };
  };
  const cached = raw.prepare('SELECT 1 FROM paired_devices WHERE id = ? AND revoked_at IS NULL');
  measuring = true;
  assert.throws(() => cached.get(actor.device.id), /revocation SQL reached main/);
  assert.throws(() => raw.prepare('UPDATE paired_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), target.device.id), /revocation SQL reached main/);
  assert.equal(mainSqlAttempts, 2); mainSqlAttempts = 0; evidence.mainGuardSelfCheckPassed = true;
  let previous = performance.now(); let maxLoopLagMs = 0;
  timer = setInterval(() => { const now = performance.now(); maxLoopLagMs = Math.max(maxLoopLagMs, now - previous - 5); previous = now; }, 5);
  const coldAt = performance.now();
  try { assert.deepEqual(await revoke(target.device.id), { ok: true }); } catch(error) { evidence.rpcFailure = String(error); throw error; }
  evidence.coldMs = performance.now() - coldAt; assert.equal(active(target.device.id), false); await wait(victim.closed); assert(notifications.includes(target.device.id)); evidence.rpcCommitsAndCloses = true;
  const listed = await cli(['devices']); assert.equal(typeof listed.devices!.find((d) => d.id === target.device.id)?.revokedAt, 'number'); evidence.realCliReaderSeesRevocation = true;
  assert.match((await revoke(target.device.id)).reason!, /^not_found:/);
  const cliTarget = seed(); const cliVictim = await connect(cliTarget.credential); assert.deepEqual(await cli(['devices','revoke',cliTarget.device.id]), { ok: true }); await wait(cliVictim.closed); assert.equal(active(cliTarget.device.id), false); evidence.realCliRevokesAndCloses = true;
  const protectedTarget = seed();
  assert.match((await revoke(protectedTarget.device.id, local)).reason!, /^not_paired:/); assert.equal(active(protectedTarget.device.id), true); assert(!notifications.includes(protectedTarget.device.id)); evidence.unpairedRefused = true;
  const warmTargets = Array.from({ length: 5 }, () => seed()); const warmAt = performance.now();
  const receipts = await Promise.all(warmTargets.map((d) => revoke(d.device.id))); receipts.forEach((r) => assert.deepEqual(r, { ok: true })); warmTargets.forEach((d) => assert.equal(active(d.device.id), false)); evidence.concurrentMs = performance.now() - warmAt;
  raw.exec('CREATE TABLE synthetic_revoke_lock(value INTEGER); INSERT INTO synthetic_revoke_lock VALUES(0)');
  lock = new SQLite(app.db.getDbPath()); lock.exec('BEGIN IMMEDIATE'); lock.prepare('UPDATE synthetic_revoke_lock SET value=1').run();
  lock.prepare('UPDATE paired_devices SET revoked_at=? WHERE id=?').run(Date.now(), actor.device.id);
  let settled = false; const heldAt = performance.now(); const held = revoke(protectedTarget.device.id).finally(() => { settled = true; });
  await new Promise((done) => setTimeout(done, 20)); assert.equal(settled, false); assert.equal(active(protectedTarget.device.id), true);
  const healthAt = performance.now(); assert.equal((await local.hub.request<{ status: string }>('system.health', {})).status, 'ok'); evidence.healthWhileHeldMs = performance.now() - healthAt;
  const outside = (raw.prepare('SELECT value FROM synthetic_revoke_lock').get() as { value: number }).value; const inside = (lock.prepare('SELECT value FROM synthetic_revoke_lock').get() as { value: number }).value;
  assert.equal(outside, 0); assert.equal(inside, 1); evidence.writerIsolation = { outside, inside };
  lock.exec('COMMIT'); lock.close(); lock = undefined; assert.match((await held).reason!, /^not_paired:/); assert.equal(active(protectedTarget.device.id), true); assert(!notifications.includes(protectedTarget.device.id)); evidence.heldMs = performance.now() - heldAt; evidence.authorizationRecheckedAfterWait = true;
  const replacement = seed('human'); const nextHuman = await connect(replacement.credential);
  raw.exec("CREATE TRIGGER reject_synthetic_revoke AFTER UPDATE OF revoked_at ON paired_devices BEGIN SELECT RAISE(ABORT, 'synthetic revocation trigger failure'); END");
  evidence.rollbackFailure = await revoke(protectedTarget.device.id, nextHuman).then(() => 'unexpected success', String); assert.match(String(evidence.rollbackFailure), /trigger failure/); assert.equal(active(protectedTarget.device.id), true); assert(!notifications.includes(protectedTarget.device.id)); raw.exec('DROP TRIGGER reject_synthetic_revoke');
  rejectNextWrite = true; evidence.beforeCommitFailure = await revoke(protectedTarget.device.id, nextHuman).then(() => 'unexpected success', String); assert.match(String(evidence.beforeCommitFailure), /before commit/); assert.equal(active(protectedTarget.device.id), true); assert(!notifications.includes(protectedTarget.device.id));
  const lostVictim = await connect(protectedTarget.credential); const beforePosts = commandPosts; const beforeReads = readPosts; loseNextReceipt = true; rejectReads = 2;
  evidence.lostReceiptFailure = await revoke(protectedTarget.device.id, nextHuman).then(() => 'unexpected success', String); assert.match(String(evidence.lostReceiptFailure), /outcome unknown/); assert.equal(active(protectedTarget.device.id), false); await wait(lostVictim.closed);
  assert.equal(commandPosts, beforePosts + 1); assert.equal(readPosts, beforeReads + 3); assert(notifications.includes(protectedTarget.device.id)); evidence.readOnlyRetryClosesAfterLostReceipt = true;
  const recovered = seed(); assert.deepEqual(await revoke(recovered.device.id, nextHuman), { ok: true }); assert.equal(active(recovered.device.id), false); evidence.writerRecovered = true;
  {
    const delayedTarget = seed(); const delayedVictim = await connect(delayedTarget.credential);
    const writesBeforeOutage = commandPosts; const readsBeforeOutage = readPosts; const observerReadsBeforeOutage = observerReadPosts;
    loseNextReceipt = true; rejectReadsUntilClose = true; let settled = false;
    const delayed = revoke(delayedTarget.device.id, nextHuman).then(() => 'unexpected success', String).finally(() => { settled = true; });
    await new Promise((done) => setTimeout(done, 1000));
    const settledDuringOutage = settled; const foregroundReadsWithinOneSecond = readPosts - readsBeforeOutage;
    await new Promise((done) => setTimeout(done, 1200)); assert.equal(active(delayedTarget.device.id), false);
    evidence.persistentReadOutage = { rpcSettledWithinOneSecond: settledDuringOutage, readAdmissionsWithinOneSecond: foregroundReadsWithinOneSecond, observerReadAdmissionsDuring2200msOutage: observerReadPosts - observerReadsBeforeOutage, writeAdmissions: commandPosts - writesBeforeOutage, targetStillConnectedDuringOutage: !delayedVictim.closed(), persistedInactive: true };
    rejectReadsUntilClose = false;
    assert.match(await delayed, /outcome unknown/);
    try { await wait(delayedVictim.closed); } catch (error) { evidence.eventualClosureAfterReadRecovery = false; throw error; }
    assert.equal(commandPosts, writesBeforeOutage + 1); evidence.eventualClosureAfterReadRecovery = true;
    assert.equal(settledDuringOutage, true, 'persistent read failure must release the RPC caller without abandoning eventual socket closure');
    assert.equal(readPosts, readsBeforeOutage + 3); assert(observerReadPosts - observerReadsBeforeOutage >= 2); assert(observerReadPosts - observerReadsBeforeOutage <= 3);
    assert.equal(evidence.persistentReadOutage && (evidence.persistentReadOutage as { targetStillConnectedDuringOutage: boolean }).targetStillConnectedDuringOutage, true);
  }
  const shutdownTarget = seed(); const beforeShutdownReads = readPosts; const beforeShutdownWrites = commandPosts; loseNextReceipt = true; rejectReadsUntilClose = true;
  const closingCall = revoke(shutdownTarget.device.id, nextHuman).then(() => 'unexpected success', String);
  await wait(() => readPosts > beforeShutdownReads);
  evidence.walBytes = statSync(`${app.db.getDbPath()}-wal`).size;
  await Promise.all(transports.map((transport) => transport.close()));
  await app.cleanup(); app = undefined; assert.notEqual(await closingCall, 'unexpected success'); evidence.shutdownRpcRejected = true; assert(!notifications.includes(shutdownTarget.device.id)); assert.equal(commandPosts, beforeShutdownWrites + 1);
  const readsAfterClose = readPosts; await new Promise((done) => setTimeout(done, 80)); assert.equal(readPosts, readsAfterClose); evidence.cleanupStopsReadRetryWithoutNotification = true;
  assert.equal(mainSqlAttempts, 0); evidence.maxLoopLagMs = maxLoopLagMs; assert(maxLoopLagMs < 1000);
  evidence.latencyUnder250ms = [evidence.coldMs, evidence.concurrentMs, evidence.healthWhileHeldMs, evidence.heldMs].every((ms) => Number(ms) < 250); assert.equal(evidence.latencyUnder250ms, true);
  evidence.rssBytes = process.memoryUsage().rss; evidence.writeCommands = commandPosts; evidence.readCommands = readPosts; evidence.observerReadCommands = observerReadPosts;
} finally {
  measuring = false; if (timer) clearInterval(timer); if (lock) { try { lock.exec('ROLLBACK'); } catch {} lock.close(); }
  try { await Promise.all(transports.map((transport) => transport.close())); await Promise.all([...processors].map((processor) => processor.stop())); await app?.cleanup(); }
  finally { unsubscribe(); SQLite.prototype.prepare = prepare; JobQueueProcessor.prototype.start = start; globalThis.Worker = NativeWorker; globalThis.fetch = nativeFetch; evidence.mainSqlAttempts = mainSqlAttempts; evidence.timings = timings; writeFileSync(join(run, 'evidence/pairing-revoke-activation.json'), JSON.stringify(evidence, null, 2)); }
}
console.log('ok public revocation commits off main and closes connections after receipt reconciliation without write replay');
