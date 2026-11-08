import { createPairWaits } from '../../../../src/lib/pairing/pair-waits.ts';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { pairFingerprint } from '../../../../src/lib/pairing/pair-fingerprint.ts';
import { createPairingLimiter } from '../../../../src/lib/pairing/pairing-limiter.ts';
import { createPairRoute } from '../../../../src/lib/pairing/pair-route.ts';
import { createDevicePairingOperations } from '../../../../src/lib/pairing/pairing-operations.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const REQUEST = '00112233445566778899aabbccddeeff';
const OTHER = 'ffeeddccbbaa99887766554433221100';

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.prepare(
    "INSERT INTO paired_devices (id, name, kind, secret_hash, created_at) VALUES ('local-rpc:terminal', 'Local tools', 'human', 'x', 1)"
  ).run();
  const now = 1_000_000;
  const repo = new DevicePairingRepository(db);
  const route = createPairRoute({
    waits: createPairWaits(),
    repo,
    limiter: createPairingLimiter(),
    now: () => now,
  });
  const ops = createDevicePairingOperations({
    waits: createPairWaits(),
    repo: () => repo,
    limiter: createPairingLimiter(),
    now: () => now,
    revoked: () => {},
  });
  const call = (name: string, input: unknown, caller: OperationCaller) => {
    const op = ops.find((item) => item.name === name)!;
    return op.execute(op.inputSchema.parse(input), caller) as Promise<Record<string, any>>;
  };
  const pair = async (code: string, requestId?: string) => {
    const response = await route(
      new Request('http://127.0.0.1/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, name: 'New phone', ...(requestId ? { requestId } : {}) }),
      })
    );
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const fingerprintOf = (code: string, requestId: string) =>
    pairFingerprint(sha256(code), sha256(requestId));
  return { db, repo, call, pair, fingerprintOf };
}

const door: OperationCaller = {
  source: 'mcp',
  principal: 'session-door',
  sessionId: 'cli',
  device: { deviceId: 'local-rpc:terminal', kind: 'human' },
};
const localTools: OperationCaller = {
  source: 'rpc',
  principal: 'local',
  device: { deviceId: 'local-rpc:terminal', kind: 'human' },
};
const phone = (deviceId: string): OperationCaller => ({
  source: 'rpc',
  principal: 'local',
  device: { deviceId, kind: 'human' },
});

async function withFirstPhone(t: ReturnType<typeof setup>) {
  const first = t.repo.createCode('human', 'First phone', true, 1_000_000);
  return t.repo.redeem(first.code, 'First phone', 1_000_000)!.device.id;
}

describe('pairFingerprint', () => {
  test('matches the shared test vector', () => {
    const codeHash = sha256('ABCDEFGH23');
    const requestedBy = sha256(REQUEST);
    expect(codeHash).toBe('17190666e16f8d07ca35531be8ac05a695b08ec80bc1ef7303ebf76bba91be49');
    expect(requestedBy).toBe('5947d7c33d783f94b3b4c1a96ebc8991ed28f1b069b71e03376cba8caa98a720');
    expect(pairFingerprint(codeHash, requestedBy).join(' ')).toBe(
      '3008 b30a 60a3 ac09 d97a 9655 80c6 7dcc'
    );
  });
});

