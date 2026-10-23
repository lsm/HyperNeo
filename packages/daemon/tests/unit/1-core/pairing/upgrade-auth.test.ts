import { describe, expect, spyOn, test } from 'bun:test';
import { Logger } from '../../../../src/lib/logger.ts';
import {
  announceDeviceRevoked,
  createUpgradeAuthenticator,
} from '../../../../src/lib/pairing/upgrade-auth.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import {
  DevicePairingRepository,
  UNPAIRED_FIELD_MAX,
  UNPAIRED_ROW_CAP,
} from '../../../../src/storage/repositories/device-pairing-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const repo = new DevicePairingRepository(db);
  let now = 1_000;
  const gateway = new DbGateway(':memory:', db);
  const auth = createUpgradeAuthenticator({ db: () => gateway, now: () => now });
  const authenticate = async (req: Request, remoteAddress: string | null) => {
    const identity = await auth(req, remoteAddress);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return identity;
  };
  const pairDevice = (kind: 'human' | 'relay' | 'daemon', name: string) => {
    const made = repo.createCode(kind, null, true, now);
    return repo.redeem(made.code, name, now)!;
  };
  const upgrade = (headers: Record<string, string>) =>
    new Request('http://127.0.0.1:9283/ws', { headers: { host: '127.0.0.1:9283', ...headers } });
  const unpaired = () =>
    db
      .prepare(
        `SELECT client, origin, host, remote_address AS remote, credential_rejected AS rejected,
           count, first_seen_at AS first, last_seen_at AS last FROM unpaired_connections ORDER BY rowid`
      )
      .all();
  return { db, repo, authenticate, pairDevice, upgrade, unpaired, tick: () => (now += 1_000) };
}

