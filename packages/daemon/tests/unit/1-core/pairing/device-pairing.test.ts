import { describe, expect, test } from 'bun:test';
import { createPairingLimiter } from '../../../../src/lib/pairing/pairing-limiter.ts';
import { createPairRoute } from '../../../../src/lib/pairing/pair-route.ts';
import {
  ALLOW_NEEDS_PAIRED_HUMAN,
  createDevicePairingOperations,
  NEEDS_PAIRED_HUMAN,
  NO_HUMAN_DEVICE,
} from '../../../../src/lib/pairing/pairing-operations.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import {
  DevicePairingRepository,
  recordWouldRefuse,
} from '../../../../src/storage/repositories/device-pairing-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const MINUTE = 60_000;

function setup(start = 1_000_000) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  let now = start;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  const repo = new DevicePairingRepository(db);
  const limiter = createPairingLimiter();
  const route = createPairRoute({ repo, limiter, now: clock.now });
  const revoked: string[] = [];
  const ops = createDevicePairingOperations({
    repo: () => repo,
    limiter,
    now: clock.now,
    revoked: (deviceId) => revoked.push(deviceId),
  });
  const call = (name: string, input: unknown, caller: OperationCaller) => {
    const op = ops.find((item) => item.name === name)!;
    return op.execute(op.inputSchema.parse(input), caller) as Promise<Record<string, any>>;
  };
  const pair = async (code: string, name = 'Phone') => {
    const response = await route(
      new Request('http://127.0.0.1/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, name }),
      })
    );
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { db, clock, repo, call, pair, revoked };
}

const human: OperationCaller = { source: 'rpc', principal: 'local' };
const pairedHuman = (deviceId: string): OperationCaller => ({
  source: 'rpc',
  principal: 'local',
  device: { deviceId, kind: 'human' },
});
const door: OperationCaller = { source: 'mcp', principal: 'session-door', sessionId: 'cli' };
const agent: OperationCaller = { source: 'mcp', sessionId: 'neo:root', role: 'neo' };