describe('two-way pairing codes', () => {
  test('a two-way first-device code starts pending and needs a requestId', async () => {
    const t = setup();
    const made = await t.call('device.pair.create', { kind: 'human', confirm: 'two-way' }, door);
    expect(made).toMatchObject({ ok: true, approval: 'pending' });
    expect((await t.pair(made.code)).status).toBe(401);
    expect(
      t.db.prepare('SELECT requested_by FROM pairing_codes WHERE id = ?').get(made.codeId)
    ).toEqual({ requested_by: null });
    expect((await t.pair(made.code, REQUEST)).status).toBe(403);
  });

  test('two-way is only for human codes', async () => {
    const t = setup();
    expect(
      await t.call('device.pair.create', { kind: 'relay', confirm: 'two-way' }, door)
    ).toMatchObject({ ok: false });
  });

  test('pending shows seven fingerprint groups and never the last one', async () => {
    const t = setup();
    const phoneId = await withFirstPhone(t);
    const made = await t.call(
      'device.pair.create',
      { kind: 'human', confirm: 'two-way' },
      phone(phoneId)
    );
    await t.pair(made.code, REQUEST);
    const plain = await t.call('device.pair.create', { kind: 'human' }, door);
    const listed = await t.call('device.pair.pending', {}, phone(phoneId));
    const fingerprint = t.fingerprintOf(made.code, REQUEST);
    expect(listed.pending).toEqual([
      expect.objectContaining({ id: made.codeId, fingerprint: fingerprint.slice(0, 7) }),
      expect.objectContaining({ id: plain.codeId, fingerprint: null }),
    ]);
  });

  test('a paired phone approves with the right last group and only that requester redeems once', async () => {
    const t = setup();
    const phoneId = await withFirstPhone(t);
    const made = await t.call('device.pair.create', { kind: 'human', confirm: 'two-way' }, door);
    expect(made.approval).toBe('pending');
    expect(
      await t.call(
        'device.pair.approve',
        { codeId: made.codeId, lastGroup: 'abcd' },
        phone(phoneId)
      )
    ).toMatchObject({ ok: false, reason: expect.stringContaining('not_requested') });
    await t.pair(made.code, REQUEST);
    const lastGroup = t.fingerprintOf(made.code, REQUEST)[7];
    expect(
      await t.call(
        'device.pair.approve',
        { codeId: made.codeId, lastGroup: lastGroup.toUpperCase() },
        phone(phoneId)
      )
    ).toEqual({ ok: true });
    expect((await t.pair(made.code, OTHER)).status).toBe(409);
  });

  test('the requester gets the credential after approval and a second redeem fails', async () => {
    const t = setup();
    const phoneId = await withFirstPhone(t);
    const made = await t.call('device.pair.create', { kind: 'human', confirm: 'two-way' }, door);
    await t.pair(made.code, REQUEST);
    const lastGroup = t.fingerprintOf(made.code, REQUEST)[7];
    await t.call('device.pair.approve', { codeId: made.codeId, lastGroup }, phone(phoneId));
    expect((await t.pair(made.code, REQUEST)).status).toBe(200);
    expect((await t.pair(made.code, REQUEST)).status).toBe(401);
  });

  test('a wrong or missing last group denies the code', async () => {
    for (const lastGroup of [undefined, '0000']) {
      const t = setup();
      const phoneId = await withFirstPhone(t);
      const made = await t.call('device.pair.create', { kind: 'human', confirm: 'two-way' }, door);
      await t.pair(made.code, REQUEST);
      expect(
        await t.call(
          'device.pair.approve',
          { codeId: made.codeId, ...(lastGroup ? { lastGroup } : {}) },
          phone(phoneId)
        )
      ).toMatchObject({ ok: false, reason: expect.stringContaining('wrong_fingerprint') });
      expect((await t.pair(made.code, REQUEST)).status).toBe(401);
      expect(await t.call('device.pair.pending', {}, phone(phoneId))).toEqual({
        ok: true,
        pending: [],
      });
    }
  });
});

