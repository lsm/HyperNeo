import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createPairingLimiter } from '../../../../src/lib/pairing/pairing-limiter';
import { createSetupRoute, mintSetupToken } from '../../../../src/lib/pairing/setup-token';

describe('first-run setup link', () => {
  let writer: Database;
  let gateway: DbGateway;
  let dir: string;
  let token: string | null;
  let route: ReturnType<typeof createSetupRoute>;

  beforeEach(() => {
    writer = new Database(':memory:');
    runMigrations(writer, () => {});
    createTables(writer);
    gateway = new DbGateway(':memory:', writer);
    dir = mkdtempSync(join(tmpdir(), 'setup-token-'));
    token = null;
    route = createSetupRoute({
      db: gateway,
      limiter: createPairingLimiter(),
      now: () => 1_000_000,
      token: () => token,
    });
  });

  afterEach(async () => {
    await gateway.close();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const open = (value: string | null) =>
    route(
      new Request('http://127.0.0.1:9311/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:9311' },
        body: JSON.stringify({ token: value }),
      })
    );
  const mint = async () => {
    token = await mintSetupToken(gateway, join(dir, 'setup-token'));
    return token;
  };
  const owners = () =>
    writer
      .prepare("SELECT name FROM paired_devices WHERE kind = 'human' AND owner = 1")
      .all() as { name: string }[];

  test('a new daemon writes an owner-only token that grants the first device once', async () => {
    const minted = await mint();
    expect(minted).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const path = join(dir, 'setup-token');
    expect(readFileSync(path, 'utf8')).toBe(minted as string);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);

    expect((await open('A'.repeat(43))).status).toBe(401);
    const granted = await open(minted);
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({ kind: 'human' });
    expect(granted.headers.get('set-cookie')).toContain('hyperneo_device=');
    expect(owners()).toHaveLength(1);

    const again = await open(minted);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'has_owner' });
    expect(owners()).toHaveLength(1);
  });

  test('no token once a human device has paired; a lost-phone reset opens a new one', async () => {
    const first = await mint();
    expect((await open(first)).status).toBe(200);
    expect(await mint()).toBeNull();

    writer
      .prepare('INSERT INTO human_device_resets (id, reset_at, devices_json) VALUES (?, ?, ?)')
      .run('reset-1', 1_000_000, '[]');
    const next = await mint();
    expect(next).not.toBeNull();
    expect(next).not.toBe(first);
    expect((await open(first)).status).toBe(401);
    expect((await open(next)).status).toBe(200);
    expect((await open(next)).status).toBe(409);
  });
});