describe('device pairing', () => {
  test('a code pairs one device once, with the kind fixed when the code was made', async () => {
    const { db, call, pair } = setup();
    const made = await call('device.pair.create', { kind: 'relay', name: 'Push relay' }, door);
    expect(made.ok).toBe(true);
    expect(made.code).toMatch(/^[A-Z2-7]{10}$/);
    const first = await pair(made.code, 'Relay on iMac');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ kind: 'relay', deviceId: expect.any(String) });
    expect(first.body.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await pair(made.code)).status).toBe(401);
    const stored = JSON.stringify(db.prepare('SELECT * FROM paired_devices').all());
    expect(stored).not.toContain(first.body.credential);
    expect(JSON.stringify(db.prepare('SELECT * FROM pairing_codes').all())).not.toContain(
      made.code
    );
    expect(db.prepare('SELECT name, kind FROM paired_devices').all()).toEqual([
      { name: 'Relay on iMac', kind: 'relay' },
    ]);
    db.close();
  });

  test('a code expires after 10 minutes, and spaces or lower case in a typed code still match', async () => {
    const { db, call, pair, clock } = setup();
    const late = await call('device.pair.create', { kind: 'human' }, human);
    clock.advance(10 * MINUTE + 1);
    expect((await pair(late.code)).status).toBe(401);
    const typed = await call('device.pair.create', { kind: 'human' }, human);
    const spaced = `${typed.code.slice(0, 5)} ${typed.code.slice(5)}`.toLowerCase();
    expect((await pair(spaced)).status).toBe(200);
    db.close();
  });

  test('only the local human or the session door can make or clear codes; an agent cannot', async () => {
    const { db, call } = setup();
    expect(await call('device.pair.create', { kind: 'human' }, agent)).toEqual({
      ok: false,
      reason: 'This action needs the user.',
    });
    expect(await call('device.pair.reset_lockout', {}, agent)).toMatchObject({ ok: false });
    expect(await call('device.pair.create', { kind: 'daemon' }, door)).toMatchObject({ ok: true });
    db.close();
  });

  test('the CLI pairs the first device alone; after that its codes wait for Allow on a paired device', async () => {
    const { db, call, pair } = setup();
    const first = await call('device.pair.create', { kind: 'human' }, door);
    expect(first.approval).toBe('approved');
    const laptop = await pair(first.code, 'Laptop');
    expect(laptop.status).toBe(200);
    const next = await call('device.pair.create', { kind: 'human' }, door);
    expect(next.approval).toBe('pending');
    expect(await pair(next.code, 'Agent')).toMatchObject({
      status: 403,
      body: { error: 'awaiting_approval' },
    });
    const pending = await call('device.pair.pending', {}, pairedHuman(laptop.body.deviceId));
    expect(pending.pending).toEqual([
      { id: next.codeId, kind: 'human', name: null, expiresAt: next.expiresAt },
    ]);
    expect(JSON.stringify(pending)).not.toContain(next.code);
    expect(await call('device.pair.approve', { codeId: next.codeId }, agent)).toMatchObject({
      ok: false,
    });
    expect(await call('device.pair.approve', { codeId: next.codeId }, door)).toMatchObject({
      ok: false,
    });
    expect(await call('device.pair.approve', { codeId: next.codeId }, human)).toEqual({
      ok: false,
      reason: ALLOW_NEEDS_PAIRED_HUMAN,
    });
    expect(
      await call('device.pair.approve', { codeId: next.codeId }, pairedHuman('phone'))
    ).toEqual({
      ok: false,
      reason: ALLOW_NEEDS_PAIRED_HUMAN,
    });
    expect(
      await call('device.pair.approve', { codeId: next.codeId }, pairedHuman(laptop.body.deviceId))
    ).toEqual({
      ok: true,
    });
    expect((await pair(next.code, 'Phone')).status).toBe(200);
    db.close();
  });

  test('only an active paired human can see codes waiting for Allow', async () => {
    const h = setup();
    try {
      const first = await h.call('device.pair.create', { kind: 'human' }, door);
      const phone = await h.pair(first.code);
      await h.call('device.pair.create', { kind: 'human', name: 'Not this device' }, door);
      for (const caller of [human, door, agent, pairedHuman('missing')])
        expect((await h.call('device.pair.pending', {}, caller)).ok).toBe(false);
      expect(
        (await h.call('device.pair.pending', {}, pairedHuman(phone.body.deviceId))).pending
      ).toHaveLength(1);
      h.repo.revokeDevice(phone.body.deviceId, h.clock.now());
      expect((await h.call('device.pair.pending', {}, pairedHuman(phone.body.deviceId))).ok).toBe(
        false
      );
    } finally {
      h.db.close();
    }
  });

  test('any paired device ends the first-device window; with no human device the CLI says pair the phone first', async () => {
    const { db, call, pair } = setup();
    const relay = await call('device.pair.create', { kind: 'relay' }, door);
    expect((await pair(relay.code, 'Relay')).status).toBe(200);
    expect(await call('device.pair.create', { kind: 'human' }, door)).toEqual({
      ok: false,
      reason: NO_HUMAN_DEVICE,
    });
    expect(await call('device.pair.create', { kind: 'human' }, human)).toEqual({
      ok: false,
      reason: NO_HUMAN_DEVICE,
    });
    db.close();
  });

  test('a phone unpaired after it connected can no longer Allow from that connection', async () => {
    const { db, call, pair } = setup();
    const phone = await pair((await call('device.pair.create', { kind: 'human' }, door)).code);
    const waiting = await call('device.pair.create', { kind: 'human' }, door);
    db.prepare('UPDATE paired_devices SET revoked_at = 1').run();
    expect(
      await call(
        'device.pair.approve',
        { codeId: waiting.codeId },
        pairedHuman(phone.body.deviceId)
      )
    ).toEqual({ ok: false, reason: ALLOW_NEEDS_PAIRED_HUMAN });
    db.close();
  });

  test('once a human device is paired, a code made in an unpaired browser waits for its Allow', async () => {
    const { db, call, pair } = setup();
    expect((await call('device.pair.create', { kind: 'human' }, human)).approval).toBe('approved');
    const first = await call('device.pair.create', { kind: 'human' }, door);
    const phone = await pair(first.code, 'Phone');
    expect((await call('device.pair.create', { kind: 'human' }, human)).approval).toBe('pending');
    expect(
      (await call('device.pair.create', { kind: 'human' }, pairedHuman(phone.body.deviceId)))
        .approval
    ).toBe('approved');
    db.close();
  });

  test('the CLI lists paired devices without secrets and revokes one, closing its connections', async () => {
    const { db, call, pair, revoked } = setup();
    const phone = await pair((await call('device.pair.create', { kind: 'human' }, door)).code);
    const relayCode = await call('device.pair.create', { kind: 'relay' }, door);
    const phoneCaller = pairedHuman(phone.body.deviceId);
    await call('device.pair.approve', { codeId: relayCode.codeId }, phoneCaller);
    const relay = await pair(relayCode.code, 'Relay');
    const listed = await call('device.list', {}, door);
    expect(listed.devices).toEqual([
      expect.objectContaining({
        id: phone.body.deviceId,
        name: 'Phone',
        kind: 'human',
        revokedAt: null,
      }),
      expect.objectContaining({
        id: relay.body.deviceId,
        name: 'Relay',
        kind: 'relay',
        revokedAt: null,
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(relay.body.credential);
    expect(await call('device.revoke', { deviceId: relay.body.deviceId }, agent)).toMatchObject({
      ok: false,
    });
    expect(await call('device.revoke', { deviceId: relay.body.deviceId }, human)).toEqual({
      ok: false,
      reason: NEEDS_PAIRED_HUMAN,
    });
    expect(await call('device.revoke', { deviceId: relay.body.deviceId }, door)).toEqual({
      ok: true,
    });
    expect(revoked).toEqual([relay.body.deviceId]);
    expect(await call('device.revoke', { deviceId: relay.body.deviceId }, phoneCaller)).toEqual({
      ok: false,
      reason: 'not_found: no paired device with that id.',
    });
    const seenByPhone = (await call('device.list', {}, phoneCaller)).devices;
    expect(seenByPhone.map((device: { current: boolean }) => device.current)).toEqual([
      true,
      false,
    ]);
    expect(seenByPhone[1].revokedAt).toBeNumber();
    db.close();
  });

  test('revoking the only phone does not reopen pairing without Allow', async () => {
    const { db, call, pair } = setup();
    const phone = await pair((await call('device.pair.create', { kind: 'human' }, door)).code);
    expect(await call('device.revoke', { deviceId: phone.body.deviceId }, door)).toEqual({
      ok: true,
    });
    expect(await call('device.pair.create', { kind: 'human' }, door)).toEqual({
      ok: false,
      reason: NO_HUMAN_DEVICE,
    });
    db.close();
  });

  test('a browser gets its credential only as an HttpOnly cookie, Secure when its page is HTTPS', async () => {
    const { repo } = setup();
    const route = createPairRoute({ repo, limiter: createPairingLimiter(), now: () => 1_000_000 });
    const redeem = async (origin: string) => {
      const made = repo.createCode('human', null, true, 1_000_000);
      const response = await route(
        new Request(`${origin}/pair`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin },
          body: JSON.stringify({ code: made.code, name: 'Browser' }),
        })
      );
      return { response, body: (await response.json()) as Record<string, unknown> };
    };
    const served = await redeem('https://mac.tailnet.ts.net');
    expect(served.response.status).toBe(200);
    expect(served.body).toEqual({ deviceId: expect.any(String), kind: 'human' });
    const cookie = served.response.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^hyperneo_device=[A-Za-z0-9_-]{43}; /);
    expect(cookie.split('; ').slice(1).sort()).toEqual(
      ['HttpOnly', 'Max-Age=34560000', 'Path=/', 'SameSite=Strict', 'Secure'].sort()
    );
    expect(
      repo.touchDevice(cookie.slice('hyperneo_device='.length, cookie.indexOf(';')), 'h', 1)
    ).toMatchObject({ kind: 'human' });
    const plain = await redeem('http://127.0.0.1:9283');
    expect(plain.response.headers.get('set-cookie')).not.toContain('Secure');
  });

  test('a paired human or the CLI reads the unpaired connections seen, newest first', async () => {
    const { db, call, pair, repo } = setup();
    repo.recordUnpaired(
      {
        client: 'native',
        origin: null,
        host: 'mac:9283',
        remoteAddress: '10.0.0.2',
        credentialRejected: false,
      },
      1_000
    );
    repo.recordUnpaired(
      {
        client: 'browser',
        origin: 'https://evil.example',
        host: 'mac:9283',
        remoteAddress: '10.0.0.3',
        credentialRejected: true,
      },
      2_000
    );
    expect(await call('device.unpaired.list', {}, human)).toEqual({
      ok: false,
      reason: NEEDS_PAIRED_HUMAN,
    });
    const phone = await pair((await call('device.pair.create', { kind: 'human' }, door)).code);
    const seen = await call('device.unpaired.list', {}, pairedHuman(phone.body.deviceId));
    expect(seen).toEqual({
      ok: true,
      connections: [
        {
          client: 'browser',
          origin: 'https://evil.example',
          host: 'mac:9283',
          remoteAddress: '10.0.0.3',
          credentialRejected: true,
          count: 1,
          firstSeenAt: 2_000,
          lastSeenAt: 2_000,
        },
        {
          client: 'native',
          origin: null,
          host: 'mac:9283',
          remoteAddress: '10.0.0.2',
          credentialRejected: false,
          count: 1,
          firstSeenAt: 1_000,
          lastSeenAt: 1_000,
        },
      ],
    });
    expect((await call('device.unpaired.list', {}, door)).ok).toBe(true);
    db.close();
  });

  test('a paired human or the CLI reads the requests Origin/Host checks would refuse', async () => {
    const { db, call, pair, repo } = setup();
    recordWouldRefuse.run(db, {
      seen: { reason: 'host_not_allowed', kind: 'ws', host: 'mac.ts.net', origin: null },
      now: 5,
    });
    expect(await call('device.would_refuse.list', {}, human)).toEqual({
      ok: false,
      reason: NEEDS_PAIRED_HUMAN,
    });
    const phone = await pair((await call('device.pair.create', { kind: 'human' }, door)).code);
    expect(await call('device.would_refuse.list', {}, pairedHuman(phone.body.deviceId))).toEqual({
      ok: true,
      requests: [
        {
          reason: 'host_not_allowed',
          kind: 'ws',
          host: 'mac.ts.net',
          origin: null,
          count: 1,
          firstSeenAt: 5,
          lastSeenAt: 5,
        },
      ],
    });
    db.close();
  });

  test('bad codes are limited to 5 a minute, 20 lock pairing for 15 minutes, and a local reset reopens it', async () => {
    const { db, call, pair, clock } = setup();
    for (let i = 0; i < 5; i++) expect((await pair('AAAAAAAAAA')).status).toBe(401);
    const limited = await pair('AAAAAAAAAA');
    expect(limited).toMatchObject({ status: 429, body: { error: 'pairing_rate_limited' } });
    for (let round = 0; round < 3; round++) {
      clock.advance(MINUTE);
      for (let i = 0; i < 5; i++) await pair('AAAAAAAAAA');
    }
    const good = await call('device.pair.create', { kind: 'human' }, human);
    clock.advance(MINUTE);
    expect(await pair(good.code)).toMatchObject({ status: 429, body: { error: 'pairing_locked' } });
    clock.advance(15 * MINUTE - 2 * MINUTE);
    expect((await pair(good.code)).status).toBe(429);
    expect(await call('device.pair.reset_lockout', {}, door)).toEqual({ ok: true });
    const fresh = await call('device.pair.create', { kind: 'human' }, human);
    expect((await pair(fresh.code)).status).toBe(200);
    db.close();
  });

  test('pairing answers only POST with a code and a name, and never echoes the code', async () => {
    const { db, pair } = setup();
    const bad = await pair('');
    expect(bad).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    const wrong = await pair('BBBBBBBBBB');
    expect(JSON.stringify(wrong.body)).not.toContain('BBBBBBBBBB');
    db.close();
  });

  test('an oversized or malformed pairing body is refused unread and counts against the limit', async () => {
    const { db, call, clock } = setup();
    const repo = new DevicePairingRepository(db);
    const route = createPairRoute({ repo, limiter: createPairingLimiter(), now: clock.now });
    const post = (body: string) =>
      route(new Request('http://127.0.0.1/pair', { method: 'POST', body }));
    expect((await post('x'.repeat(1_000_000))).status).toBe(413);
    for (let i = 0; i < 4; i++) expect((await post('{not json')).status).toBe(400);
    expect((await post('{"code":"AAAAAAAAAA","name":"x"}')).status).toBe(429);
    expect((await call('device.pair.create', { kind: 'human' }, human)).ok).toBe(true);
    db.close();
  });
});