describe('terminal approval', () => {
  test('pairs the first device by QR end to end from the terminal', async () => {
    const t = setup();
    const made = await t.call('device.pair.create', { kind: 'human', confirm: 'two-way' }, door);
    expect(made).toMatchObject({ ok: true, approval: 'pending' });
    expect((await t.pair(made.code, REQUEST)).status).toBe(403);
    const fingerprint = t.fingerprintOf(made.code, REQUEST);
    expect((await t.call('device.pair.pending', {}, door)).pending).toEqual([
      expect.objectContaining({
        id: made.codeId,
        requestedName: 'New phone',
        fingerprint: fingerprint.slice(0, 7),
      }),
    ]);
    expect(
      await t.call('device.pair.approve', { codeId: made.codeId, lastGroup: fingerprint[7] }, door)
    ).toEqual({ ok: true });
    expect((await t.pair(made.code, REQUEST)).status).toBe(200);
    expect((await t.pair(made.code, REQUEST)).status).toBe(401);
  });

  test('is on by default, so local tools approve legacy and two-way codes', async () => {
    const t = setup();
    await withFirstPhone(t);
    expect(await t.call('device.pair.terminal_approval.get', {}, door)).toEqual({
      ok: true,
      enabled: true,
    });
    const legacy = await t.call('device.pair.create', { kind: 'human' }, door);
    const twoWay = await t.call('device.pair.create', { kind: 'human', confirm: 'two-way' }, door);
    await t.pair(twoWay.code, REQUEST);
    expect(await t.call('device.pair.approve', { codeId: legacy.codeId }, localTools)).toEqual({
      ok: true,
    });
    expect(
      await t.call('device.pair.approve', { codeId: twoWay.codeId, lastGroup: '0000' }, door)
    ).toMatchObject({ ok: false, reason: expect.stringContaining('wrong_fingerprint') });
    const again = await t.call('device.pair.create', { kind: 'human', confirm: 'two-way' }, door);
    await t.pair(again.code, OTHER);
    expect(
      await t.call(
        'device.pair.approve',
        { codeId: again.codeId, lastGroup: t.fingerprintOf(again.code, OTHER)[7] },
        localTools
      )
    ).toEqual({ ok: true });
  });

  test('once off, local tools approve neither legacy nor two-way codes, and pending is closed to them', async () => {
    const t = setup();
    const phoneId = await withFirstPhone(t);
    expect(await t.call('device.pair.terminal_approval.set', { enabled: false }, door)).toEqual({
      ok: true,
      enabled: false,
    });
    const legacy = await t.call('device.pair.create', { kind: 'human' }, door);
    const twoWay = await t.call('device.pair.create', { kind: 'human', confirm: 'two-way' }, door);
    await t.pair(twoWay.code, REQUEST);
    const lastGroup = t.fingerprintOf(twoWay.code, REQUEST)[7];
    for (const caller of [door, localTools]) {
      expect(await t.call('device.pair.approve', { codeId: legacy.codeId }, caller)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('not_paired'),
      });
      expect(
        await t.call('device.pair.approve', { codeId: twoWay.codeId, lastGroup }, caller)
      ).toMatchObject({ ok: false, reason: expect.stringContaining('not_paired') });
      expect(await t.call('device.pair.pending', {}, caller)).toMatchObject({ ok: false });
    }
    expect(
      await t.call('device.pair.approve', { codeId: twoWay.codeId, lastGroup }, phone(phoneId))
    ).toEqual({ ok: true });
    expect(await t.call('device.pair.approve', { codeId: legacy.codeId }, phone(phoneId))).toEqual({
      ok: true,
    });
  });

  test('anyone local turns it off; only a paired phone turns it back on', async () => {
    const t = setup();
    const phoneId = await withFirstPhone(t);
    await t.call('device.pair.terminal_approval.set', { enabled: false }, localTools);
    for (const caller of [door, localTools])
      expect(
        await t.call('device.pair.terminal_approval.set', { enabled: true }, caller)
      ).toMatchObject({ ok: false, reason: expect.stringContaining('not_paired') });
    expect(await t.call('device.pair.terminal_approval.get', {}, door)).toEqual({
      ok: true,
      enabled: false,
    });
    expect(
      await t.call('device.pair.terminal_approval.set', { enabled: true }, phone(phoneId))
    ).toEqual({ ok: true, enabled: true });
    expect(await t.call('device.pair.terminal_approval.get', {}, door)).toEqual({
      ok: true,
      enabled: true,
    });
  });
});
