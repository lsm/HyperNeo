import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { DevicePairingRepository } from '../../../packages/daemon/src/storage/repositories/device-pairing-repository.ts';
import { pairingRequestReads, pairingRequestWrites } from '../../../packages/daemon/src/storage/repositories/pairing-request-repository.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN'].every((name) => process.env[name] === undefined));
for (const name of ['home', 'workspace', 'bin', 'evidence']) mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true }, verbose: false });
await app.jobProcessor.stop();
const main = app.db.getDatabase();
const fixture = new Database(join(run, 'data/daemon.db'));
const devices = new DevicePairingRepository(fixture);
const originalPrepare = Database.prototype.prepare;
let measuring = false;
let mainSqlAttempts = 0;
Database.prototype.prepare = function (sql, ...args) {
  if (measuring && this === main && /\b(pairing_requests|paired_devices|pairing_codes|human_device_resets)\b/i.test(sql)) {
    mainSqlAttempts++;
    throw new Error('pairing request SQL reached the daemon main connection');
  }
  return Reflect.apply(originalPrepare, this, [sql, ...args]);
};
const measured = async <T>(work: () => Promise<T>): Promise<T> => {
  measuring = true;
  try { return await work(); } finally { measuring = false; }
};
const now = 1_000_000;
const pending = async (name: string) => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const phoneKey = Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).subarray(-32).toString('base64url');
  const made = await measured(() => app.db.gateway.call(pairingRequestWrites, 'createRequest', now));
  const bound = await measured(() => app.db.gateway.call(pairingRequestWrites, 'bindTicket', made.ticket, phoneKey, name, now));
  assert(bound.ok);
  assert.equal(await measured(() => app.db.gateway.call(pairingRequestWrites, 'approveRequest', made.requestId, 'local-rpc:fixture', now)), 'approved');
  return { requestId: made.requestId, phoneKey, signature: sign(null, Buffer.from(`${made.requestId}:${bound.bindNonce}`), privateKey).toString('base64url') };
};
const complete = (request: Awaited<ReturnType<typeof pending>>) => measured(() => app.db.gateway.call(pairingRequestWrites, 'completeRequest', request.requestId, request.phoneKey, request.signature, now));
const evidence: Record<string, unknown> = { head: process.argv[2], passed: false };
let transport: WebSocketClientTransport | undefined;
try {
  assert(![8399, 8499].includes(app.server.port));
  main.exec('PRAGMA query_only = ON');
  assert.deepEqual(main.prepare('PRAGMA query_only').get(), { query_only: 1 });
  devices.setTerminalApproval(false, 'fixture', now);
  fixture.prepare('INSERT INTO human_device_resets(id, reset_at, devices_json) VALUES (?, ?, ?)').run('first', now, '[]');
  const peer = devices.createCode('human', 'Recovery peer', true, now);
  const request = await pending('Recovered phone');
  const granted = await complete(request);
  assert(granted.ok);
  assert.equal(devices.humanRecoveryOpen(), false);
  assert.equal(devices.terminalMayApprove(), false);
  assert.equal(devices.redeem(peer.code, 'Recovery peer', now), null);
  assert.equal((await measured(() => app.db.gateway.call(pairingRequestReads, 'requestStatus', request.requestId, now)))?.state, 'granted');
  assert.equal((await measured(() => app.db.gateway.call(pairingRequestReads, 'ownerCount'))), 1);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false, createSocket: (url) => new WebSocket(url, { headers: { authorization: `Bearer ${granted.credential}` } }) });
  hub.registerTransport(transport);
  await transport.initialize();
  assert.equal((await hub.request<{ ok: boolean }>('operation.invoke', { name: 'device.pair.pending', input: {} })).ok, true);
  evidence.grantedCredentialAuthenticates = true;
  evidence.recoveryClosed = true;
  evidence.peerApprovalInvalidated = true;
  fixture.prepare('INSERT INTO human_device_resets(id, reset_at, devices_json) VALUES (?, ?, ?)').run('second', now, '[]');
  const rollbackPeer = devices.createCode('human', 'Rollback peer', true, now);
  const rejected = await pending('Rejected phone');
  fixture.exec("CREATE TRIGGER reject_device BEFORE INSERT ON paired_devices WHEN NEW.name = 'Rejected phone' BEGIN SELECT RAISE(ABORT, 'synthetic insertion failure'); END");
  await assert.rejects(() => complete(rejected), /synthetic insertion failure/);
  assert.equal(devices.humanRecoveryOpen(), true);
  assert.equal((await measured(() => app.db.gateway.call(pairingRequestReads, 'requestStatus', rejected.requestId, now)))?.state, 'approved');
  assert.equal(devices.countDevices().humans, 1);
  assert(devices.redeem(rollbackPeer.code, 'Rollback peer', now));
  evidence.failedGrantRolledBack = true;
  evidence.mainSqlAttempts = mainSqlAttempts;
  assert.equal(mainSqlAttempts, 0);
  evidence.passed = true;
} finally {
  measuring = false;
  Database.prototype.prepare = originalPrepare;
  await transport?.close();
  fixture.close();
  await app.cleanup();
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/pairing-v2-recovery.json'), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify(evidence));
