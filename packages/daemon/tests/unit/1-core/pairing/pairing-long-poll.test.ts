import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { pairFingerprint } from '../../../../src/lib/pairing/pair-fingerprint.ts';
import { createPairWaits } from '../../../../src/lib/pairing/pair-waits.ts';
import { createPairingLimiter } from '../../../../src/lib/pairing/pairing-limiter.ts';
import { createPairRoute } from '../../../../src/lib/pairing/pair-route.ts';
import { createDevicePairingOperations } from '../../../../src/lib/pairing/pairing-operations.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const REQUEST = '00112233445566778899aabbccddeeff';
const door: OperationCaller = {
  source: 'mcp',
  principal: 'session-door',
  sessionId: 'cli',
  device: { deviceId: 'local-rpc:terminal', kind: 'human' },
};

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.prepare(
    "INSERT INTO paired_devices (id, name, kind, secret_hash, created_at) VALUES ('local-rpc:terminal', 'Local tools', 'human', 'x', 1)"
  ).run();
  const repo = new DevicePairingRepository(db);
  const waits = createPairWaits();
  const route = createPairRoute({ repo, limiter: createPairingLimiter(), now: Date.now, waits });
  const ops = createDevicePairingOperations({
    repo: () => repo,
    limiter: createPairingLimiter(),
    now: Date.now,
    revoked: () => {},
    waits,
  });
  const call = (name: string, input: unknown, caller = door) => {
    const op = ops.find((item) => item.name === name)!;
    return op.execute(op.inputSchema.parse(input), caller) as Promise<Record<string, any>>;
  };
  const pair = async (code: string, requestId?: string, signal?: AbortSignal) => {
    const response = await route(
      new Request('http://127.0.0.1/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, name: 'New phone', ...(requestId ? { requestId } : {}) }),
        signal,
      })
    );
    return response.status;
  };
  const refusal = async (code: string, requestId?: string) => {
    const response = await route(
      new Request('http://127.0.0.1/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, name: 'New phone', ...(requestId ? { requestId } : {}) }),
      })
    );
    const body = (await response.json()) as { error?: string; deviceId?: string };
    return {
      status: response.status,
      ...(body.error ? { error: body.error } : {}),
      deviceId: body.deviceId,
    };
  };
  const twoWay = async () => {
    const made = await call('device.pair.create', { kind: 'human', confirm: 'two-way' });
    expect(await pair(made.code, REQUEST)).toBe(403);
    const lastGroup = pairFingerprint(sha256(made.code), sha256(REQUEST))[7];
    return { ...made, lastGroup } as Record<string, any>;
  };
  return { db, call, pair, refusal, twoWay };
}

const settledWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

describe('createPairWaits', () => {
  test('holds one request per code until released or timed out', async () => {
    const waits = createPairWaits();
    const held = waits.hold('code-1', 10_000);
    expect(await waits.hold('code-1', 10_000)).toBe(false);
    waits.release('code-1');
    expect(await held).toBe(true);
    expect(await waits.hold('code-2', 5)).toBe(true);
    const client = new AbortController();
    const left = waits.hold('code-3', 10_000, client.signal);
    client.abort();
    expect(await left).toBe(false);
  });
});

describe('pairing long-poll', () => {
  test('a confirmed phone is held until approval and then gets its credential', async () => {
    const t = setup();
    const made = await t.twoWay();
    const waiting = t.pair(made.code, REQUEST);
    expect(await settledWithin(waiting, 50)).toBe(false);
    expect(
      await t.call('device.pair.approve', { codeId: made.codeId, lastGroup: made.lastGroup })
    ).toEqual({
      ok: true,
    });
    expect(await waiting).toBe(200);
  });

  test('a wrong last group releases the held phone with a refusal', async () => {
    const t = setup();
    const made = await t.twoWay();
    const waiting = t.refusal(made.code, REQUEST);
    expect(await settledWithin(waiting, 50)).toBe(false);
    await t.call('device.pair.approve', { codeId: made.codeId, lastGroup: '0000' });
    expect(await waiting).toMatchObject({ status: 401, error: 'code_denied' });
  });

  test('a second hold for the same code answers at once', async () => {
    const t = setup();
    const made = await t.twoWay();
    const first = t.pair(made.code, REQUEST);
    expect(await settledWithin(first, 50)).toBe(false);
    expect(await settledWithin(t.pair(made.code, REQUEST), 50)).toBe(true);
    await t.call('device.pair.approve', { codeId: made.codeId, lastGroup: made.lastGroup });
    expect(await first).toBe(200);
  });

  test('the hold ends when the code expires', async () => {
    const t = setup();
    const made = await t.twoWay();
    t.db
      .prepare('UPDATE pairing_codes SET expires_at = ? WHERE id = ?')
      .run(Date.now() + 100, made.codeId);
    expect(await t.refusal(made.code, REQUEST)).toMatchObject({
      status: 401,
      error: 'code_expired',
    });
  });

  test('a denied, expired, unknown or spent code each says which', async () => {
    const t = setup();
    const first = await t.call('device.pair.create', { kind: 'human' });
    const phone = await t.refusal(first.code);
    expect(phone.status).toBe(200);
    expect(await t.refusal(first.code)).toMatchObject({ status: 401, error: 'invalid_code' });
    const later = await t.call('device.pair.create', { kind: 'human' });
    expect(
      await t.call(
        'device.pair.deny',
        { codeId: later.codeId },
        { source: 'rpc', principal: 'local', device: { deviceId: phone.deviceId!, kind: 'human' } }
      )
    ).toEqual({ ok: true });
    expect(await t.refusal(later.code)).toMatchObject({ status: 401, error: 'code_denied' });
    const old = await t.call('device.pair.create', { kind: 'human' });
    t.db.prepare('UPDATE pairing_codes SET expires_at = 1 WHERE id = ?').run(old.codeId);
    expect(await t.refusal(old.code)).toMatchObject({ status: 401, error: 'code_expired' });
    expect(await t.refusal('ZZZZZZZZZZ')).toMatchObject({ status: 401, error: 'invalid_code' });
  });

  test('a disconnected phone frees the hold', async () => {
    const t = setup();
    const made = await t.twoWay();
    const controller = new AbortController();
    const gone = t.pair(made.code, REQUEST, controller.signal);
    expect(await settledWithin(gone, 50)).toBe(false);
    controller.abort();
    expect(await settledWithin(gone, 200)).toBe(true);
    const next = t.pair(made.code, REQUEST);
    expect(await settledWithin(next, 50)).toBe(false);
    await t.call('device.pair.approve', { codeId: made.codeId, lastGroup: made.lastGroup });
    expect(await next).toBe(200);
  });

  test('requests without a requestId are never held', async () => {
    const t = setup();
    const phone = await t.call('device.pair.create', { kind: 'human' });
    expect(await t.pair(phone.code)).toBe(200);
    const later = await t.call('device.pair.create', { kind: 'human' });
    expect(await t.pair(later.code)).toBe(403);
    expect(await settledWithin(t.pair(later.code), 50)).toBe(true);
  });
});
