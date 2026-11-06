import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLocalCredential } from '../../../../src/lib/pairing/local-credential.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import {
  DevicePairingRepository,
  enrollLocalDevice,
  touchDevice,
} from '../../../../src/storage/repositories/device-pairing-repository.ts';
import { resetHumanDevices } from '../../../../src/storage/repositories/human-device-reset-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

describe('local owner credential', () => {
  test('local agent enrollment preserves first-human pairing bootstrap', async () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const gateway = new DbGateway(':memory:', db);
    try {
      await gateway.run(enrollLocalDevice, { credential: 'h'.repeat(43), now: 1 });
      await gateway.run(enrollLocalDevice, { credential: 'a'.repeat(43), now: 1, kind: 'agent' });
      expect(new DevicePairingRepository(db).countDevices()).toEqual({ all: 0, humans: 0 });
    } finally {
      db.close();
    }
  });
  let dir: string;
  let file: string;
  const credential = randomBytes(32).toString('base64url');
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'local-credential-'));
    file = join(dir, 'local-rpc.credential');
    await writeFile(file, credential, { mode: 0o600 });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('only an owner-only regular file supplies the local credential', async () => {
    expect(await readLocalCredential(file)).toBe(credential);
    await chmod(file, 0o644);
    expect(() => readLocalCredential(file)).toThrow('owner-only');
    await chmod(file, 0o600);
    const link = join(dir, 'link');
    await symlink(file, link);
    expect(() => readLocalCredential(link)).toThrow();
    await writeFile(file, 'x'.repeat(1000));
    expect(() => readLocalCredential(file)).toThrow();
  });

  test('restart reuses the device, revocation stays effective, phone recovery keeps the local door', async () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const gateway = new DbGateway(':memory:', db);
    try {
      await gateway.run(enrollLocalDevice, { credential, now: 1000 });
      await gateway.run(enrollLocalDevice, { credential, now: 2000 });
      const rows = db.prepare('SELECT id, secret_hash FROM paired_devices').all() as {
        id: string;
        secret_hash: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(new DevicePairingRepository(db).countDevices()).toEqual({ all: 0, humans: 0 });
      expect(rows[0].secret_hash).not.toContain(credential);
      resetHumanDevices(db, 3000);
      expect(await gateway.run(touchDevice, { credential, host: null, now: 4000 })).not.toBeNull();
      db.prepare('UPDATE paired_devices SET revoked_at = 5000').run();
      await gateway.run(enrollLocalDevice, { credential, now: 6000 });
      expect(await gateway.run(touchDevice, { credential, host: null, now: 7000 })).toBeNull();
    } finally {
      await gateway.close();
      db.close();
    }
  });
});
