import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
const { humanDeviceResetWrites } = await import('../../../packages/daemon/src/storage/repositories/human-device-reset-write.ts');
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
SQLite.prototype.prepare = function (...args) {
  const connection = this;
  const statement = Reflect.apply(prepare, this, args);
  if (!/UPDATE\s+paired_devices\s+SET\s+revoked_at|UPDATE\s+pairing_codes\s+SET\s+expires_at|INSERT\s+INTO\s+human_device_resets|INSERT\s+OR\s+IGNORE\s+INTO\s+neo_conversation|INSERT\s+INTO\s+neo_publications|SELECT\s+id\s+FROM\s+neo_conversation/i.test(args[0])) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return (...values: unknown[]) => {
      if (measuring && connection === mainConnection && ['get', 'all', 'iterate', 'run', 'values'].includes(String(key))) {
        mainSqlAttempts++;
        throw new Error('pairing human-reset SQL reached main');
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
        worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic committed human-reset reply lost; outcome unknown', cancelable: true }));
        return;
      }
      receive?.call(worker, event);
    });
    worker.postMessage = ((message: { id: number; op?: string; lane?: string; args?: unknown }) => {
      if (message.op === 'pairing.humanReset.write') {
        assert.equal(message.lane, 'write'); commandPosts++;
        assert.deepEqual(message.args && Object.keys(message.args).sort(), ['args', 'method']);
        const args = message.args as { method: string; args: [number] };
        assert.equal(args.method, 'reset'); assert.equal(args.args.length, 1); assert.equal(typeof args.args[0], 'number');
        if (rejectNextWrite) {
          rejectNextWrite = false;
          queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'synthetic human-reset admission rejected before commit', cancelable: true })));
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
type Receipt = { id: string; resetAt: number; conversationId: string; devices: { id: string; name: string }[] };

