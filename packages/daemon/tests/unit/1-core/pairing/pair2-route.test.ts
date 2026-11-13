import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository';
import { pairingRequestWrites } from '../../../../src/storage/repositories/pairing-request-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createPair2Route, type Pair2Identity } from '../../../../src/lib/pairing/pair2-route';
import { createPairingLimiter } from '../../../../src/lib/pairing/pairing-limiter';

function phoneKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const raw = Buffer.from(spki).subarray(-32);
  return {
    publicKeyB64: raw.toString('base64url'),
    sign: (message: string) =>
      edSign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url'),
  };
}

describe('pairing v2 one-time request route', () => {
  let writer: Database;
  let gateway: DbGateway;
  let devices: DevicePairingRepository;
  let route: ReturnType<typeof createPair2Route>;
  let now = 1_000_000;

  const localIdentity: Pair2Identity = { deviceId: 'local-rpc:web', kind: 'human' };
  const auth = async (req: Request, remoteAddress?: string | null) =>
    remoteAddress === '10.0.0.9'
      ? null
      : req.headers.get('x-test-device')
        ? {
            deviceId: req.headers.get('x-test-device') as string,
            kind: (req.headers.get('x-test-device') as string).startsWith('agent-read:')
              ? ('agent' as const)
              : ('human' as const),
          }
        : localIdentity;

  beforeEach(() => {
    now = 1_000_000;
    approverId = null;
    writer = new Database(':memory:');
    runMigrations(writer, () => {});
    createTables(writer);
    gateway = new DbGateway(':memory:', writer);
    devices = new DevicePairingRepository(writer);
    route = createPair2Route({
      db: gateway,
      limiter: createPairingLimiter(),
      now: () => now,
      authenticate: auth,
    });
  });

  afterEach(async () => {
    await gateway.close();
    writer.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    route(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
    );

  const status = (requestId: string) =>
    route(new Request(`http://localhost/pair2/status?requestId=${requestId}`));

  const createRequest = async () => {
    const res = await post('/pair2/request', {});
    expect(res.status).toBe(200);
    return (await res.json()) as { requestId: string; ticket: string; expiresAt: number };
  };

  const bindRequest = async (ticket: string, phone: ReturnType<typeof phoneKeypair>) => {
    const res = await post('/pair2/bind', { ticket, phoneKey: phone.publicKeyB64 });
    return { res, body: (await res.json()) as { requestId?: string; bindNonce?: string } };
  };

  const seedDevice = (name = 'Seeded phone', owner = 1) => {
    const id = crypto.randomUUID();
    writer
      .prepare(
        "INSERT INTO paired_devices (id, name, kind, secret_hash, created_at, owner) VALUES (?, ?, 'human', ?, ?, ?)"
      )
      .run(id, name, `hash-${id}`, now, owner);
    return id;
  };

  let approverId: string | null = null;
  const approver = () => (approverId ??= seedDevice('Approver phone', 0));

  const repoApprove = (requestId: string, approverDevice = approver()) =>
    gateway.call(pairingRequestWrites, 'approveRequest', requestId, approverDevice, now) as Promise<
      'approved' | 'not_pending' | 'not_allowed'
    >;

  const approveRequest = async (requestId: string, headers: Record<string, string> = {}) =>
    post('/pair2/approve', { requestId }, headers);

  const completeRequest = async (
    requestId: string,
    phone: ReturnType<typeof phoneKeypair>,
    bindNonce: string
  ) => {
    const res = await post('/pair2/complete', {
      requestId,
      phoneKey: phone.publicKeyB64,
      signature: phone.sign(`${requestId}:${bindNonce}`),
    });
    return { res, body: (await res.json()) as { credential?: string; error?: string } };
  };

  test('the handler forwards the remote address to authentication', async () => {
    const res = await route(
      new Request('http://localhost/pair2/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      '10.0.0.9'
    );
    expect(res.status).toBe(403);
  });

  test('a created request returns a ticket and a 90 second expiry', async () => {
    const made = await createRequest();
    expect(made.requestId).toBeTruthy();
    expect(made.ticket).toBeTruthy();
    expect(made.expiresAt - now).toBe(90_000);
    expect(await (await status(made.requestId)).json()).toMatchObject({ state: 'pending' });
  });

  test('a created request says whether it pairs the first phone or waits for an owner', async () => {
    const first = (await (await post('/pair2/request', {})).json()) as { firstDevice?: boolean };
    expect(first.firstDevice).toBe(true);
    seedDevice('Paired phone');
    const later = (await (await post('/pair2/request', {})).json()) as { firstDevice?: boolean };
    expect(later.firstDevice).toBe(false);
  });

  test('a ticket binds once; a second scan cannot rebind it', async () => {
    const made = await createRequest();
    const phoneA = phoneKeypair();
    const phoneB = phoneKeypair();

    const first = await bindRequest(made.ticket, phoneA);
    expect(first.res.status).toBe(200);
    expect(first.body.requestId).toBe(made.requestId);
    expect(first.body.bindNonce).toBeTruthy();

    const second = await bindRequest(made.ticket, phoneB);
    expect(second.res.status).toBe(403);
  });

  test('a copied QR cannot mint a credential', async () => {
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    expect(bound.res.status).toBe(200);

    const thief = phoneKeypair();
    const stolen = await completeRequest(made.requestId, thief, bound.body.bindNonce as string);
    expect(stolen.res.status).toBe(403);
    expect(devices.countDevices().humans).toBe(0);
  });

  test('status exposes the bound phone key and name so an approver can verify it', async () => {
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await post('/pair2/bind', {
      ticket: made.ticket,
      phoneKey: phone.publicKeyB64,
      name: 'My Phone',
    });
    expect(bound.status).toBe(200);
    expect(await (await status(made.requestId)).json()).toMatchObject({
      state: 'bound',
      phoneKey: phone.publicKeyB64,
      name: 'My Phone',
    });
  });

  test('a phone retrying complete while awaiting approval does not trip the limiter', async () => {
    seedDevice('Existing phone');
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    const nonce = bound.body.bindNonce as string;
    for (let i = 0; i < 5; i++) {
      expect((await completeRequest(made.requestId, phone, nonce)).res.status).toBe(403);
    }
    expect(await repoApprove(made.requestId)).toBe('approved');
    const done = await completeRequest(made.requestId, phone, nonce);
    expect(done.res.status).toBe(200);
    expect(done.body.credential).toBeTruthy();
  });

  test('a later phone needs approval and proof of possession', async () => {
    const existing = seedDevice('Existing phone');
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    const nonce = bound.body.bindNonce as string;

    const early = await completeRequest(made.requestId, phone, nonce);
    expect(early.res.status).toBe(403);
    expect(early.body.error).toBe('not_approved');

    expect(await repoApprove(made.requestId, existing)).toBe('approved');

    const badSignature = await post('/pair2/complete', {
      requestId: made.requestId,
      phoneKey: phone.publicKeyB64,
      signature: phone.sign(`${made.requestId}:other-nonce`),
    });
    expect(badSignature.status).toBe(403);
    expect(devices.countDevices().humans).toBe(1);
  });

  test('an approved bound request completes once and only that phone gets the credential', async () => {
    const existing = seedDevice('Existing phone');
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    expect(await repoApprove(made.requestId, existing)).toBe('approved');

    const done = await completeRequest(made.requestId, phone, bound.body.bindNonce as string);
    expect(done.res.status).toBe(200);
    expect(done.body.credential).toBeTruthy();
    expect(devices.countDevices().humans).toBe(2);
    expect(await (await status(made.requestId)).json()).toMatchObject({ state: 'granted' });

    const again = await completeRequest(made.requestId, phone, bound.body.bindNonce as string);
    expect(again.res.status).toBe(409);
  });

  test('an expired request cannot be bound, approved or completed', async () => {
    const made = await createRequest();
    now += 91_000;
    expect((await bindRequest(made.ticket, phoneKeypair())).res.status).toBe(403);
    expect((await approveRequest(made.requestId, { 'x-test-device': seedDevice() })).status).toBe(
      403
    );
    expect(await (await status(made.requestId)).json()).toMatchObject({ state: 'expired' });
  });

  test('a bound request that expires cannot complete', async () => {
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    await repoApprove(made.requestId);
    now += 91_000;
    const done = await completeRequest(made.requestId, phone, bound.body.bindNonce as string);
    expect(done.res.status).toBe(403);
    expect(done.body.error).toBe('expired');
  });

  test('a cancelled request cannot complete, and a late approval cannot revive it', async () => {
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    expect((await post('/pair2/cancel', { requestId: made.requestId })).status).toBe(200);
    expect(await (await status(made.requestId)).json()).toMatchObject({ state: 'cancelled' });
    expect((await approveRequest(made.requestId, { 'x-test-device': seedDevice() })).status).toBe(
      403
    );
    const done = await completeRequest(made.requestId, phone, bound.body.bindNonce as string);
    expect(done.res.status).toBe(403);
    expect(done.body.error).toBe('cancelled');
  });

  test('a denied request cannot complete', async () => {
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    await repoApprove(made.requestId);
    expect((await post('/pair2/deny', { requestId: made.requestId })).status).toBe(200);
    const done = await completeRequest(made.requestId, phone, bound.body.bindNonce as string);
    expect(done.res.status).toBe(403);
    expect(done.body.error).toBe('denied');
  });

  test('two simultaneous first-device completions grant exactly one owner', async () => {
    const madeA = await createRequest();
    const madeB = await createRequest();
    const phoneA = phoneKeypair();
    const phoneB = phoneKeypair();
    const boundA = await bindRequest(madeA.ticket, phoneA);
    const boundB = await bindRequest(madeB.ticket, phoneB);
    expect(boundA.res.status).toBe(200);
    expect(boundB.res.status).toBe(200);

    const first = await completeRequest(madeA.requestId, phoneA, boundA.body.bindNonce as string);
    expect(first.res.status).toBe(200);
    const second = await completeRequest(madeB.requestId, phoneB, boundB.body.bindNonce as string);
    expect(second.res.status).toBe(403);
    expect(devices.countDevices().humans).toBe(1);
  });

  test('a paired first phone approves a second phone without any bootstrap flag', async () => {
    const bootstrap = await createRequest();
    const owner = phoneKeypair();
    const bound = await bindRequest(bootstrap.ticket, owner);
    const granted = await completeRequest(
      bootstrap.requestId,
      owner,
      bound.body.bindNonce as string
    );
    expect(granted.res.status).toBe(200);
    const ownerDeviceId = devices.listDevices()[0].id;

    const second = await createRequest();
    const phone = phoneKeypair();
    const boundSecond = await bindRequest(second.ticket, phone);
    expect((await approveRequest(second.requestId)).status).toBe(403);
    expect(
      (await approveRequest(second.requestId, { 'x-test-device': ownerDeviceId })).status
    ).toBe(200);
    const done = await completeRequest(
      second.requestId,
      phone,
      boundSecond.body.bindNonce as string
    );
    expect(done.res.status).toBe(200);
    expect(devices.countDevices().humans).toBe(2);
  });

  test('the web session can deny and cancel but not approve', async () => {
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    expect(bound.res.status).toBe(200);

    expect((await approveRequest(made.requestId)).status).toBe(403);
    expect((await post('/pair2/deny', { requestId: made.requestId })).status).toBe(200);
    expect(await (await status(made.requestId)).json()).toMatchObject({ state: 'denied' });

    const second = await createRequest();
    await bindRequest(second.ticket, phone);
    expect((await post('/pair2/cancel', { requestId: second.requestId })).status).toBe(200);
    expect(await (await status(second.requestId)).json()).toMatchObject({ state: 'cancelled' });
  });

  test('any active paired phone can approve; agents, strangers and revoked phones cannot', async () => {
    seedDevice('Existing phone');
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    expect(bound.res.status).toBe(200);

    expect(
      (await approveRequest(made.requestId, { 'x-test-device': 'agent-read:cli' })).status
    ).toBe(403);
    const stranger = seedDevice('Revoked phone', 0);
    writer.prepare('UPDATE paired_devices SET revoked_at = ? WHERE id = ?').run(now, stranger);
    expect((await approveRequest(made.requestId, { 'x-test-device': stranger })).status).toBe(403);
    expect(
      (await approveRequest(made.requestId, { 'x-test-device': crypto.randomUUID() })).status
    ).toBe(403);

    const member = seedDevice('Paired member', 0);
    expect((await approveRequest(made.requestId, { 'x-test-device': member })).status).toBe(200);
    expect((await status(made.requestId).then((r) => r.json())).state).toBe('approved');
  });

  test('a first phone completes right after the scan with no approval step', async () => {
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    expect(bound.res.status).toBe(200);
    const done = await completeRequest(made.requestId, phone, bound.body.bindNonce as string);
    expect(done.res.status).toBe(200);
    expect(done.body.credential).toBeTruthy();
    expect(devices.countDevices().humans).toBe(1);
    expect(devices.listDevices()[0].name).toBe('Paired phone');
  });

  test('an active paired phone without the owner bit may approve the next phone', async () => {
    const member = seedDevice('Paired member', 0);
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    expect(bound.res.status).toBe(200);
    expect((await approveRequest(made.requestId, { 'x-test-device': member })).status).toBe(200);
    const done = await completeRequest(made.requestId, phone, bound.body.bindNonce as string);
    expect(done.res.status).toBe(200);
    expect(devices.countDevices().humans).toBe(2);
  });

  test('a legacy code device paired on this daemon may approve the next v2 phone', async () => {
    const legacy = devices.createCode('human', 'Legacy phone', true, now);
    const redeemed = await devices.redeemAsync({ code: legacy.code, name: 'Legacy phone' }, now);
    expect(redeemed.paired).toBeTruthy();
    const legacyDeviceId = (redeemed.paired as { device: { id: string } }).device.id;
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    expect((await approveRequest(made.requestId, { 'x-test-device': legacyDeviceId })).status).toBe(
      200
    );
    const done = await completeRequest(made.requestId, phone, bound.body.bindNonce as string);
    expect(done.res.status).toBe(200);
  });

  test('a first-device request cannot be approved through the approve route', async () => {
    const bootstrap = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(bootstrap.ticket, phone);
    expect(bound.res.status).toBe(200);
    const member = seedDevice('Existing member', 0);
    expect((await approveRequest(bootstrap.requestId, { 'x-test-device': member })).status).toBe(
      403
    );
    const done = await completeRequest(bootstrap.requestId, phone, bound.body.bindNonce as string);
    expect(done.res.status).toBe(403);
    expect(devices.countDevices().humans).toBe(1);
  });

  test('a legacy first-device grant refuses an outstanding v2 first-device attempt', async () => {
    const phone = phoneKeypair();
    const made = await createRequest();
    const bound = await bindRequest(made.ticket, phone);
    expect(bound.res.status).toBe(200);
    const legacy = devices.createCode('human', 'Typed phone', true, now);
    const redeemed = await devices.redeemAsync({ code: legacy.code, name: 'Typed phone' }, now);
    expect(redeemed.paired).toBeTruthy();
    const done = await completeRequest(made.requestId, phone, bound.body.bindNonce as string);
    expect(done.res.status).toBe(403);
    expect(done.body.error).toBe('cancelled');
    expect(devices.countDevices().humans).toBe(1);
  });

  test('a v2 first-device grant refuses an outstanding legacy human code', async () => {
    const legacy = devices.createCode('human', 'Typed phone', true, now);
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    const done = await completeRequest(made.requestId, phone, bound.body.bindNonce as string);
    expect(done.res.status).toBe(200);
    expect(
      await devices.redeemAsync({ code: legacy.code, name: 'Typed phone' }, now)
    ).toMatchObject({ paired: null });
    expect(devices.countDevices().humans).toBe(1);
  });

  const signCancel = (
    phone: ReturnType<typeof phoneKeypair>,
    requestId: string,
    bindNonce: string
  ) => phone.sign(`cancel:${requestId}:${bindNonce}`);

  const joinCancel = (
    body: unknown,
    remoteAddress: string | null = '10.0.0.9',
    headers: Record<string, string> = {}
  ) =>
    route(
      new Request('http://localhost/pair2/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      remoteAddress
    );

  test('the joining phone cancels with its own signature and no caller credential', async () => {
    seedDevice('Existing phone');
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    const nonce = bound.body.bindNonce as string;
    const signed = {
      requestId: made.requestId,
      signature: signCancel(phone, made.requestId, nonce),
    };

    expect((await joinCancel(signed)).status).toBe(200);
    expect(await (await status(made.requestId)).json()).toMatchObject({ state: 'cancelled' });
    expect((await joinCancel(signed)).status).toBe(403);
  });

  test('a signed cancel carrying the web session credential is refused', async () => {
    seedDevice('Existing phone');
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    const signed = {
      requestId: made.requestId,
      signature: signCancel(phone, made.requestId, bound.body.bindNonce as string),
    };

    const web = await joinCancel(signed, null);
    expect(web.status).toBe(403);
    expect(await web.json()).toMatchObject({ error: 'signed_request_with_approver_credential' });

    const phoneCredential = await joinCancel(signed, null, { 'x-test-device': approver() });
    expect(phoneCredential.status).toBe(403);
    expect(await (await status(made.requestId)).json()).toMatchObject({ state: 'bound' });
  });

  test('a signed cancel after completion reports the granted state', async () => {
    seedDevice('Existing phone');
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    const nonce = bound.body.bindNonce as string;
    await repoApprove(made.requestId);
    const done = await completeRequest(made.requestId, phone, nonce);
    expect(done.res.status).toBe(200);

    const late = await joinCancel({
      requestId: made.requestId,
      signature: signCancel(phone, made.requestId, nonce),
    });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: 'granted' });
    expect(await (await status(made.requestId)).json()).toMatchObject({ state: 'granted' });
  });

  test('a forged join cancel never falls back to the approver path', async () => {
    seedDevice('Existing phone');
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    const thief = phoneKeypair();
    const headers = { 'x-test-device': approver() };

    const forged = await post(
      '/pair2/cancel',
      {
        requestId: made.requestId,
        signature: signCancel(thief, made.requestId, bound.body.bindNonce as string),
      },
      headers
    );
    expect(forged.status).toBe(403);
    expect(await (await status(made.requestId)).json()).toMatchObject({ state: 'bound' });

    const mixed = await post(
      '/pair2/cancel',
      {
        requestId: made.requestId,
        signature: signCancel(phone, made.requestId, bound.body.bindNonce as string),
      },
      headers
    );
    expect(mixed.status).toBe(403);
    expect(await (await status(made.requestId)).json()).toMatchObject({ state: 'bound' });

    const extra = await post('/pair2/cancel', { requestId: made.requestId, extra: 1 }, headers);
    expect(extra.status).toBe(400);
  });

  const pending = (headers: Record<string, string> = {}) =>
    route(
      new Request('http://localhost/pair2/pending', {
        method: 'GET',
        headers: { 'x-test-device': approver(), ...headers },
      })
    );

  test('the pending list shows only bound, unapproved later-device requests', async () => {
    seedDevice('Existing phone');
    const phone = phoneKeypair();
    const made = await createRequest();
    const unbound = await createRequest();
    const bound = await bindRequest(made.ticket, phone);
    expect(bound.res.status).toBe(200);

    const res = await pending();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { requests: Record<string, unknown>[] };
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toEqual({
      requestId: made.requestId,
      name: null,
      phoneKey: phone.publicKeyB64,
      bindNonce: bound.body.bindNonce,
      expiresAt: made.expiresAt,
    });
    expect(JSON.stringify(body)).not.toContain(unbound.ticket);

    await repoApprove(made.requestId);
    expect(((await (await pending()).json()) as { requests: unknown[] }).requests).toHaveLength(0);
  });

  test('the pending list hides the first-device request and refuses strangers', async () => {
    const first = await createRequest();
    const phone = phoneKeypair();
    await bindRequest(first.ticket, phone);
    expect(((await (await pending()).json()) as { requests: unknown[] }).requests).toHaveLength(0);

    expect(
      (
        await route(
          new Request('http://localhost/pair2/pending', {
            method: 'GET',
            headers: { 'x-test-device': 'local-rpc:web' },
          })
        )
      ).status
    ).toBe(403);
    expect(
      (await route(new Request('http://localhost/pair2/pending', { method: 'GET' }), '10.0.0.9'))
        .status
    ).toBe(403);
  });

  test('unknown /pair2 paths 404 without charging the limiter', async () => {
    const bogus = await post('/pair2/nope', {});
    expect(bogus.status).toBe(404);
    const bogusGet = await route(new Request('http://localhost/pair2/nope'));
    expect(bogusGet.status).toBe(404);
    for (let i = 0; i < 10; i++) {
      expect((await post('/pair2/nope', {})).status).toBe(404);
    }
    const res = await post('/pair2/request', {});
    expect(res.status).toBe(200);
  });
});
