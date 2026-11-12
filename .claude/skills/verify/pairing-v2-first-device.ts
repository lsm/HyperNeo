import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { DevicePairingRepository } from '../../../packages/daemon/src/storage/repositories/device-pairing-repository.ts';
import { pairingRequestReads } from '../../../packages/daemon/src/storage/repositories/pairing-request-repository.ts';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(
  ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN'].every(
    (name) => process.env[name] === undefined
  )
);
for (const name of ['home', 'workspace', 'bin', 'evidence'])
  mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });

process.env.HYPERNEO_PAIRING_V2 = 'on';
const app = await createDaemonApp({
  config: {
    ...getConfig({
      port: 0,
      host: '127.0.0.1',
      dbPath: join(run, 'data/daemon.db'),
      workspaceRoot: join(run, 'workspace'),
    }),
    disableWorktrees: true,
  },
  verbose: false,
});
await app.jobProcessor.stop();
assert(![8399, 8499].includes(app.server.port));
const base = `http://127.0.0.1:${app.server.port}`;
const fixture = new Database(join(run, 'data/daemon.db'));
const devices = new DevicePairingRepository(fixture);
const now = Date.now();
const evidence: Record<string, unknown> = { head: process.argv[2], passed: false };

const setupCredential = readLocalCredential(join(run, 'data', 'local-rpc.credential'));

const call = async (
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any; cookies: string[] }> => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: base,
      authorization: `Bearer ${setupCredential}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    cookies: response.headers.getSetCookie?.() ?? [],
  };
};

const phone = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    key: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).subarray(-32).toString(
      'base64url'
    ),
    sign: (message: string) => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url'),
  };
};

const requestTicket = async () => {
  const made = await call('/pair2/request', {});
  assert.equal(made.status, 200);
  return made.body as { requestId: string; ticket: string; expiresAt: number };
};

const bind = async (ticket: string, key: string, name: string) => {
  const bound = await call('/pair2/bind', { ticket, phoneKey: key, name });
  assert.equal(bound.status, 200);
  return bound.body as { requestId: string; bindNonce: string };
};

const complete = (requestId: string, key: string, signature: string) =>
  call('/pair2/complete', { requestId, phoneKey: key, signature });

try {
  const first = await requestTicket();
  const rival = await requestTicket();
  const firstPhone = phone();
  const rivalPhone = phone();
  const firstBind = await bind(first.ticket, firstPhone.key, 'First phone');
  const rivalBind = await bind(rival.ticket, rivalPhone.key, 'Rival first phone');
  const firstComplete = await complete(
    first.requestId,
    firstPhone.key,
    firstPhone.sign(`${first.requestId}:${firstBind.bindNonce}`)
  );
  assert.equal(firstComplete.status, 200);
  const firstCredential = firstComplete.body.credential as string;
  assert(firstCredential, 'the first phone must receive a device credential');
  assert.equal(firstComplete.body.owner, true);
  evidence.firstPhone = { grantedWithoutApproval: true, owner: true };

  const rivalApproval = await call('/pair2/approve', { requestId: rival.requestId }, {
    authorization: `Bearer ${firstCredential}`,
  });
  assert.equal(rivalApproval.status, 403);
  const rivalComplete = await complete(
    rival.requestId,
    rivalPhone.key,
    rivalPhone.sign(`${rival.requestId}:${rivalBind.bindNonce}`)
  );
  assert.equal(rivalComplete.status, 403);
  assert.equal(rivalComplete.body.error, 'cancelled');
  evidence.firstDeviceRequestsAreNotApprovable = true;

  const second = await requestTicket();
  const secondPhone = phone();
  const secondBind = await bind(second.ticket, secondPhone.key, 'Second phone');
  const secondSignature = secondPhone.sign(`${second.requestId}:${secondBind.bindNonce}`);
  assert.equal((await complete(second.requestId, secondPhone.key, secondSignature)).status, 403);
  const approved = await call('/pair2/approve', { requestId: second.requestId }, {
    authorization: `Bearer ${firstCredential}`,
  });
  assert.equal(approved.status, 200);
  const secondComplete = await complete(second.requestId, secondPhone.key, secondSignature);
  assert.equal(secondComplete.status, 200);
  assert.equal(secondComplete.body.owner, false);
  evidence.laterPhoneApprovedByFirst = true;

  const legacy = devices.createCode('human', 'Typed phone', true, now);
  const redeemed = devices.redeem(legacy.code, 'Typed phone', now);
  assert(redeemed, 'a legacy typed code must still join');
  const legacyCredential = redeemed.credential;
  const legacyTicket = await requestTicket();
  const legacyPhone = phone();
  const legacyBind = await bind(legacyTicket.ticket, legacyPhone.key, 'After legacy');
  const legacyApproval = await call('/pair2/approve', { requestId: legacyTicket.requestId }, {
    authorization: `Bearer ${legacyCredential}`,
  });
  assert.equal(legacyApproval.status, 200);
  assert.equal(
    (
      await complete(
        legacyTicket.requestId,
        legacyPhone.key,
        legacyPhone.sign(`${legacyTicket.requestId}:${legacyBind.bindNonce}`)
      )
    ).status,
    200
  );
  evidence.legacyCodePhoneCanApprove = true;

  const humans = devices.countDevices().humans;
  assert.equal(humans, 4);
  evidence.activePhones = humans;
  evidence.passed = true;
} finally {
  fixture.close();
  await app.cleanup();
  evidence.resourcesClosed = true;
  writeFileSync(
    join(run, 'evidence/pairing-v2-first-device.json'),
    JSON.stringify(evidence, null, 2)
  );
}
console.log(JSON.stringify(evidence));