describe('upgrade authentication (report only)', () => {
  test('a paired device is recognised by its Bearer header or cookie and its last sighting is kept', async () => {
    const { db, authenticate, pairDevice, upgrade, unpaired } = setup();
    const phone = pairDevice('human', 'Phone');
    const relay = pairDevice('relay', 'Relay');
    expect(
      await authenticate(upgrade({ authorization: `Bearer ${phone.credential}` }), '100.64.0.7')
    ).toEqual({ deviceId: phone.device.id, kind: 'human' });
    expect(
      await authenticate(
        upgrade({
          cookie: `theme=dark; hyperneo_device=${relay.credential}`,
          origin: 'http://127.0.0.1:9283',
        }),
        '127.0.0.1'
      )
    ).toEqual({ deviceId: relay.device.id, kind: 'relay' });
    expect(
      db
        .prepare(
          'SELECT name, last_seen_at AS at, last_seen_host AS host FROM paired_devices ORDER BY name'
        )
        .all()
    ).toEqual([
      { name: 'Phone', at: 1_000, host: '127.0.0.1:9283' },
      { name: 'Relay', at: 1_000, host: '127.0.0.1:9283' },
    ]);
    expect(unpaired()).toEqual([]);
    db.close();
  });

  test('an unpaired connection is accepted as unknown and recorded once per client, without any secret', async () => {
    const { db, authenticate, upgrade, unpaired, tick } = setup();
    expect(await authenticate(upgrade({}), '192.168.1.20')).toBeNull();
    tick();
    expect(await authenticate(upgrade({}), '192.168.1.20')).toBeNull();
    expect(
      await authenticate(
        upgrade({ origin: 'https://evil.example', authorization: 'Bearer not-a-real-credential' }),
        '10.0.0.9'
      )
    ).toBeNull();
    expect(unpaired()).toEqual([
      {
        client: 'native',
        origin: null,
        host: '127.0.0.1:9283',
        remote: '192.168.1.20',
        rejected: 0,
        count: 2,
        first: 1_000,
        last: 2_000,
      },
      {
        client: 'browser',
        origin: 'https://evil.example',
        host: '127.0.0.1:9283',
        remote: '10.0.0.9',
        rejected: 1,
        count: 1,
        first: 2_000,
        last: 2_000,
      },
    ]);
    expect(JSON.stringify(db.prepare('SELECT * FROM unpaired_connections').all())).not.toContain(
      'not-a-real-credential'
    );
    db.close();
  });

  test('unpaired rows stay bounded however many distinct headers a peer sends', async () => {
    const { db, authenticate, upgrade, unpaired, tick } = setup();
    const huge = `https://${'a'.repeat(10_000)}.example`;
    await authenticate(upgrade({ origin: huge }), '10.0.0.1');
    const [first] = unpaired() as { origin: string }[];
    expect(first.origin.length).toBe(UNPAIRED_FIELD_MAX);
    for (let i = 0; i < UNPAIRED_ROW_CAP + 50; i += 1)
      await authenticate(upgrade({ origin: `https://flood-${i}.example` }), '10.0.0.2');
    const total = () =>
      (db.prepare('SELECT COUNT(*) AS n FROM unpaired_connections').get() as { n: number }).n;
    expect(total()).toBe(UNPAIRED_ROW_CAP);
    tick();
    await authenticate(upgrade({ origin: huge }), '10.0.0.1');
    expect(unpaired()[0]).toMatchObject({ count: 2, last: 2_000 });
    expect(total()).toBe(UNPAIRED_ROW_CAP);
    db.close();
  });

  test('a device revoked while its upgrade awaits the lookup is treated as unpaired', async () => {
    const { db, repo, pairDevice, upgrade } = setup();
    const phone = pairDevice('human', 'Phone');
    const inline = new DbGateway(':memory:', db);
    let revokeDuringLookup = true;
    const gateway = {
      run: async (...args: Parameters<DbGateway['run']>) => {
        const result = await inline.run(...args);
        if (revokeDuringLookup) {
          repo.revokeDevice(phone.device.id, 2_000);
          announceDeviceRevoked(phone.device.id);
        }
        return result;
      },
    } as unknown as DbGateway;
    const auth = createUpgradeAuthenticator({ db: () => gateway, now: () => 1_000 });
    const bearer = () => upgrade({ authorization: `Bearer ${phone.credential}` });
    expect(await auth(bearer(), null)).toBeNull();
    revokeDuringLookup = false;
    const other = pairDevice('relay', 'Relay');
    expect(
      await auth(upgrade({ authorization: `Bearer ${other.credential}` }), null)
    ).toMatchObject({ deviceId: other.device.id });
    db.close();
  });

  test('an unpaired sighting the gateway refuses is logged at most once a minute', async () => {
    const warn = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    let now = 1;
    const full = { run: () => Promise.reject(new Error('DB gateway write queue full')) };
    const auth = createUpgradeAuthenticator({
      db: () => full as unknown as DbGateway,
      now: () => now,
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const plain = () => new Request('http://127.0.0.1:9283/ws', { headers: { host: 'h' } });
    expect(await auth(plain(), null)).toBeNull();
    expect(await auth(plain(), null)).toBeNull();
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    now += 60_000;
    await auth(plain(), null);
    await settle();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  test('a revoked device is treated as unpaired', async () => {
    const { db, authenticate, pairDevice, upgrade, unpaired } = setup();
    const old = pairDevice('human', 'Old phone');
    db.prepare('UPDATE paired_devices SET revoked_at = 1').run();
    expect(
      await authenticate(upgrade({ authorization: `Bearer ${old.credential}` }), null)
    ).toBeNull();
    expect(unpaired()).toMatchObject([{ rejected: 1, remote: null }]);
    db.close();
  });

  test('a storage failure never refuses the connection', async () => {
    const failing = (run: () => Promise<never>) =>
      createUpgradeAuthenticator({ db: () => ({ run }) as unknown as DbGateway, now: () => 1 });
    const locked = () => Promise.reject(new Error('database is locked'));
    const bearer = new Request('http://127.0.0.1/ws', { headers: { authorization: 'Bearer x' } });
    expect(await failing(locked)(bearer, null)).toBeNull();
    expect(await failing(locked)(new Request('http://127.0.0.1/ws'), null)).toBeNull();
    expect(
      await failing(() => {
        throw new Error('database is locked');
      })(bearer, null)
    ).toBeNull();
  });
});
