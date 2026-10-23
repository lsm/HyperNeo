import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTestDb } from '../../../helpers/database.ts';
import { createDatabaseOperationCatalog } from '../../../../src/lib/operations/database-catalog.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { onDeviceRevoked } from '../../../../src/lib/pairing/upgrade-auth.ts';
import {
  DevicePairingRepository,
  touchDevice,
} from '../../../../src/storage/repositories/device-pairing-repository.ts';

const door: OperationCaller = { source: 'mcp', principal: 'session-door', sessionId: 'cli' };
let db: Awaited<ReturnType<typeof createTestDb>>;
let repo: DevicePairingRepository;
let registry: ReturnType<typeof createDatabaseOperationCatalog>;
beforeEach(async () => {
  db = await createTestDb();
  repo = new DevicePairingRepository(db.getDatabase());
  registry = createDatabaseOperationCatalog(db);
});
afterEach(() => db.close());
async function call(name: string, input = {}, caller = door) {
  const result = await invokeOperation(registry, name, input, caller);
  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') throw new Error(result.message);
  return result.value as { ok: boolean; reason?: string; code: string; approval: string };
}
function pair(kind: 'human' | 'relay' | 'daemon', name: string) {
  const made = repo.createCode(kind, name, true, Date.now());
  return repo.redeem(made.code, name, Date.now())!;
}
function notices() {
  return db
    .getDatabase()
    .prepare('SELECT payload_json FROM neo_publications ORDER BY sequence')
    .all() as { payload_json: string }[];
}

test('reset revokes only human credentials, closes their sockets and retains a notice and all history', async () => {
  const phone = pair('human', 'Lost phone'),
    relay = pair('relay', 'Relay'),
    peer = pair('daemon', 'Mac');
  const closed: string[] = [];
  const off = onDeviceRevoked((id) => closed.push(id));
  try {
    expect(await call('device.reset_human')).toMatchObject({ ok: true });
    expect(closed).toEqual([phone.device.id]);
    expect(
      touchDevice.run(db.getDatabase(), {
        credential: phone.credential,
        host: null,
        now: Date.now(),
      })
    ).toBeNull();
    expect(
      touchDevice.run(db.getDatabase(), {
        credential: relay.credential,
        host: null,
        now: Date.now(),
      })?.id
    ).toBe(relay.device.id);
    expect(
      touchDevice.run(db.getDatabase(), {
        credential: peer.credential,
        host: null,
        now: Date.now(),
      })?.id
    ).toBe(peer.device.id);
    expect(repo.listDevices()).toHaveLength(3);
    expect(repo.listDevices().find((d) => d.id === phone.device.id)?.revokedAt).toEqual(
      expect.any(Number)
    );
    const text = JSON.stringify(notices());
    expect(text).toContain('Lost phone');
    expect(text).toContain(phone.device.id);
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}T/);
    for (const credential of [phone.credential, relay.credential, peer.credential])
      expect(text).not.toContain(credential);
  } finally {
    off();
  }
});

test('only the local session door resets; network callers and agent operations cannot', async () => {
  const phone = pair('human', 'Phone');
  for (const caller of [
    { source: 'rpc', principal: 'local' },
    { source: 'rpc', principal: 'local', device: { deviceId: phone.device.id, kind: 'human' } },
    { source: 'mcp', role: 'neo', sessionId: 'neo:root' },
  ] as OperationCaller[])
    expect(await call('device.reset_human', {}, caller)).toMatchObject({ ok: false });
  expect(repo.isActiveDevice(phone.device.id)).toBe(true);
  expect(notices()).toHaveLength(0);
});

test('one replacement human consumes recovery; old codes and extra recovery codes cannot bypass Allow', async () => {
  const phone = pair('human', 'Lost phone');
  pair('relay', 'Relay');
  const old = repo.createCode('human', null, true, Date.now());
  expect(await call('device.reset_human')).toMatchObject({ ok: true });
  expect(repo.redeem(old.code, 'Old code', Date.now())).toBeNull();
  expect(await call('device.pair.create', { kind: 'relay' })).toMatchObject({ ok: false });
  const first = await call('device.pair.create', { kind: 'human' });
  const second = await call('device.pair.create', { kind: 'human' });
  expect(first.approval).toBe('approved');
  expect(second.approval).toBe('approved');
  repo = new DevicePairingRepository(db.getDatabase());
  const replacement = repo.redeem(first.code, 'Replacement phone', Date.now());
  expect(replacement?.device.kind).toBe('human');
  expect(repo.redeem(second.code, 'Extra device', Date.now())).toBeNull();
  expect(repo.isAwaitingApproval(second.code, Date.now())).toBe(true);
  expect(await call('device.pair.create', { kind: 'human' })).toMatchObject({
    approval: 'pending',
  });
  expect(repo.isActiveDevice(phone.device.id)).toBe(false);
});

test('ordinary revoke never enables recovery and repeated empty resets each retain a notice', async () => {
  const phone = pair('human', 'Phone');
  expect(await call('device.revoke', { deviceId: phone.device.id })).toMatchObject({ ok: true });
  expect(await call('device.pair.create', { kind: 'human' })).toMatchObject({
    ok: false,
    reason: expect.stringContaining('hyperneo devices reset-human'),
  });
  expect(await call('device.reset_human')).toMatchObject({ ok: true });
  expect(await call('device.reset_human')).toMatchObject({ ok: true });
  expect(notices()).toHaveLength(2);
  expect(repo.listDevices()).toHaveLength(1);
});

test('a failed notice rolls back revocation, recovery and code invalidation atomically', async () => {
  const phone = pair('human', 'Phone');
  const code = repo.createCode('human', null, true, Date.now());
  db.getDatabase().exec(
    "CREATE TRIGGER fail_notice BEFORE INSERT ON neo_publications BEGIN SELECT RAISE(ABORT, 'synthetic notice fault'); END"
  );
  expect(await invokeOperation(registry, 'device.reset_human', {}, door)).toMatchObject({
    kind: 'failed',
    code: 'execution_failed',
    message: expect.stringContaining('synthetic notice fault'),
  });
  expect(repo.isActiveDevice(phone.device.id)).toBe(true);
  expect(repo.redeem(code.code, 'Previously approved', Date.now())).not.toBeNull();
  expect(notices()).toHaveLength(0);
});

test('a long device list is retained across bounded notices without dropping any device', async () => {
  const ids = Array.from(
    { length: 21 },
    (_, index) => pair('human', `${index}: ${'\\'.repeat(75)}`).device.id
  );
  expect(await call('device.reset_human')).toMatchObject({ ok: true });
  expect(notices()).toHaveLength(2);
  const text = JSON.stringify(notices());
  for (const id of ids) expect(text).toContain(id);
  expect(repo.listDevices()).toHaveLength(21);
});
