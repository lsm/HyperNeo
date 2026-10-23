import { describe, expect, spyOn, test } from 'bun:test';
import { Logger } from '../../../../src/lib/logger.ts';
import { createRequestObserver, judgeOriginHost } from '../../../../src/lib/pairing/origin-host.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const request = (headers: Record<string, string>, method = 'GET') =>
  new Request('http://127.0.0.1:9283/ws', { method, headers });

describe('judgeOriginHost', () => {
  test('loopback hosts, with or without a port, pass with a same-host Origin or none', () => {
    for (const host of ['127.0.0.1:9283', 'localhost', '[::1]:9283', 'LOCALHOST:9283'])
      expect(judgeOriginHost(request({ host, origin: `http://${host}` }), [])).toBeNull();
    expect(judgeOriginHost(request({ host: '127.0.0.1:9283' }), [])).toBeNull();
  });

  test('a host the human added passes, any other host would be refused', () => {
    const tailnet = request({ host: 'mac.tailnet.ts.net', origin: 'https://mac.tailnet.ts.net' });
    expect(judgeOriginHost(tailnet, ['Mac.Tailnet.ts.net'])).toBeNull();
    expect(judgeOriginHost(tailnet, [])).toEqual({
      reason: 'host_not_allowed',
      kind: 'http',
      host: 'mac.tailnet.ts.net',
      origin: 'https://mac.tailnet.ts.net',
    });
  });

  test('a foreign or opaque Origin would be refused, and its kind says what was asked', () => {
    expect(
      judgeOriginHost(
        request({ host: '127.0.0.1:9283', origin: 'https://evil.example', upgrade: 'websocket' }),
        []
      )
    ).toEqual({
      reason: 'origin_not_allowed',
      kind: 'ws',
      host: '127.0.0.1:9283',
      origin: 'https://evil.example',
    });
    expect(
      judgeOriginHost(request({ host: 'localhost', origin: 'null' }, 'OPTIONS'), [])
    ).toMatchObject({
      reason: 'origin_not_allowed',
      kind: 'preflight',
    });
    expect(judgeOriginHost(request({ host: 'localhost', origin: 'file://x' }), [])).toMatchObject({
      reason: 'origin_not_allowed',
    });
  });
});

describe('recording requests the Origin and Host checks would refuse', () => {
  function setup(allowed: string[] = []) {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const repo = new DevicePairingRepository(db);
    const gateway = new DbGateway(':memory:', db);
    let now = 1_000;
    const observe = createRequestObserver({
      db: () => gateway,
      allowedHosts: () => allowed,
      exempt: (req) => new URL(req.url).pathname === '/webhooks/github',
      now: () => now,
    });
    return { db, repo, observe, allowed, tick: () => (now += 1_000) };
  }

  test('records each request that would be refused once, counting repeats, and never refuses', async () => {
    const { db, repo, observe, allowed, tick } = setup();
    const foreign = () => request({ host: 'mac.tailnet.ts.net', origin: 'https://evil.example' });
    expect(observe(foreign())).toBeUndefined();
    tick();
    observe(foreign());
    observe(request({ host: '127.0.0.1:9283', origin: 'http://127.0.0.1:9283' }));
    observe(
      new Request('http://x/webhooks/github', {
        method: 'POST',
        headers: { host: 'hooks.example' },
      })
    );
    await settled();
    expect(repo.listWouldRefuse()).toEqual([
      {
        reason: 'host_not_allowed',
        kind: 'http',
        host: 'mac.tailnet.ts.net',
        origin: 'https://evil.example',
        count: 2,
        firstSeenAt: 1_000,
        lastSeenAt: 2_000,
      },
    ]);
    allowed.push('mac.tailnet.ts.net');
    observe(foreign());
    await settled();
    expect(repo.listWouldRefuse().map((row) => row.reason)).toEqual([
      'origin_not_allowed',
      'host_not_allowed',
    ]);
    db.close();
  });

  test('loopback requests are judged without reading the settings', () => {
    let reads = 0;
    const observe = createRequestObserver({
      db: () => {
        throw new Error('no record expected');
      },
      allowedHosts: () => {
        reads += 1;
        return [];
      },
      exempt: () => false,
      now: () => 1,
    });
    observe(request({ host: '127.0.0.1:9283', origin: 'http://127.0.0.1:9283' }));
    observe(request({ host: 'localhost' }));
    expect(reads).toBe(0);
    observe(request({ host: 'mac.ts.net' }));
    expect(reads).toBe(1);
  });

  test('a storage failure is swallowed, whether it throws or rejects, and logged once a minute', async () => {
    const warn = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    let rejected = 0;
    let now = 1;
    const failing = (fail: () => Promise<void>) =>
      createRequestObserver({
        db: () => ({ run: fail }) as unknown as DbGateway,
        allowedHosts: () => [],
        exempt: () => false,
        now: () => now,
      });
    const throwing = failing(() => {
      throw new Error('database is locked');
    });
    expect(() => throwing(request({ host: 'evil.example' }))).not.toThrow();
    failing(() => {
      rejected += 1;
      return Promise.reject(new Error('database is locked'));
    })(request({ host: 'evil.example' }));
    await settled();
    expect(rejected).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
    const flood = failing(() => {
      rejected += 1;
      return Promise.reject(new Error('DB gateway write queue full'));
    });
    flood(request({ host: 'evil.example' }));
    flood(request({ host: 'evil.example' }));
    await settled();
    expect(warn).toHaveBeenCalledTimes(3);
    now += 60_000;
    flood(request({ host: 'evil.example' }));
    await settled();
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });
});