try {
  JobQueueProcessor.prototype.start = function () { processors.add(this); return start.call(this); };
  try {
    app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  } finally { JobQueueProcessor.prototype.start = start; }
  assert.notEqual(app.server.port, 8399); await Promise.all([...processors].map((p) => p.stop()));
  const raw = app.db.getDatabase(); mainConnection = raw; await waitForSdkBodyCopy(raw);
  const repo = new DevicePairingRepository(raw);
  const inspect = <T>(fn: () => T): T => { const previous = measuring; measuring = false; try { return fn(); } finally { measuring = previous; } };
  const seed = (kind: 'human' | 'relay' = 'human') => inspect(() => { const made = repo.createCode(kind, null, true, Date.now()); return repo.redeem(made.code, 'Synthetic reset device', Date.now())!; });
  const active = (id: string) => inspect(() => repo.isActiveDevice(id));
  const count = (table: 'neo_publications' | 'human_device_resets') => inspect(() => (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  const reset = () => app!.db.gateway.call(humanDeviceResetWrites, 'reset', Date.now());
  const humans = Array.from({ length: 21 }, () => seed()); const relay = seed('relay');
  const oldCode = inspect(() => repo.createCode('human', null, true, Date.now()));
  const connect = async (credential: string) => {
    const hub = new MessageHub({ defaultSessionId: 'global' });
    const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app!.server.port}/ws`, autoReconnect: false, createSocket: (url) => new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } }) });
    let closed = false; transport.onConnectionChange((state) => { if (state === 'disconnected') closed = true; });
    transports.push(transport); hub.registerTransport(transport); await transport.initialize(); return { hub, closed: () => closed };
  };
  const phone = await connect(humans[0].credential); const connectedRelay = await connect(relay.credential);
  const wait = async (predicate: () => boolean) => { const until = performance.now() + 2500; while (!predicate()) { assert(performance.now() < until, 'synthetic reset observation deadline exceeded'); await new Promise((done) => setTimeout(done, 5)); } };
  let reservationConversation: string | undefined;
  if (process.argv.includes('--conversation-reservation')) inspect(() => {
    const binding = raw.prepare("SELECT session_id AS id FROM neo_session_bindings WHERE kind = 'neo'").get() as { id: string } | null;
    const session = binding?.id ?? `neo:${randomUUID()}`;
    assert.match(session, /^neo:[0-9a-f-]{36}$/i); reservationConversation = session.slice(4);
    if (!binding) raw.prepare("INSERT INTO neo_session_bindings(session_id, concern_id, kind) VALUES (?, NULL, 'neo')").run(session);
    raw.exec('DELETE FROM neo_conversation');
  });
  const cached = raw.prepare("UPDATE paired_devices SET revoked_at = ? WHERE kind = 'human' AND revoked_at IS NULL"); measuring = true;
  assert.throws(() => cached.run(Date.now()), /human-reset SQL reached main/);
  assert.throws(() => raw.prepare('SELECT id FROM neo_conversation').get(), /human-reset SQL reached main/);
  assert.equal(mainSqlAttempts, 2); mainSqlAttempts = 0; evidence.mainGuardSelfCheckPassed = true;
  let previous = performance.now(); let maxLoopLagMs = 0;
  timer = setInterval(() => { const now = performance.now(); maxLoopLagMs = Math.max(maxLoopLagMs, now - previous - 5); previous = now; }, 5);
  const beforeNotices = count('neo_publications'); const beforeResets = count('human_device_resets'); const at = performance.now();
  let receipt: Receipt; try { receipt = await reset(); } catch (error) { evidence.commandFailure = String(error); throw error; }
  if (reservationConversation) {
    assert.equal(receipt.conversationId, reservationConversation);
    const stored = inspect(() => raw.prepare('SELECT id, created_at AS at FROM neo_conversation').get() as { id: string; at: number });
    assert.equal(stored.id, reservationConversation); assert(stored.at >= receipt.resetAt && stored.at <= Date.now()); evidence.boundConversationFallbackPreserved = true;
  }
  evidence.coldMs = performance.now() - at; assert.equal(receipt.devices.length, 21); assert.deepEqual(new Set(receipt.devices.map((d) => d.id)), new Set(humans.map((d) => d.device.id)));
  for (const human of humans) assert.equal(active(human.device.id), false);
  assert.equal(active(relay.device.id), true); assert.equal(count('neo_publications'), beforeNotices + 2); assert.equal(count('human_device_resets'), beforeResets + 1);
  assert.deepEqual(await repo.redeemAsync(oldCode.code, 'Expired synthetic code', Date.now()), { paired: null, awaitingApproval: false }); evidence.atomicReceiptAndCodeInvalidation = true;
  const page = await connectedRelay.hub.request<{ ok: boolean; items: { fullText: string }[] }>('operation.invoke', { name: 'neo.publication.read', input: { conversationId: receipt.conversationId, after: 0, limit: 100 } });
  assert(page.ok); const text = JSON.stringify(page.items); for (const human of humans) { assert(text.includes(human.device.id)); assert(!text.includes(human.credential)); }
  assert(!text.includes(relay.credential)); evidence.publicReaderRetainsChunkedNoticeWithoutSecrets = true;
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const child = spawn('bun', [join(root, 'packages/cli/main.ts'), 'devices'], { cwd: root, env: { ...process.env, HYPERNEO_SESSION_DOOR: join(run, 'data/session-door.sock') }, stdio: ['ignore','pipe','pipe'] });
  let output = ''; child.stdout!.on('data', (chunk) => { output += String(chunk); }); child.stderr!.resume();
  const exit = await new Promise<number>((done, fail) => { child.once('error', fail); child.once('close', (code) => done(code ?? -1)); }); assert.equal(exit, 0);
  const listed = JSON.parse(output) as { ok: boolean; devices: { id: string; revokedAt: number | null }[] }; assert(listed.ok);
  for (const human of humans) assert.equal(typeof listed.devices.find((d) => d.id === human.device.id)?.revokedAt, 'number');
  assert.equal(listed.devices.find((d) => d.id === relay.device.id)?.revokedAt, null); evidence.realCliRetainsDeviceHistory = true;
  await wait(phone.closed); assert.equal(connectedRelay.closed(), false); evidence.existingObserverSeesCommittedReset = true;
  const firstCode = inspect(() => repo.createCode('human', null, true, Date.now())); const secondCode = inspect(() => repo.createCode('human', null, true, Date.now()));
  assert((await repo.redeemAsync(firstCode.code, 'Synthetic replacement', Date.now())).paired); assert.deepEqual(await repo.redeemAsync(secondCode.code, 'Synthetic extra', Date.now()), { paired: null, awaitingApproval: true }); evidence.oneReplacementConsumesRecovery = true;
  const rollbackHumans = Array.from({ length: 21 }, () => seed()); const rollbackCode = inspect(() => repo.createCode('human', null, true, Date.now()));
  const rollbackNotices = count('neo_publications'); const rollbackResets = count('human_device_resets');
  if (reservationConversation) inspect(() => raw.exec('DELETE FROM neo_conversation'));
  raw.exec("CREATE TRIGGER reject_second_notice BEFORE INSERT ON neo_publications WHEN json_extract(NEW.payload_json, '$.fullText') LIKE '%(part 2)%' BEGIN SELECT RAISE(ABORT, 'synthetic second notice failure'); END");
  evidence.rollbackFailure = await reset().then(() => 'unexpected success', String); assert.match(String(evidence.rollbackFailure), /synthetic second notice failure/);
  if (reservationConversation) { assert.equal(inspect(() => raw.prepare('SELECT id FROM neo_conversation').get()) ?? null, null); evidence.boundConversationReservationRolledBackWithNotice = true; }
  for (const human of rollbackHumans) assert.equal(active(human.device.id), true);
  assert.equal(count('neo_publications'), rollbackNotices); assert.equal(count('human_device_resets'), rollbackResets);
  assert((await repo.redeemAsync(rollbackCode.code, 'Synthetic valid after rollback', Date.now())).paired); evidence.secondNoticeFailureRollsBackAllState = true; raw.exec('DROP TRIGGER reject_second_notice');
  raw.exec('CREATE TABLE synthetic_reset_lock(value INTEGER); INSERT INTO synthetic_reset_lock VALUES(0)');
  lock = new SQLite(app.db.getDbPath()); lock.exec('BEGIN IMMEDIATE'); lock.prepare('UPDATE synthetic_reset_lock SET value=1').run();
  const removed = rollbackHumans[0].device.id; lock.prepare('UPDATE paired_devices SET revoked_at=? WHERE id=?').run(Date.now(), removed);
  let settled = false; const heldAt = performance.now(); const pending = reset().finally(() => { settled = true; });
  await new Promise((done) => setTimeout(done, 20)); assert.equal(settled, false); assert.equal(active(removed), true);
  const healthAt = performance.now(); assert.equal((await connectedRelay.hub.request<{ status: string }>('system.health', {})).status, 'ok'); evidence.healthWhileHeldMs = performance.now() - healthAt;
  assert.equal((raw.prepare('SELECT value FROM synthetic_reset_lock').get() as { value: number }).value, 0); assert.equal((lock.prepare('SELECT value FROM synthetic_reset_lock').get() as { value: number }).value, 1);
  lock.exec('COMMIT'); lock.close(); lock = undefined; const held = await pending; assert(!held.devices.some((d) => d.id === removed)); assert.equal(held.devices.length, 22); evidence.heldMs = performance.now() - heldAt; evidence.currentHumansSelectedAfterWriterWait = true;
  const emptyAt = performance.now(); const empty = await Promise.all([reset(), reset()]); assert(empty.every((r) => r.devices.length === 0)); assert.equal(new Set(empty.map((r) => r.id)).size, 2); evidence.concurrentMs = performance.now() - emptyAt; evidence.distinctEmptyResetsRetainNotices = true;
  const protectedHuman = seed(); const preFaultResets = count('human_device_resets'); const preFaultNotices = count('neo_publications'); rejectNextWrite = true;
  evidence.beforeCommitFailure = await reset().then(() => 'unexpected success', String); assert.match(String(evidence.beforeCommitFailure), /before commit/); assert.equal(active(protectedHuman.device.id), true); assert.equal(count('human_device_resets'), preFaultResets); assert.equal(count('neo_publications'), preFaultNotices);
  const beforePosts = commandPosts; loseNextReceipt = true; evidence.lostReceiptFailure = await reset().then(() => 'unexpected success', String); assert.match(String(evidence.lostReceiptFailure), /outcome unknown/); assert.equal(active(protectedHuman.device.id), false);
  assert.equal(count('human_device_resets'), preFaultResets + 1); assert.equal(count('neo_publications'), preFaultNotices + 1); await new Promise((done) => setTimeout(done, 100)); assert.equal(commandPosts, beforePosts + 1); evidence.unknownOutcomeNotReplayed = true;
  assert.equal((await reset()).devices.length, 0); evidence.writerRecovered = true;
  assert.equal(mainSqlAttempts, 0); assert(maxLoopLagMs < 1000); evidence.maxLoopLagMs = maxLoopLagMs; evidence.rssBytes = process.memoryUsage().rss; evidence.walBytes = statSync(`${app.db.getDbPath()}-wal`).size;
  evidence.publicResetOperationUnwired = true; evidence.commandPosts = commandPosts;
} finally {
  measuring = false; if (timer) clearInterval(timer); if (lock) { try { lock.exec('ROLLBACK'); } catch {} lock.close(); }
  try { await Promise.all(transports.map((t) => t.close())); await Promise.all([...processors].map((p) => p.stop())); await app?.cleanup(); }
  finally { SQLite.prototype.prepare = prepare; JobQueueProcessor.prototype.start = start; globalThis.Worker = NativeWorker; globalThis.fetch = nativeFetch; evidence.mainSqlAttempts = mainSqlAttempts; evidence.timings = timings; writeFileSync(join(run, 'evidence/human-reset-command.json'), JSON.stringify(evidence, null, 2)); }
}
console.log('ok native human reset and human-visible notice commit atomically off main, with real public readback and no write replay; reset operation wiring remains separate');
