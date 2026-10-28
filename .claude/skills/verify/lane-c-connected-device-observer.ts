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
const { pairingRevokeWrites } = await import('../../../packages/daemon/src/storage/repositories/pairing-revoke-write.ts');
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
let loseNextReceipt = false;
let commandPosts = 0;
let readPosts = 0;
let readOutage = false;
let holdNextReadReply = false;
let holdInactiveId: string | null = null;
let heldReply: (() => void) | undefined;
let heldBatch: string[] = [];
let heldResult: string[] = [];
const notified: string[] = [];
const unsubscribe = onDeviceRevoked((id) => notified.push(id));
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
    const sent = new Map<number, { at: number; bytes: number; op: string; hold: boolean; ids: string[] }>();
    const lost = new Set<number>(); let receive: ((event: MessageEvent) => void) | null = null;
    Object.defineProperty(worker, 'onmessage', { configurable: true, get: () => receive, set: (handler: typeof receive) => { receive = handler; } });
    worker.addEventListener('message', (event) => {
      const data = event.data; const request = sent.get(data.id);
      if (request) {
        sent.delete(data.id);
        if (!data.error) {
          const at = performance.now(); const encoded = JSON.stringify(data.result);
          timings.push({ roundTripMs: at - request.at, requestBytes: request.bytes, replyBytes: Buffer.byteLength(encoded), encodeMs: performance.now() - at });
          if (request.op === 'pairing.connectedDevices.read' && (request.hold || (holdInactiveId && data.result.includes(holdInactiveId)))) {
            heldBatch = request.ids; heldResult = data.result; holdInactiveId = null;
            heldReply = () => { heldReply = undefined; receive?.call(worker, event); }; return;
          }
        }
      }
      if (lost.delete(data.id) && !data.error) { worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic committed revocation reply lost; outcome unknown', cancelable: true })); return; }
      receive?.call(worker, event);
    });
    worker.postMessage = ((message: { id: number; op?: string; lane?: string; args?: unknown }) => {
      if (message.op === 'pairing.connectedDevices.read') {
        assert.equal(message.lane, 'read'); readPosts++;
        const input = message.args as { method: string; args: [string[]] }; assert.equal(input.method, 'inactive');
        if (readOutage) { queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic connected-device reader unavailable', cancelable: true }))); return; }
        const hold = holdNextReadReply; holdNextReadReply = false;
        sent.set(message.id, { at: performance.now(), bytes: Buffer.byteLength(JSON.stringify(message.args)), op: message.op, hold, ids: [...input.args[0]] });
      }
      if (message.op === 'pairing.revokeDevice.write') {
        assert.equal(message.lane, 'write'); commandPosts++;
        sent.set(message.id, { at: performance.now(), bytes: Buffer.byteLength(JSON.stringify(message.args)), op: message.op, hold: false, ids: [] });
        if (loseNextReceipt) { loseNextReceipt = false; lost.add(message.id); }
      }
      post(message);
    }) as typeof worker.postMessage;
  }
  return worker;
} as unknown as typeof Worker;
globalThis.fetch = (() => { throw new Error('External HTTP refused by observer fixture'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const evidence: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const wait = async (predicate: () => boolean, ms = 3000) => { const until = performance.now() + ms; while (!predicate() && performance.now() < until) await sleep(5); return predicate(); };
try {
  JobQueueProcessor.prototype.start = function () { processors.add(this); return start.call(this); };
  try { app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false }); }
  finally { JobQueueProcessor.prototype.start = start; }
  assert.notEqual(app.server.port, 8399); await Promise.all([...processors].map((p) => p.stop()));
  const raw = app.db.getDatabase(); mainConnection = raw; await waitForSdkBodyCopy(raw);
  const repo = new DevicePairingRepository(raw);
  const inspect = <T>(fn: () => T): T => { const previous = measuring; measuring = false; try { return fn(); } finally { measuring = previous; } };
  const seed = (kind: 'human' | 'relay' = 'relay') => inspect(() => { const code = repo.createCode(kind, null, true, Date.now()); return repo.redeem(code.code, 'Synthetic observer device', Date.now())!; });
  const actor = seed('human'); const victim = seed(); const ghost = seed();
  const connect = async (credential?: string) => {
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app!.server.port}/ws`, autoReconnect: false, createSocket: (url) => credential ? new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } }) : new WebSocket(url) });
    let closed = false; transport.onConnectionChange((state) => { if (state === 'disconnected') closed = true; });
    transports.push(transport); hub.registerTransport(transport); await transport.initialize(); return { hub, transport, closed: () => closed };
  };
  const human = await connect(actor.credential); const first = await connect(victim.credential); const second = await connect(victim.credential); const unknown = await connect();
  const departed = await connect(ghost.credential); await departed.transport.close(); assert(await wait(() => app!.transport.getClientCount() === 4));
  const cached = raw.prepare('SELECT 1 FROM paired_devices WHERE id = ? AND revoked_at IS NULL'); measuring = true;
  assert.throws(() => cached.get(actor.device.id), /revocation SQL reached main/);
  assert.throws(() => raw.prepare('UPDATE paired_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), victim.device.id), /revocation SQL reached main/);
  assert.equal(mainSqlAttempts, 2); mainSqlAttempts = 0; evidence.mainGuardSelfCheckPassed = true;
  let previous = performance.now(); let maxLoopLagMs = 0;
  timer = setInterval(() => { const now = performance.now(); maxLoopLagMs = Math.max(maxLoopLagMs, now - previous - 5); previous = now; }, 5);
  holdNextReadReply = true; const detected = await wait(() => heldReply !== undefined, 2500); evidence.nativeObserverDetected = detected;
  if (detected) {
    assert.deepEqual([...heldBatch].sort(), [actor.device.id, victim.device.id].sort()); evidence.onlyActualConnectedIdsDeduplicated = true;
    const before = readPosts; const at = performance.now(); await sleep(2200); assert.equal(readPosts, before); evidence.singleFlightWhileReplyHeldMs = performance.now() - at;
    const healthAt = performance.now(); assert.equal((await human.hub.request<{ status: string }>('system.health', {})).status, 'ok'); evidence.healthWhileHeldMs = performance.now() - healthAt;
    assert.equal(first.closed(), false); assert.equal(second.closed(), false); heldReply!(); await sleep(20);
  }
  readOutage = true; loseNextReceipt = true; const readsBeforeOutage = readPosts;
  const revoke = (id: string) => app!.db.gateway.call(pairingRevokeWrites, 'revoke', id, { source: 'mcp', principal: 'session-door' }, Date.now());
  evidence.lostReceiptError = await revoke(victim.device.id).then(() => 'unexpected success', String); assert.match(String(evidence.lostReceiptError), /outcome unknown/);
  assert.equal(inspect(() => repo.isActiveDevice(victim.device.id)), false); assert.equal(commandPosts, 1); await sleep(2200);
  evidence.readAdmissionsDuring2200msOutage = readPosts - readsBeforeOutage; assert(Number(evidence.readAdmissionsDuring2200msOutage) <= 3);
  assert.equal(first.closed(), false); assert.equal(second.closed(), false); evidence.unconfirmedDevicesRemainOpen = true;
  readOutage = false; const recoveryAt = performance.now(); const closed = await wait(() => first.closed() && second.closed(), 4000);
  evidence.connectionsClosedAfterReadRecovery = closed; assert.equal(closed, true, 'persisted inactive devices must disconnect after the reader recovers'); evidence.recoveryMs = performance.now() - recoveryAt;
  assert(detected); assert.equal(human.closed(), false); assert.equal(unknown.closed(), false); evidence.activeAndUnpairedRemainOpen = true; assert.equal(commandPosts, 1); evidence.noMutationReplay = true;
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const child = spawn('bun', [join(root, 'packages/cli/main.ts'), 'devices'], { cwd: root, env: { ...process.env, HYPERNEO_SESSION_DOOR: join(run, 'data/session-door.sock') }, stdio: ['ignore','pipe','pipe'] });
  let output = ''; child.stdout!.on('data', (chunk) => { output += String(chunk); }); child.stderr!.resume();
  const exit = await new Promise<number>((done, fail) => { child.once('error', fail); child.once('close', (code) => done(code ?? -1)); }); assert.equal(exit, 0);
  const listed = JSON.parse(output) as { ok: boolean; devices: { id: string; revokedAt: number | null }[] }; assert(listed.ok); assert.equal(typeof listed.devices.find((d) => d.id === victim.device.id)?.revokedAt, 'number'); evidence.realCliConfirmsPersistedRevocation = true;
  const late = seed(); const lateClient = await connect(late.credential); holdInactiveId = late.device.id; assert.deepEqual(await revoke(late.device.id), { ok: true });
  assert(await wait(() => heldReply !== undefined)); assert(heldResult.includes(late.device.id)); assert.equal(lateClient.closed(), false); assert(!notified.includes(late.device.id));
  let transportStopped = false; const closeTransport = app.transport.close.bind(app.transport);
  app.transport.close = async () => { await closeTransport(); transportStopped = true; heldReply?.(); };
  evidence.walBytes = statSync(`${app.db.getDbPath()}-wal`).size; await app.cleanup(); app = undefined; assert(transportStopped); assert(!notified.includes(late.device.id));
  const afterClose = readPosts; await sleep(1200); assert.equal(readPosts, afterClose); evidence.cleanupStopsPollsAndLateNotification = true;
  assert.equal(mainSqlAttempts, 0); assert(maxLoopLagMs < 1000); evidence.maxLoopLagMs = maxLoopLagMs; evidence.rssBytes = process.memoryUsage().rss; evidence.readAdmissions = readPosts; evidence.writeAdmissions = commandPosts;
} finally {
  measuring = false; if (timer) clearInterval(timer);
  try { heldReply?.(); await Promise.all(transports.map((t) => t.close())); await Promise.all([...processors].map((p) => p.stop())); await app?.cleanup(); }
  finally { unsubscribe(); SQLite.prototype.prepare = prepare; JobQueueProcessor.prototype.start = start; globalThis.Worker = NativeWorker; globalThis.fetch = nativeFetch; evidence.mainSqlAttempts = mainSqlAttempts; evidence.timings = timings; writeFileSync(join(run, 'evidence/connected-device-observer.json'), JSON.stringify(evidence, null, 2)); }
}
console.log('ok connected-device observer reads off main, stays single-flight and low-rate, closes only confirmed inactive devices and stops with its transport');
