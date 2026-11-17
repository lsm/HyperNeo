import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository';
import { resetHumanDevices } from '../../../../src/storage/repositories/human-device-reset-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createPairingLimiter } from '../../../../src/lib/pairing/pairing-limiter';
import {
  createSetupRoute,
  mintSetupToken,
  type SetupLink,
} from '../../../../src/lib/pairing/setup-token';

describe('first-run setup link', () => {
  let writer: Database;
  let gateway: DbGateway;
  let dir: string;
  let link: SetupLink | null;
  let route: ReturnType<typeof createSetupRoute>;
  let now: number;

  beforeEach(() => {
    writer = new Database(':memory:');
    runMigrations(writer, () => {});
    createTables(writer);
    gateway = new DbGateway(':memory:', writer);
    dir = mkdtempSync(join(tmpdir(), 'setup-token-'));
    link = null;
    now = 1_000_000;
    route = createSetupRoute({
      db: gateway,
      limiter: createPairingLimiter(),
      now: () => now,
      link: () => link,
    });
  });

  afterEach(async () => {
    await gateway.close();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const open = async (value: string | null | undefined) => {
    now += 1_000;
    return route(
      new Request('http://127.0.0.1:9311/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:9311' },
        body: JSON.stringify({ token: value }),
      })
    );
  };
  const mint = async () => {
    link = await mintSetupToken(gateway, join(dir, 'setup-token'));
    return link?.token ?? null;
  };
  const owners = () =>
    writer
      .prepare(
        "SELECT name FROM paired_devices WHERE kind = 'human' AND owner = 1 AND revoked_at IS NULL"
      )
      .all() as { name: string }[];
  const pairByCode = () => {
    const repo = new DevicePairingRepository(writer);
    const made = repo.createCode('human', null, true, now);
    expect(repo.redeem(made.code, 'Phone', now)).not.toBeNull();
  };
  const reset = () => {
    now += 1_000;
    resetHumanDevices(writer, now);
  };

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
    expect(existsSync(path)).toBe(false);

    const again = await open(minted);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'has_owner' });
    expect(owners()).toHaveLength(1);
  });

  test('a used token stays dead after reset-human without a restart', async () => {
    const first = await mint();
    expect((await open(first)).status).toBe(200);
    reset();
    expect((await open(first)).status).not.toBe(200);
    expect(owners()).toHaveLength(0);

    const next = await mint();
    expect(next).not.toBeNull();
    expect(next).not.toBe(first);
    expect((await open(first)).status).toBe(401);
    expect((await open(next)).status).toBe(200);
    expect((await open(next)).status).not.toBe(200);
    expect(owners()).toHaveLength(1);
  });

  test('an unused token dies when ordinary pairing closes its window, even after a reset', async () => {
    const first = await mint();
    pairByCode();
    expect((await open(first)).status).not.toBe(200);
    reset();
    expect((await open(first)).status).not.toBe(200);
    expect(owners()).toHaveLength(0);

    const next = await mint();
    expect((await open(next)).status).toBe(200);
    expect((await open(next)).status).not.toBe(200);
    expect(owners()).toHaveLength(1);
  });

  test('no token, and no token file, while a human device has paired', async () => {
    await mint();
    pairByCode();
    expect(await mint()).toBeNull();
    expect(existsSync(join(dir, 'setup-token'))).toBe(false);
  });
});
