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
        ? { deviceId: req.headers.get('x-test-device') as string, kind: 'human' as const }
        : localIdentity;

  beforeEach(() => {
    now = 1_000_000;
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

  const seedDevice = (name = 'Seeded phone') => {
    const id = crypto.randomUUID();
    writer
      .prepare(
        "INSERT INTO paired_devices (id, name, kind, secret_hash, created_at) VALUES (?, ?, 'human', '', ?)"
      )
      .run(id, name, now);
    return id;
  };

  const repoApprove = (requestId: string, approver = 'local-rpc:fixture') =>
    gateway.call(pairingRequestWrites, 'approveRequest', requestId, approver, now) as Promise<
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

  test('completion needs approval and proof of possession', async () => {
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    const nonce = bound.body.bindNonce as string;

    const early = await completeRequest(made.requestId, phone, nonce);
    expect(early.res.status).toBe(403);
    expect(early.body.error).toBe('not_approved');

    expect(await repoApprove(made.requestId)).toBe('approved');

    const badSignature = await post('/pair2/complete', {
      requestId: made.requestId,
      phoneKey: phone.publicKeyB64,
      signature: phone.sign(`${made.requestId}:other-nonce`),
    });
    expect(badSignature.status).toBe(403);
    expect(devices.countDevices().humans).toBe(0);
  });

  test('an approved bound request completes once and only that phone gets the credential', async () => {
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    await repoApprove(made.requestId);

    const done = await completeRequest(made.requestId, phone, bound.body.bindNonce as string);
    expect(done.res.status).toBe(200);
    expect(done.body.credential).toBeTruthy();
    expect(devices.countDevices().humans).toBe(1);
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
    const denier = seedDevice();
    expect(
      (await post('/pair2/deny', { requestId: made.requestId }, { 'x-test-device': denier })).status
    ).toBe(200);
    const done = await completeRequest(made.requestId, phone, bound.body.bindNonce as string);
    expect(done.res.status).toBe(403);
    expect(done.body.error).toBe('denied');
  });

  test('two simultaneous first-owner approvals grant exactly one owner', async () => {
    const madeA = await createRequest();
    const madeB = await createRequest();
    const phoneA = phoneKeypair();
    const phoneB = phoneKeypair();
    const boundA = await bindRequest(madeA.ticket, phoneA);
    const boundB = await bindRequest(madeB.ticket, phoneB);
    expect(boundA.res.status).toBe(200);
    expect(boundB.res.status).toBe(200);

    expect(await repoApprove(madeA.requestId)).toBe('approved');
    expect(await repoApprove(madeB.requestId)).toBe('approved');

    const first = await completeRequest(madeA.requestId, phoneA, boundA.body.bindNonce as string);
    expect(first.res.status).toBe(200);
    const second = await completeRequest(madeB.requestId, phoneB, boundB.body.bindNonce as string);
    expect(second.res.status).toBe(403);
    expect(second.body.error).toBe('superseded');
    expect(devices.countDevices().humans).toBe(1);
  });

  test('a paired owner device approves a second phone without the bootstrap flag', async () => {
    const bootstrap = await createRequest();
    const owner = phoneKeypair();
    const bound = await bindRequest(bootstrap.ticket, owner);
    await repoApprove(bootstrap.requestId);
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

  test('approve and deny refuse the local synthetic credential', async () => {
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindRequest(made.ticket, phone);
    expect(bound.res.status).toBe(200);

    expect((await approveRequest(made.requestId)).status).toBe(403);
    expect((await post('/pair2/deny', { requestId: made.requestId })).status).toBe(403);
    expect(
      (await approveRequest(made.requestId, { 'x-test-device': 'agent-read:cli' })).status
    ).toBe(403);

    const owner = seedDevice();
    expect((await approveRequest(made.requestId, { 'x-test-device': owner })).status).toBe(200);
  });
});
