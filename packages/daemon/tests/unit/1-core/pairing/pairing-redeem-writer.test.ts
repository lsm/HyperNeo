import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createPairRoute } from '../../../../src/lib/pairing/pair-route';
import { createPairingLimiter } from '../../../../src/lib/pairing/pairing-limiter';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('HTTP pairing redemption writer', () => {
  let main: Database;
  let writer: Database;
  let gateway: DbGateway;
  let repo: DevicePairingRepository;
  let route: ReturnType<typeof createPairRoute>;
  let mainSql: number;
  const now = 1_000_000;

  beforeEach(() => {
    main = new Database(':memory:');
    writer = new Database(':memory:');
    runMigrations(writer, () => {});
    createTables(writer);
    repo = new DevicePairingRepository(writer);
    gateway = new DbGateway(':memory:', writer);
    bindGateway(main, gateway);
    route = createPairRoute({
      repo: new DevicePairingRepository(main),
      limiter: createPairingLimiter(),
      now: () => now,
    });
    mainSql = 0;
    main.prepare = () => {
      mainSql++;
      throw new Error('pairing redemption SQL reached main');
    };
  });

  afterEach(async () => {
    await gateway.close();
    main.close();
    writer.close();
  });

  const pair = (code: string, origin?: string) =>
    route(
      new Request('http://localhost/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify({ code, name: 'Synthetic phone' }),
      })
    );
  const row = (id: string) =>
    writer.prepare('SELECT used_at, approved_at FROM pairing_codes WHERE id = ?').get(id);

  test('native HTTP success follows committed single-use claim and hashed device insertion', async () => {
    const code = repo.createCode('relay', null, true, now);
    const response = await pair(code.code.toLowerCase());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { deviceId: string; credential: string; kind: string };
    expect(body.kind).toBe('relay');
    expect(body.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row(code.id)).toEqual({ used_at: now, approved_at: now });
    expect(
      writer.prepare('SELECT secret_hash FROM paired_devices WHERE id = ?').get(body.deviceId)
    ).toEqual({ secret_hash: createHash('sha256').update(body.credential).digest('hex') });
    expect((await pair(code.code)).status).toBe(401);
    expect(mainSql).toBe(0);
  });

  test('browser pairing keeps the credential in a secure HTTP-only cookie', async () => {
    const code = repo.createCode('human', null, true, now);
    const response = await pair(code.code, 'https://localhost');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deviceId: expect.any(String), kind: 'human' });
    expect(response.headers.get('set-cookie')).toMatch(
      /hyperneo_device=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=34560000; Secure/
    );
    expect(mainSql).toBe(0);
  });

  test('pending approval stays HTTP 403 without consuming the failure limit', async () => {
    const code = repo.createCode('human', null, false, now);
    for (let i = 0; i < 6; i++) {
      const response = await pair(code.code);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'awaiting_approval' });
    }
    expect(row(code.id)).toEqual({ used_at: null, approved_at: null });
    expect(mainSql).toBe(0);
  });

  test('invalid codes keep HTTP 401 and the fifth failure rate limit', async () => {
    for (let i = 0; i < 5; i++) expect((await pair('INVALIDCODE')).status).toBe(401);
    expect((await pair('INVALIDCODE')).status).toBe(429);
    expect(mainSql).toBe(0);
  });

  test('only one concurrent recovery code pairs and the other returns to awaiting approval', async () => {
    writer
      .prepare('INSERT INTO human_device_resets(id, reset_at, devices_json) VALUES (?, ?, ?)')
      .run('synthetic-reset', now, '[]');
    const first = repo.createCode('human', null, true, now);
    const second = repo.createCode('human', null, true, now);
    const replies = await Promise.all([pair(first.code), pair(second.code)]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(repo.listDevices()).toHaveLength(1);
    expect(repo.humanRecoveryOpen()).toBe(false);
    expect(mainSql).toBe(0);
  });

  test('failed device insertion rolls back the claim and recovery invalidation together', async () => {
    writer
      .prepare('INSERT INTO human_device_resets(id, reset_at, devices_json) VALUES (?, ?, ?)')
      .run('synthetic-reset', now, '[]');
    const code = repo.createCode('human', null, true, now);
    const peer = repo.createCode('human', null, true, now);
    writer.exec(
      "CREATE TRIGGER reject_pair BEFORE INSERT ON paired_devices BEGIN SELECT RAISE(ABORT, 'synthetic device insert failure'); END"
    );
    await expect(pair(code.code)).rejects.toThrow('synthetic device insert failure');
    expect(row(code.id)).toEqual({ used_at: null, approved_at: now });
    expect(row(peer.id)).toEqual({ used_at: null, approved_at: now });
    expect(repo.humanRecoveryOpen()).toBe(true);
    expect(repo.listDevices()).toEqual([]);
    expect(mainSql).toBe(0);
  });

  test('wrong HTTP method is refused before DB admission', async () => {
    expect((await route(new Request('http://localhost/pair'))).status).toBe(405);
    expect(mainSql).toBe(0);
  });

  test('malformed input is refused before DB admission', async () => {
    expect(
      (await route(new Request('http://localhost/pair', { method: 'POST', body: '{' }))).status
    ).toBe(400);
    expect(mainSql).toBe(0);
  });
});
