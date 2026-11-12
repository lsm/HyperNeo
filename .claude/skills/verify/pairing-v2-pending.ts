import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { DevicePairingRepository } from '../../../packages/daemon/src/storage/repositories/device-pairing-repository.ts';
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
const setupCredential = readLocalCredential(join(run, 'data', 'local-rpc.credential'));
const evidence: Record<string, unknown> = { head: process.argv[2], passed: false };

const call = async (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  method: 'GET' | 'POST' = 'POST',
  authenticated = true
) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: base,
      ...(authenticated ? { authorization: `Bearer ${setupCredential}` } : {}),
      ...headers,
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
};

const phone = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    key: Buffer.from(publicKey.export({ type: 'spki', format: 'der' }))
      .subarray(-32)
      .toString('base64url'),
    sign: (message: string) =>
      sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url'),
  };
};

const lastPhone = () => {
  const rows = devices.listDevices();
  return (
    rows.find(
      (row) =>
        row.kind === 'human' &&
        !row.id.startsWith('local-rpc:') &&
        !row.id.startsWith('agent-read:') &&
        !row.revokedAt
    ) ?? null
  );
};

const pairFirstPhone = async () => {
  const ticket = (await call('/pair2/request', {})).body as { requestId: string; ticket: string };
  const first = phone();
  const bound = await call('/pair2/bind', { ticket: ticket.ticket, phoneKey: first.key });
  assert.equal(bound.status, 200);
  const done = await call('/pair2/complete', {
    requestId: ticket.requestId,
    phoneKey: first.key,
    signature: first.sign(`${ticket.requestId}:${bound.body.bindNonce}`),
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.owner, true);
  return done.body.credential as string;
};

try {
  const firstCredential = await pairFirstPhone();
  assert.equal(devices.countDevices().humans, 1);

  const ticket = (await call('/pair2/request', {})).body as { requestId: string; ticket: string };
  const joiner = phone();
  const bound = await call('/pair2/bind', {
    ticket: ticket.ticket,
    phoneKey: joiner.key,
    name: 'Joining phone',
  });
  assert.equal(bound.status, 200);

  const listed = await call(
    '/pair2/pending',
    null,
    { authorization: `Bearer ${firstCredential}` },
    'GET'
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(listed.body.requests, [
    {
      requestId: ticket.requestId,
      name: 'Joining phone',
      phoneKey: joiner.key,
      bindNonce: bound.body.bindNonce,
      expiresAt: ticket.expiresAt,
    },
  ]);
  evidence.pendingList = listed.body.requests;

  const webPending = await call('/pair2/pending', null, {}, 'GET');
  assert.equal(webPending.status, 403);
  evidence.webCannotReadPendingList = true;

  const joinSignature = joiner.sign(`cancel:${ticket.requestId}:${bound.body.bindNonce}`);
  const webCancelled = await call('/pair2/cancel', {
    requestId: ticket.requestId,
    signature: joinSignature,
  });
  assert.equal(webCancelled.status, 403);
  assert.equal(webCancelled.body.error, 'signed_request_with_approver_credential');
  evidence.webPlusSignatureRefused = true;
  assert.equal(
    (await call(`/pair2/status?requestId=${ticket.requestId}`, null, {}, 'GET')).body.state,
    'bound'
  );

  const cancelled = await call(
    '/pair2/cancel',
    { requestId: ticket.requestId, signature: joinSignature },
    {},
    'POST',
    false
  );
  assert.equal(cancelled.status, 200);
  const status = await call(`/pair2/status?requestId=${ticket.requestId}`, null, {}, 'GET');
  assert.equal(status.body.state, 'cancelled');
  assert.equal(
    (
      await call('/pair2/complete', {
        requestId: ticket.requestId,
        phoneKey: joiner.key,
        signature: joiner.sign(`${ticket.requestId}:${bound.body.bindNonce}`),
      })
    ).status,
    403
  );
  evidence.joiningPhoneCancelIsTerminal = true;

  const grantedTicket = (await call('/pair2/request', {})).body as {
    requestId: string;
    ticket: string;
  };
  const joiner2 = phone();
  const grantedBound = await call('/pair2/bind', {
    ticket: grantedTicket.ticket,
    phoneKey: joiner2.key,
  });
  assert.equal(
    (
      await call(
        '/pair2/approve',
        { requestId: grantedTicket.requestId },
        { authorization: `Bearer ${firstCredential}` }
      )
    ).status,
    200
  );
  assert.equal(
    (
      await call('/pair2/complete', {
        requestId: grantedTicket.requestId,
        phoneKey: joiner2.key,
        signature: joiner2.sign(`${grantedTicket.requestId}:${grantedBound.body.bindNonce}`),
      })
    ).status,
    200
  );
  const late = await call(
    '/pair2/cancel',
    {
      requestId: grantedTicket.requestId,
      signature: joiner2.sign(`cancel:${grantedTicket.requestId}:${grantedBound.body.bindNonce}`),
    },
    {},
    'POST',
    false
  );
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'granted');
  evidence.grantedCancelReportsGranted = true;

  const laterTicket = (await call('/pair2/request', {})).body as {
    requestId: string;
    ticket: string;
  };
  const later = phone();
  const laterBound = await call('/pair2/bind', {
    ticket: laterTicket.ticket,
    phoneKey: later.key,
  });
  const forged = await call(
    '/pair2/cancel',
    {
      requestId: laterTicket.requestId,
      signature: phone().sign(`cancel:${laterTicket.requestId}:${laterBound.body.bindNonce}`),
    },
    {},
    'POST',
    false
  );
  assert.equal(forged.status, 403);
  assert.equal(forged.body.error, 'not_pending');
  evidence.forgedJoinCancelRefused = true;

  const forgedWithPhone = await call(
    '/pair2/cancel',
    {
      requestId: laterTicket.requestId,
      signature: phone().sign(`cancel:${laterTicket.requestId}:${laterBound.body.bindNonce}`),
    },
    { authorization: `Bearer ${firstCredential}` }
  );
  assert.equal(forgedWithPhone.status, 403);
  assert.equal(
    (await call(`/pair2/status?requestId=${laterTicket.requestId}`, null, {}, 'GET')).body.state,
    'bound'
  );

  assert.equal(devices.countDevices().humans, 2);
  evidence.lastPhone = lastPhone()?.name ?? null;
  evidence.passed = true;
} finally {
  fixture.close();
  await app.cleanup();
  evidence.resourcesClosed = true;
  writeFileSync(
    join(run, 'evidence/pairing-v2-pending.json'),
    JSON.stringify(evidence, null, 2)
  );
}
console.log(JSON.stringify(evidence));
