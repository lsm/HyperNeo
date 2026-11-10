import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository';
import { PairingRequestRepository } from '../../../../src/storage/repositories/pairing-request-repository';
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
  let writer: Database;
  let repo: PairingRequestRepository;
  let devices: DevicePairingRepository;
  let now = 1_000_000;

  beforeEach(() => {
    now = 1_000_000;
    writer = new Database(':memory:');
    runMigrations(writer, () => {});
    createTables(writer);
    repo = new PairingRequestRepository(writer);
    devices = new DevicePairingRepository(writer);
  });

  afterEach(() => {
    writer.close();
  });

  test('a created request is pending with a 90 second expiry', () => {
    const made = repo.createRequest(now);
    expect(made.requestId).toBeTruthy();
    expect(made.ticket).toBeTruthy();
    expect(made.expiresAt - now).toBe(90_000);
    expect(repo.requestStatus(made.requestId, now)).toMatchObject({ state: 'pending' });
  });

  test('a ticket binds once; a second scan cannot rebind it', () => {
    const made = repo.createRequest(now);
    const bound = repo.bindTicket(made.ticket, phoneKeypair().publicKeyB64, 'Phone A', now);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.requestId).toBe(made.requestId);
    expect(bound.bindNonce).toBeTruthy();
    expect(repo.requestStatus(made.requestId, now)).toMatchObject({ state: 'bound' });

    const second = repo.bindTicket(made.ticket, phoneKeypair().publicKeyB64, 'Phone B', now);
    expect(second.ok).toBe(false);
  });

  test('an unknown or mistyped ticket binds nothing', () => {
    repo.createRequest(now);
    expect(repo.bindTicket('not-a-real-ticket', phoneKeypair().publicKeyB64, null, now).ok).toBe(
      false
    );
  });

  test('a copied QR cannot mint a credential', () => {
    const made = repo.createRequest(now);
    const bound = repo.bindTicket(made.ticket, phoneKeypair().publicKeyB64, null, now);
    expect(bound.ok).toBe(true);
    expect(repo.approveRequest(made.requestId, 'local-rpc:web', now)).toBe('approved');

    const thief = phoneKeypair();
    const stolen = repo.completeRequest(
      made.requestId,
      thief.publicKeyB64,
      thief.sign('anything'),
      now
    );
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.reason).toBe('wrong_key');
    expect(devices.countDevices().humans).toBe(0);
  });

  test('completion needs approval and proof of possession', () => {
    const made = repo.createRequest(now);
    const phone = phoneKeypair();
    const bound = repo.bindTicket(made.ticket, phone.publicKeyB64, null, now);
    if (!bound.ok) throw new Error('bind failed');

    const early = repo.completeRequest(
      made.requestId,
      phone.publicKeyB64,
      proof(phone, made.requestId, bound.bindNonce),
      now
    );
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toBe('not_approved');

    expect(repo.approveRequest(made.requestId, 'local-rpc:web', now)).toBe('approved');

    const badSignature = repo.completeRequest(
      made.requestId,
      phone.publicKeyB64,
      proof(phone, made.requestId, 'other-nonce'),
      now
    );
    expect(badSignature.ok).toBe(false);
    if (!badSignature.ok) expect(badSignature.reason).toBe('bad_proof');
    expect(devices.countDevices().humans).toBe(0);
  });

  test('an approved bound request completes once and returns a human credential', () => {
    const made = repo.createRequest(now);
    const phone = phoneKeypair();
    const bound = repo.bindTicket(made.ticket, phone.publicKeyB64, 'My Phone', now);
    if (!bound.ok) throw new Error('bind failed');
    repo.approveRequest(made.requestId, 'local-rpc:web', now);

    const done = repo.completeRequest(
      made.requestId,
      phone.publicKeyB64,
      proof(phone, made.requestId, bound.bindNonce),
      now
    );
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.credential).toBeTruthy();
    expect(done.owner).toBe(true);
    expect(devices.countDevices().humans).toBe(1);
    expect(repo.requestStatus(made.requestId, now)).toMatchObject({ state: 'granted' });

    const again = repo.completeRequest(
      made.requestId,
      phone.publicKeyB64,
      proof(phone, made.requestId, bound.bindNonce),
      now
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('used');
  });

  test('an expired request cannot be bound, approved or completed', () => {
    const made = repo.createRequest(now);
    now += 91_000;
    expect(repo.bindTicket(made.ticket, phoneKeypair().publicKeyB64, null, now).ok).toBe(false);
    expect(repo.approveRequest(made.requestId, 'local-rpc:web', now)).toBe('not_pending');
    expect(repo.requestStatus(made.requestId, now)).toMatchObject({ state: 'expired' });
  });

  test('an approved request that expires cannot complete', () => {
    const made = repo.createRequest(now);
    const phone = phoneKeypair();
    const bound = repo.bindTicket(made.ticket, phone.publicKeyB64, null, now);
    if (!bound.ok) throw new Error('bind failed');
    repo.approveRequest(made.requestId, 'local-rpc:web', now);
    now += 91_000;
    const done = repo.completeRequest(
      made.requestId,
      phone.publicKeyB64,
      proof(phone, made.requestId, bound.bindNonce),
      now
    );
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.reason).toBe('expired');
  });

  test('a cancelled request cannot complete, and a late approval cannot revive it', () => {
    const made = repo.createRequest(now);
    const phone = phoneKeypair();
    const bound = repo.bindTicket(made.ticket, phone.publicKeyB64, null, now);
    if (!bound.ok) throw new Error('bind failed');
    expect(repo.cancelRequest(made.requestId, now)).toBe(true);
    expect(repo.requestStatus(made.requestId, now)).toMatchObject({ state: 'cancelled' });
    expect(repo.approveRequest(made.requestId, 'local-rpc:web', now)).toBe('not_pending');
    const done = repo.completeRequest(
      made.requestId,
      phone.publicKeyB64,
      proof(phone, made.requestId, bound.bindNonce),
      now
    );
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.reason).toBe('cancelled');
  });

  test('a denied request cannot complete', () => {
    const made = repo.createRequest(now);
    const phone = phoneKeypair();
    const bound = repo.bindTicket(made.ticket, phone.publicKeyB64, null, now);
    if (!bound.ok) throw new Error('bind failed');
    repo.approveRequest(made.requestId, 'local-rpc:web', now);
    expect(repo.denyRequest(made.requestId, now)).toBe(true);
    const done = repo.completeRequest(
      made.requestId,
      phone.publicKeyB64,
      proof(phone, made.requestId, bound.bindNonce),
      now
    );
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.reason).toBe('denied');
  });

  test('approval requires a bound ticket', () => {
    const made = repo.createRequest(now);
    expect(repo.approveRequest(made.requestId, 'local-rpc:web', now)).toBe('not_pending');
  });

  test('two simultaneous first-owner approvals grant exactly one owner', () => {
    const madeA = repo.createRequest(now);
    const madeB = repo.createRequest(now);
    const phoneA = phoneKeypair();
    const phoneB = phoneKeypair();
    const boundA = repo.bindTicket(madeA.ticket, phoneA.publicKeyB64, null, now);
    const boundB = repo.bindTicket(madeB.ticket, phoneB.publicKeyB64, null, now);
    if (!boundA.ok || !boundB.ok) throw new Error('bind failed');

    expect(repo.approveRequest(madeA.requestId, 'local-rpc:web', now)).toBe('approved');
    expect(repo.approveRequest(madeB.requestId, 'local-rpc:web', now)).toBe('approved');

    const first = repo.completeRequest(
      madeA.requestId,
      phoneA.publicKeyB64,
      proof(phoneA, madeA.requestId, boundA.bindNonce),
      now
    );
    expect(first.ok).toBe(true);
    const second = repo.completeRequest(
      madeB.requestId,
      phoneB.publicKeyB64,
      proof(phoneB, madeB.requestId, boundB.bindNonce),
      now
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('superseded');
    expect(devices.countDevices().humans).toBe(1);
    expect(repo.requestStatus(madeB.requestId, now)).toMatchObject({ state: 'cancelled' });
  });

  test('owner approvals after the first device do not grant owner', () => {
    const bootstrap = repo.createRequest(now);
    const owner = phoneKeypair();
    const bound = repo.bindTicket(bootstrap.ticket, owner.publicKeyB64, null, now);
    if (!bound.ok) throw new Error('bind failed');
    repo.approveRequest(bootstrap.requestId, 'local-rpc:web', now);
    const first = repo.completeRequest(
      bootstrap.requestId,
      owner.publicKeyB64,
      proof(owner, bootstrap.requestId, bound.bindNonce),
      now
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.owner).toBe(true);
    const ownerDeviceId = devices.listDevices()[0].id;

    const second = repo.createRequest(now);
    const phone = phoneKeypair();
    const boundSecond = repo.bindTicket(second.ticket, phone.publicKeyB64, null, now);
    if (!boundSecond.ok) throw new Error('bind failed');
    expect(repo.approveRequest(second.requestId, ownerDeviceId, now)).toBe('approved');
    const done = repo.completeRequest(
      second.requestId,
      phone.publicKeyB64,
      proof(phone, second.requestId, boundSecond.bindNonce),
      now
    );
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.owner).toBe(false);
    expect(devices.countDevices().humans).toBe(2);
  });
});
