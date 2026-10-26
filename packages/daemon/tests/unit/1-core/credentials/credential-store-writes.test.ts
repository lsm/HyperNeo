import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi, type MockInstance } from 'vitest';
import * as dataDirectory from '../../../../src/lib/data-dir';
import { DatabaseCredentialStore } from '../../../../src/lib/credentials/credential-store';
import { DbGateway, bindGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('encrypted credential writer boundary', () => {
  let db: Database;
  let gateway: DbGateway;
  let store: DatabaseCredentialStore;
  let defaultCredentialPath: MockInstance<() => string>;

  beforeEach(() => {
    defaultCredentialPath = vi.spyOn(dataDirectory, 'getDataDir').mockImplementation(() => {
      throw new Error('Credential fixture must not resolve the default key path');
    });
    db = new Database(':memory:');
    store = new DatabaseCredentialStore(db, 'synthetic-test-encryption-key');
    gateway = new DbGateway(':memory:', db);
    bindGateway(db, gateway);
  });

  afterEach(async () => {
    await gateway.close();
    db.close();
    const defaultPathCalls = defaultCredentialPath.mock.calls.length;
    defaultCredentialPath.mockRestore();
    expect(defaultPathCalls).toBe(0);
  });

  it('awaits the writer and transfers ciphertext with no plaintext or key', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let queued!: () => void;
    const arrived = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const run = gateway.run.bind(gateway);
    gateway.run = async (op, input) => {
      expect(op.name).toBe('credentials.write');
      const clone = structuredClone(input) as {
        method: string;
        args: [{ providerId: string; encrypted: Uint8Array; iv: Uint8Array; tag: Uint8Array }];
      };
      expect(clone.method).toBe('set');
      const record = clone.args[0];
      expect(Object.keys(record).sort()).toEqual(['encrypted', 'iv', 'providerId', 'tag']);
      expect(record.encrypted).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(record.encrypted).toString('utf8')).not.toContain('synthetic-plaintext');
      expect(record.iv.byteLength).toBe(12);
      expect(record.tag.byteLength).toBe(16);
      queued();
      await hold;
      return run(op, clone as typeof input);
    };
    let settled = false;
    const pending = store.set('synthetic-service', 'account', 'synthetic-plaintext').then(() => {
      settled = true;
    });
    await arrived;
    expect(settled).toBe(false);
    expect(await store.get('synthetic-service', 'account')).toBeNull();
    release();
    await pending;
    expect(await store.get('synthetic-service', 'account')).toBe('synthetic-plaintext');
  });

  it('overwrites one record while retaining authenticated encryption', async () => {
    await store.set('synthetic-service', 'account', 'first');
    const first = db.prepare('SELECT iv FROM provider_credentials').get() as { iv: Uint8Array };
    await store.set('synthetic-service', 'account', 'replacement');
    expect(await store.get('synthetic-service', 'account')).toBe('replacement');
    const rows = db.prepare('SELECT iv, tag FROM provider_credentials').all() as Array<{
      iv: Uint8Array;
      tag: Uint8Array;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].iv).not.toEqual(first.iv);
    db.prepare('UPDATE provider_credentials SET tag = ?').run(new Uint8Array(16));
    await expect(store.get('synthetic-service', 'account')).rejects.toThrow();
  });

  it('awaits deletion and preserves another account', async () => {
    await store.set('synthetic-service', 'first', 'remove');
    await store.set('synthetic-service', 'second', 'keep');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let queued!: () => void;
    const arrived = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const run = gateway.run.bind(gateway);
    gateway.run = async (op, input) => {
      queued();
      await hold;
      return run(op, input);
    };
    const pending = store.delete('synthetic-service', 'first');
    await arrived;
    expect(await store.get('synthetic-service', 'first')).toBe('remove');
    release();
    await pending;
    await store.delete('synthetic-service', 'first');
    expect(await store.get('synthetic-service', 'first')).toBeNull();
    expect(await store.get('synthetic-service', 'second')).toBe('keep');
  });

  it('preserves the previous ciphertext when the write fails', async () => {
    await store.set('synthetic-service', 'account', 'original');
    db.exec(`CREATE TRIGGER reject_credential BEFORE INSERT ON provider_credentials
      BEGIN SELECT RAISE(ABORT, 'synthetic credential failure'); END`);
    await expect(store.set('synthetic-service', 'account', 'replacement')).rejects.toThrow(
      'synthetic credential failure'
    );
    expect(await store.get('synthetic-service', 'account')).toBe('original');
  });

  it('rejects writer failure without replaying set or delete on main', async () => {
    await store.set('synthetic-service', 'account', 'original');
    const unavailable = new DbGateway('synthetic-file', null, undefined, () => {
      throw new Error('writer unavailable');
    });
    bindGateway(db, unavailable);
    const prepare = db.prepare;
    let attempts = 0;
    db.prepare = (...args) => {
      if (/INSERT INTO provider_credentials|DELETE FROM provider_credentials/.test(args[0])) {
        attempts++;
        throw new Error('main mutation forbidden');
      }
      return Reflect.apply(prepare, db, args);
    };
    try {
      await expect(store.set('synthetic-service', 'account', 'replacement')).rejects.toThrow(
        'writer unavailable'
      );
      await expect(store.delete('synthetic-service', 'account')).rejects.toThrow();
      expect(attempts).toBe(0);
    } finally {
      db.prepare = prepare;
      await unavailable.close();
    }
    expect(await store.get('synthetic-service', 'account')).toBe('original');
  });
});
