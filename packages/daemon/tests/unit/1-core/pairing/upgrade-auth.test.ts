import { describe, expect, test } from 'bun:test';
import { createUpgradeAuthenticator } from '../../../../src/lib/pairing/upgrade-auth.ts';
import { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const repo = new DevicePairingRepository(db);
  let now = 1_000;
  const authenticate = createUpgradeAuthenticator({ devices: () => repo, now: () => now });
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
  test('a paired device is recognised by its Bearer header or cookie and its last sighting is kept', () => {
    const { db, authenticate, pairDevice, upgrade, unpaired } = setup();
    const phone = pairDevice('human', 'Phone');
    const relay = pairDevice('relay', 'Relay');
    expect(
      authenticate(upgrade({ authorization: `Bearer ${phone.credential}` }), '100.64.0.7')
    ).toEqual({ deviceId: phone.device.id, kind: 'human' });
    expect(
      authenticate(
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

  test('an unpaired connection is accepted as unknown and recorded once per client, without any secret', () => {
    const { db, authenticate, upgrade, unpaired, tick } = setup();
    expect(authenticate(upgrade({}), '192.168.1.20')).toBeNull();
    tick();
    expect(authenticate(upgrade({}), '192.168.1.20')).toBeNull();
    expect(
      authenticate(
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

  test('a revoked device is treated as unpaired', () => {
    const { db, authenticate, pairDevice, upgrade, unpaired } = setup();
    const old = pairDevice('human', 'Old phone');
    db.prepare('UPDATE paired_devices SET revoked_at = 1').run();
    expect(authenticate(upgrade({ authorization: `Bearer ${old.credential}` }), null)).toBeNull();
    expect(unpaired()).toMatchObject([{ rejected: 1, remote: null }]);
    db.close();
  });

  test('a storage failure never refuses the connection', () => {
    const authenticate = createUpgradeAuthenticator({
      devices: () => {
        throw new Error('database is locked');
      },
      now: () => 1,
    });
    expect(authenticate(new Request('http://127.0.0.1/ws'), null)).toBeNull();
  });
});
