import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createCredentialStore,
  DatabaseCredentialStore,
} from '../../../../src/lib/credentials/credential-store';

function createStore(secret?: string): { db: Database; store: DatabaseCredentialStore } {
  const db = new Database(':memory:');
  return { db, store: new DatabaseCredentialStore(db, secret) };
}

describe('DatabaseCredentialStore', () => {
  it('round-trips encrypted credentials', async () => {
    const { db, store } = createStore('test-secret');
    try {
      await store.set('neokai.provider.test', 'default', 'secret-data');

      expect(await store.get('neokai.provider.test', 'default')).toBe('secret-data');
      const row = db
        .query<{ encrypted_data: Uint8Array }, []>(
          'SELECT encrypted_data FROM provider_credentials WHERE provider_id = ?'
        )
        .get('neokai.provider.test:default');
      expect(Buffer.from(row!.encrypted_data).toString('utf8')).not.toBe('secret-data');
    } finally {
      db.close();
    }
  });

  it('deletes credentials idempotently', async () => {
    const { db, store } = createStore('test-secret');
    try {
      await store.set('neokai.provider.test', 'default', 'secret-data');
      await store.delete('neokai.provider.test', 'default');
      await store.delete('neokai.provider.test', 'default');

      expect(await store.get('neokai.provider.test', 'default')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('lists services by prefix', async () => {
    const { db, store } = createStore('test-secret');
    try {
      await store.set('neokai.provider.glm', 'default', 'glm-secret');
      await store.set('neokai.provider.kimi', 'default', 'kimi-secret');
      await store.set('other.provider.test', 'default', 'other-secret');

      expect(await store.listServices('neokai.provider.')).toEqual([
        'neokai.provider.glm',
        'neokai.provider.kimi',
      ]);
    } finally {
      db.close();
    }
  });

  it('uses NEOKAI_PROVIDER_CREDENTIAL_KEY env var when set', async () => {
    const prev = process.env.NEOKAI_PROVIDER_CREDENTIAL_KEY;
    process.env.NEOKAI_PROVIDER_CREDENTIAL_KEY = 'env-derived-key';
    try {
      const { db, store } = createStore();
      try {
        await store.set('neokai.provider.test', 'default', 'secret-data');
        expect(await store.get('neokai.provider.test', 'default')).toBe('secret-data');
      } finally {
        db.close();
      }
    } finally {
      if (prev === undefined) {
        delete process.env.NEOKAI_PROVIDER_CREDENTIAL_KEY;
      } else {
        process.env.NEOKAI_PROVIDER_CREDENTIAL_KEY = prev;
      }
    }
  });

  it('generates and persists a random key when no secret is provided', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'neokai-cred-test-'));
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const prevEnv = process.env.NEOKAI_PROVIDER_CREDENTIAL_KEY;
    delete process.env.NEOKAI_PROVIDER_CREDENTIAL_KEY;
    let db: Database | undefined;

    try {
      db = new Database(':memory:');
      const store = new DatabaseCredentialStore(db);
      await store.set('neokai.provider.test', 'default', 'secret-data');
      expect(await store.get('neokai.provider.test', 'default')).toBe('secret-data');

      const keyPath = path.join(tmpHome, '.neokai', '.provider-credential-key');
      expect(fs.existsSync(keyPath)).toBe(true);
      const key = fs.readFileSync(keyPath, 'utf-8').trim();
      expect(key.length).toBe(64); // 32 bytes hex-encoded

      // A second store using the same key file should decrypt the same data
      const store2 = new DatabaseCredentialStore(db);
      expect(await store2.get('neokai.provider.test', 'default')).toBe('secret-data');
    } finally {
      db?.close();
      homedirSpy.mockRestore();
      if (prevEnv === undefined) {
        delete process.env.NEOKAI_PROVIDER_CREDENTIAL_KEY;
      } else {
        process.env.NEOKAI_PROVIDER_CREDENTIAL_KEY = prevEnv;
      }
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('createCredentialStore', () => {
  it('returns DatabaseCredentialStore on non-darwin platforms', () => {
    const platformSpy = spyOn(os, 'platform').mockReturnValue('linux');
    const db = new Database(':memory:');
    try {
      const store = createCredentialStore(db);
      expect(store).toBeInstanceOf(DatabaseCredentialStore);
    } finally {
      db.close();
      platformSpy.mockRestore();
    }
  });

  it('returns DatabaseCredentialStore on darwin when stdout is not a TTY', () => {
    const platformSpy = spyOn(os, 'platform').mockReturnValue('darwin');
    const originalIsTTY = process.stdout.isTTY;
    // @ts-expect-error - mocking read-only property
    process.stdout.isTTY = false;
    const db = new Database(':memory:');
    try {
      const store = createCredentialStore(db);
      expect(store).toBeInstanceOf(DatabaseCredentialStore);
    } finally {
      db.close();
      // @ts-expect-error - restoring read-only property
      process.stdout.isTTY = originalIsTTY;
      platformSpy.mockRestore();
    }
  });

  it('returns KeychainCredentialStore on darwin when stdout is a TTY', () => {
    const platformSpy = spyOn(os, 'platform').mockReturnValue('darwin');
    const originalIsTTY = process.stdout.isTTY;
    // @ts-expect-error - mocking read-only property
    process.stdout.isTTY = true;
    const db = new Database(':memory:');
    try {
      const store = createCredentialStore(db);
      // KeychainCredentialStore is not exported, so we verify it's NOT a DatabaseCredentialStore
      expect(store).not.toBeInstanceOf(DatabaseCredentialStore);
    } finally {
      db.close();
      // @ts-expect-error - restoring read-only property
      process.stdout.isTTY = originalIsTTY;
      platformSpy.mockRestore();
    }
  });

  it('returns KeychainCredentialStore on darwin when isTTY is undefined', () => {
    const platformSpy = spyOn(os, 'platform').mockReturnValue('darwin');
    const originalIsTTY = process.stdout.isTTY;
    // @ts-expect-error - mocking read-only property
    process.stdout.isTTY = undefined;
    const db = new Database(':memory:');
    try {
      const store = createCredentialStore(db);
      expect(store).not.toBeInstanceOf(DatabaseCredentialStore);
    } finally {
      db.close();
      // @ts-expect-error - restoring read-only property
      process.stdout.isTTY = originalIsTTY;
      platformSpy.mockRestore();
    }
  });
});
