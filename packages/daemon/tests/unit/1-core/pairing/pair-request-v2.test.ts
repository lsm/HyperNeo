import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import {
  pairingRequestReads,
  pairingRequestWrites,
} from '../../../../src/storage/repositories/pairing-request-repository';
import { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

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

const proof = (phone: ReturnType<typeof phoneKeypair>, requestId: string, nonce: string) =>
  phone.sign(`${requestId}:${nonce}`);

describe('pairing v2 one-time request repository', () => {
  let main: Database;
  let writer: Database;
  let gateway: DbGateway;
  let devices: DevicePairingRepository;
  let now = 1_000_000;

  const denyRequest = (requestId: string) =>
    gateway.call(pairingRequestWrites, 'denyRequest', requestId, now) as Promise<boolean>;

  const cancelRequest = (requestId: string) =>
    gateway.call(pairingRequestWrites, 'cancelRequest', requestId, now) as Promise<boolean>;

  const createRequest = () =>
    gateway.call(pairingRequestWrites, 'createRequest', now) as Promise<{
      requestId: string;
      ticket: string;
      expiresAt: number;
    }>;

  const bindTicket = (ticket: string, phoneKey: string, name: string | null = null) =>
    gateway.call(pairingRequestWrites, 'bindTicket', ticket, phoneKey, name, now) as Promise<
      { ok: true; requestId: string; bindNonce: string; expiresAt: number } | { ok: false }
    >;

  const approveRequest = (requestId: string, approver: string) =>
    gateway.call(pairingRequestWrites, 'approveRequest', requestId, approver, now) as Promise<
      'approved' | 'not_pending' | 'not_allowed'
    >;

  const ownerCount = () => gateway.call(pairingRequestReads, 'ownerCount') as Promise<number>;

  const completeRequest = (requestId: string, phoneKey: string, signature: string) =>
    gateway.call(
      pairingRequestWrites,
      'completeRequest',
      requestId,
      phoneKey,
      signature,
      now
    ) as Promise<
      | { ok: true; deviceId: string; credential: string; owner: boolean }
      | { ok: false; reason: string }
    >;

  const seedPhone = (owner = 0) => {
    const id = crypto.randomUUID();
    writer
      .prepare(
        "INSERT INTO paired_devices (id, name, kind, secret_hash, created_at, owner) VALUES (?, ?, 'human', ?, ?, ?)"
      )
      .run(id, 'Seeded phone', `hash-${id}`, now, owner);
    return id;
  };

  const requestStatus = (requestId: string) =>
    gateway.call(pairingRequestReads, 'requestStatus', requestId, now) as Promise<{
      state: string;
      expiresAt: number;
    } | null>;

  beforeEach(() => {
    now = 1_000_000;
    main = new Database(':memory:');
    writer = new Database(':memory:');
    runMigrations(writer, () => {});
    createTables(writer);
    gateway = new DbGateway(':memory:', writer);
    bindGateway(main, gateway);
    devices = new DevicePairingRepository(writer);
  });

  afterEach(async () => {
    await gateway.close();
    main.close();
    writer.close();
  });

  test('a created request is pending with a 90 second expiry', async () => {
    const made = await createRequest();
    expect(made.requestId).toBeTruthy();
    expect(made.ticket).toBeTruthy();
    expect(made.expiresAt - now).toBe(90_000);
    expect(await requestStatus(made.requestId)).toMatchObject({ state: 'pending' });
  });

  test('a ticket binds once; a second scan cannot rebind it', async () => {
    const made = await createRequest();
    const bound = await bindTicket(made.ticket, phoneKeypair().publicKeyB64, 'Phone A');
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.requestId).toBe(made.requestId);
    expect(bound.bindNonce).toBeTruthy();
    expect(await requestStatus(made.requestId)).toMatchObject({ state: 'bound' });

    const second = await bindTicket(made.ticket, phoneKeypair().publicKeyB64, 'Phone B');
    expect(second.ok).toBe(false);
  });

  test('an unknown or mistyped ticket binds nothing', async () => {
    await createRequest();
    expect((await bindTicket('not-a-real-ticket', phoneKeypair().publicKeyB64)).ok).toBe(false);
  });

  test('a copied QR cannot mint a credential', async () => {
    const existing = seedPhone();
    const made = await createRequest();
    const bound = await bindTicket(made.ticket, phoneKeypair().publicKeyB64);
    expect(bound.ok).toBe(true);
    expect(await approveRequest(made.requestId, existing)).toBe('approved');

    const thief = phoneKeypair();
    const stolen = await completeRequest(
      made.requestId,
      thief.publicKeyB64,
      thief.sign('anything')
    );
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.reason).toBe('wrong_key');
    expect(devices.countDevices().humans).toBe(1);
  });

  test('a later phone needs approval and proof of possession', async () => {
    const existing = seedPhone();
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindTicket(made.ticket, phone.publicKeyB64);
    if (!bound.ok) throw new Error('bind failed');

    const early = await completeRequest(
      made.requestId,
      phone.publicKeyB64,
      proof(phone, made.requestId, bound.bindNonce)
    );
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toBe('not_approved');

    expect(await approveRequest(made.requestId, existing)).toBe('approved');

    const badSignature = await completeRequest(
      made.requestId,
      phone.publicKeyB64,
      proof(phone, made.requestId, 'other-nonce')
    );
    expect(badSignature.ok).toBe(false);
    if (!badSignature.ok) expect(badSignature.reason).toBe('bad_proof');
    expect(devices.countDevices().humans).toBe(1);
  });

  test('a first bound request completes once with no approval and returns a human credential', async () => {
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindTicket(made.ticket, phone.publicKeyB64, 'My Phone');
    if (!bound.ok) throw new Error('bind failed');

    const done = await completeRequest(
      made.requestId,
      phone.publicKeyB64,
      proof(phone, made.requestId, bound.bindNonce)
    );
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.credential).toBeTruthy();
    expect(done.owner).toBe(true);
    expect(devices.countDevices().humans).toBe(1);
    expect(await requestStatus(made.requestId)).toMatchObject({ state: 'granted' });

    const again = await completeRequest(
      made.requestId,
      phone.publicKeyB64,
      proof(phone, made.requestId, bound.bindNonce)
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('used');
  });

  test('a completed human request closes recovery and invalidates peer human approvals', async () => {
    devices.setTerminalApproval(false, 'fixture', now);
    writer
      .prepare('INSERT INTO human_device_resets (id, reset_at, devices_json) VALUES (?, ?, ?)')
      .run('recovery', now, '[]');
    const peer = devices.createCode('human', 'Recovery peer', true, now);
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindTicket(made.ticket, phone.publicKeyB64);
    if (!bound.ok) throw new Error('bind failed');
    expect(devices.humanRecoveryOpen()).toBe(true);
    const done = await completeRequest(
      made.requestId,
      phone.publicKeyB64,
      proof(phone, made.requestId, bound.bindNonce)
    );
    expect(done.ok).toBe(true);
    expect(devices.humanRecoveryOpen()).toBe(false);
    expect(devices.terminalMayApprove()).toBe(false);
    expect(devices.redeem(peer.code, 'Recovery peer', now)).toBeNull();
  });

  test('device insertion failure rolls back the grant and recovery closure together', async () => {
    writer
      .prepare('INSERT INTO human_device_resets (id, reset_at, devices_json) VALUES (?, ?, ?)')
      .run('recovery', now, '[]');
    const peer = devices.createCode('human', 'Recovery peer', true, now);
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindTicket(made.ticket, phone.publicKeyB64, 'Rejected phone');
    if (!bound.ok) throw new Error('bind failed');
    writer.exec(
      "CREATE TRIGGER reject_device BEFORE INSERT ON paired_devices WHEN NEW.name = 'Rejected phone' BEGIN SELECT RAISE(ABORT, 'synthetic insertion failure'); END"
    );
    await expect(
      completeRequest(
        made.requestId,
        phone.publicKeyB64,
        proof(phone, made.requestId, bound.bindNonce)
      )
    ).rejects.toThrow('synthetic insertion failure');
    expect(await requestStatus(made.requestId)).toMatchObject({ state: 'bound' });
    expect(devices.humanRecoveryOpen()).toBe(true);
    expect(devices.countDevices().humans).toBe(0);
    expect(devices.redeem(peer.code, 'Recovery peer', now)).not.toBeNull();
  });

  test('an expired request cannot be bound, approved or completed', async () => {
    const existing = seedPhone();
    const made = await createRequest();
    now += 91_000;
    expect((await bindTicket(made.ticket, phoneKeypair().publicKeyB64)).ok).toBe(false);
    expect(await approveRequest(made.requestId, existing)).toBe('not_pending');
    expect(await requestStatus(made.requestId)).toMatchObject({ state: 'expired' });
  });

  test('an approved request that expires cannot complete', async () => {
    const existing = seedPhone();
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindTicket(made.ticket, phone.publicKeyB64);
    if (!bound.ok) throw new Error('bind failed');
    await approveRequest(made.requestId, existing);
    now += 91_000;
    const done = await completeRequest(
      made.requestId,
      phone.publicKeyB64,
      proof(phone, made.requestId, bound.bindNonce)
    );
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.reason).toBe('expired');
  });

  test('a cancelled request cannot complete, and a late approval cannot revive it', async () => {
    const existing = seedPhone();
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindTicket(made.ticket, phone.publicKeyB64);
    if (!bound.ok) throw new Error('bind failed');
    expect(await cancelRequest(made.requestId)).toBe(true);
    expect(await requestStatus(made.requestId)).toMatchObject({ state: 'cancelled' });
    expect(await approveRequest(made.requestId, existing)).toBe('not_pending');
    const done = await completeRequest(
      made.requestId,
      phone.publicKeyB64,
      proof(phone, made.requestId, bound.bindNonce)
    );
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.reason).toBe('cancelled');
  });

  test('a denied request cannot complete', async () => {
    const existing = seedPhone();
    const made = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindTicket(made.ticket, phone.publicKeyB64);
    if (!bound.ok) throw new Error('bind failed');
    await approveRequest(made.requestId, existing);
    expect(await denyRequest(made.requestId)).toBe(true);
    const done = await completeRequest(
      made.requestId,
      phone.publicKeyB64,
      proof(phone, made.requestId, bound.bindNonce)
    );
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.reason).toBe('denied');
  });

  test('approval requires a bound ticket', async () => {
    const existing = seedPhone();
    const made = await createRequest();
    expect(await approveRequest(made.requestId, existing)).toBe('not_pending');
  });

  test('two simultaneous first-device completions grant exactly one owner', async () => {
    const madeA = await createRequest();
    const madeB = await createRequest();
    const phoneA = phoneKeypair();
    const phoneB = phoneKeypair();
    const boundA = await bindTicket(madeA.ticket, phoneA.publicKeyB64);
    const boundB = await bindTicket(madeB.ticket, phoneB.publicKeyB64);
    if (!boundA.ok || !boundB.ok) throw new Error('bind failed');

    const first = await completeRequest(
      madeA.requestId,
      phoneA.publicKeyB64,
      proof(phoneA, madeA.requestId, boundA.bindNonce)
    );
    expect(first.ok).toBe(true);
    const second = await completeRequest(
      madeB.requestId,
      phoneB.publicKeyB64,
      proof(phoneB, madeB.requestId, boundB.bindNonce)
    );
    expect(second.ok).toBe(false);
    expect(devices.countDevices().humans).toBe(1);
  });

  test('a local-rpc or agent approver cannot approve even with no owners', async () => {
    const existing = seedPhone();
    const made = await createRequest();
    const bound = await bindTicket(made.ticket, phoneKeypair().publicKeyB64);
    if (!bound.ok) throw new Error('bind failed');

    expect(await approveRequest(made.requestId, 'local-rpc:web')).toBe('not_allowed');
    expect(await approveRequest(made.requestId, 'agent-read:cli')).toBe('not_allowed');
    expect(await requestStatus(made.requestId)).toMatchObject({ state: 'bound' });
    expect(await approveRequest(made.requestId, existing)).toBe('approved');
  });

  test('a revoked phone cannot approve a successor', async () => {
    const bootstrap = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindTicket(bootstrap.ticket, phone.publicKeyB64);
    if (!bound.ok) throw new Error('bind failed');
    const granted = await completeRequest(
      bootstrap.requestId,
      phone.publicKeyB64,
      proof(phone, bootstrap.requestId, bound.bindNonce)
    );
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    expect(devices.revokeDevice(granted.deviceId, now)).toBe(true);

    const second = await createRequest();
    const boundSecond = await bindTicket(second.ticket, phoneKeypair().publicKeyB64);
    if (!boundSecond.ok) throw new Error('bind failed');
    expect(await approveRequest(second.requestId, granted.deviceId)).toBe('not_allowed');
    expect(await requestStatus(second.requestId)).toMatchObject({ state: 'bound' });
  });

  test('a later phone joins without the owner bit and can approve the next one', async () => {
    const bootstrap = await createRequest();
    const phone = phoneKeypair();
    const bound = await bindTicket(bootstrap.ticket, phone.publicKeyB64);
    if (!bound.ok) throw new Error('bind failed');
    const first = await completeRequest(
      bootstrap.requestId,
      phone.publicKeyB64,
      proof(phone, bootstrap.requestId, bound.bindNonce)
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await createRequest();
    const phoneB = phoneKeypair();
    const boundB = await bindTicket(second.ticket, phoneB.publicKeyB64);
    if (!boundB.ok) throw new Error('bind failed');
    await approveRequest(second.requestId, first.deviceId);
    const secondDone = await completeRequest(
      second.requestId,
      phoneB.publicKeyB64,
      proof(phoneB, second.requestId, boundB.bindNonce)
    );
    expect(secondDone.ok).toBe(true);
    if (!secondDone.ok) return;
    expect(secondDone.owner).toBe(false);

    const third = await createRequest();
    const boundThird = await bindTicket(third.ticket, phoneKeypair().publicKeyB64);
    if (!boundThird.ok) throw new Error('bind failed');
    expect(await approveRequest(third.requestId, secondDone.deviceId)).toBe('approved');
  });

  test('owner approvals after the first device do not grant owner', async () => {
    const bootstrap = await createRequest();
    const owner = phoneKeypair();
    const bound = await bindTicket(bootstrap.ticket, owner.publicKeyB64);
    if (!bound.ok) throw new Error('bind failed');
    await approveRequest(bootstrap.requestId, 'signer:fixture');
    const first = await completeRequest(
      bootstrap.requestId,
      owner.publicKeyB64,
      proof(owner, bootstrap.requestId, bound.bindNonce)
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.owner).toBe(true);
    const ownerDeviceId = devices.listDevices()[0].id;

    const second = await createRequest();
    const phone = phoneKeypair();
    const boundSecond = await bindTicket(second.ticket, phone.publicKeyB64);
    if (!boundSecond.ok) throw new Error('bind failed');
    expect(await approveRequest(second.requestId, ownerDeviceId)).toBe('approved');
    const done = await completeRequest(
      second.requestId,
      phone.publicKeyB64,
      proof(phone, second.requestId, boundSecond.bindNonce)
    );
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.owner).toBe(false);
    expect(devices.countDevices().humans).toBe(2);
  });
});
