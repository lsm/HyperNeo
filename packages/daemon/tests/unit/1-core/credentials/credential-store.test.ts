import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { configureLogger, subscribeToStructuredLogs, LogLevel } from '@neokai/shared';
import {
  createCredentialStore,
  DatabaseCredentialStore,
  FallbackCredentialStore,
  type CredentialStore,
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

  it('wraps keychain in FallbackCredentialStore on darwin outside tests', () => {
    const platformSpy = spyOn(os, 'platform').mockReturnValue('darwin');
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const db = new Database(':memory:');
    try {
      const store = createCredentialStore(db);
      expect(store).toBeInstanceOf(FallbackCredentialStore);
    } finally {
      db.close();
      platformSpy.mockRestore();
      if (prevNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = prevNodeEnv;
      }
    }
  });

  it('uses database store on darwin during tests', () => {
    const platformSpy = spyOn(os, 'platform').mockReturnValue('darwin');
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const db = new Database(':memory:');
    try {
      const store = createCredentialStore(db);
      expect(store).toBeInstanceOf(DatabaseCredentialStore);
    } finally {
      db.close();
      platformSpy.mockRestore();
      if (prevNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = prevNodeEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// FallbackCredentialStore — fallback behavior + warn-once.
// Uses in-memory stubs; no child_process mocking required.
// ---------------------------------------------------------------------------

class StubCredentialStore implements CredentialStore {
  public gets: Array<[string, string]> = [];
  public sets: Array<[string, string, string]> = [];
  public deletes: Array<[string, string]> = [];
  public listCalls = 0;
  constructor(
    private readonly getImpl: (service: string, account: string) => Promise<string | null>,
    private readonly listImpl: (prefix: string) => Promise<string[]>,
    private readonly setImpl: (
      service: string,
      account: string,
      data: string
    ) => Promise<void> = async () => {},
    private readonly deleteImpl: (
      service: string,
      account: string
    ) => Promise<void> = async () => {}
  ) {}
  async get(service: string, account: string): Promise<string | null> {
    this.gets.push([service, account]);
    return this.getImpl(service, account);
  }
  async set(service: string, account: string, data: string): Promise<void> {
    this.sets.push([service, account, data]);
    return this.setImpl(service, account, data);
  }
  async delete(service: string, account: string): Promise<void> {
    this.deletes.push([service, account]);
    return this.deleteImpl(service, account);
  }
  async listServices(prefix: string): Promise<string[]> {
    this.listCalls++;
    return this.listImpl(prefix);
  }
}

describe('FallbackCredentialStore', () => {
  let logEvents: Array<{ level: string; message: string }>;
  let unsubscribe: () => void;

  beforeEach(() => {
    // Capture structured log events so we can assert warn-once behavior
    // without depending on the console (which is suppressed in unit tests).
    configureLogger({ level: LogLevel.WARN, filter: ['kai:daemon:*'] });
    logEvents = [];
    unsubscribe = subscribeToStructuredLogs((event) => {
      logEvents.push({ level: event.level, message: event.message });
    });
  });
  afterEach(() => {
    unsubscribe();
    configureLogger({ level: LogLevel.SILENT, filter: [] });
  });

  it('get() falls back to DB store when keychain throws', async () => {
    const primary = new StubCredentialStore(
      async () => {
        throw new Error('keychain locked');
      },
      async () => []
    );
    const fallback = new StubCredentialStore(
      async () => 'db-secret',
      async () => []
    );
    const store = new FallbackCredentialStore(primary, fallback);

    expect(await store.get('neokai.provider.test', 'default')).toBe('db-secret');
    expect(fallback.gets).toEqual([['neokai.provider.test', 'default']]);
  });

  it('get() falls back to DB store when keychain returns null', async () => {
    const primary = new StubCredentialStore(
      async () => null,
      async () => []
    );
    const fallback = new StubCredentialStore(
      async () => 'db-secret',
      async () => []
    );
    const store = new FallbackCredentialStore(primary, fallback);

    expect(await store.get('neokai.provider.test', 'default')).toBe('db-secret');
    expect(fallback.gets).toHaveLength(1);
  });

  it('get() does not warn when primary returns null (item just missing)', async () => {
    const primary = new StubCredentialStore(
      async () => null,
      async () => []
    );
    const fallback = new StubCredentialStore(
      async () => null,
      async () => []
    );
    const store = new FallbackCredentialStore(primary, fallback);

    await store.get('neokai.provider.test', 'default');
    expect(logEvents.filter((e) => e.level === 'warn')).toHaveLength(0);
  });

  it('warns once, not per-call', async () => {
    const primary = new StubCredentialStore(
      async () => {
        throw new Error('keychain locked');
      },
      async () => []
    );
    const fallback = new StubCredentialStore(
      async () => 'db-secret',
      async () => []
    );
    const store = new FallbackCredentialStore(primary, fallback);

    await store.get('a', 'b');
    await store.get('c', 'd');
    await store.get('e', 'f');

    const warnEvents = logEvents.filter((e) => e.level === 'warn');
    expect(warnEvents).toHaveLength(1);
    expect(warnEvents[0]?.message ?? '').toContain('Keychain unavailable');
  });

  it('set() writes to DB when keychain throws', async () => {
    const primary = new StubCredentialStore(
      async () => null,
      async () => [],
      async () => {
        throw new Error('keychain locked');
      }
    );
    const fallback = new StubCredentialStore(
      async () => null,
      async () => [],
      async () => {}
    );
    const store = new FallbackCredentialStore(primary, fallback);

    await store.set('neokai.provider.test', 'default', 'secret');
    expect(fallback.sets).toEqual([['neokai.provider.test', 'default', 'secret']]);
  });

  it('set() writes to primary only when keychain succeeds', async () => {
    const primary = new StubCredentialStore(
      async () => null,
      async () => [],
      async () => {}
    );
    const fallback = new StubCredentialStore(
      async () => null,
      async () => [],
      async () => {}
    );
    const store = new FallbackCredentialStore(primary, fallback);

    await store.set('neokai.provider.test', 'default', 'secret');
    expect(primary.sets).toHaveLength(1);
    expect(fallback.sets).toHaveLength(0);
  });

  it('warns once, not per-call', async () => {
    const primary = new StubCredentialStore(
      async () => {
        throw new Error('keychain locked');
      },
      async () => []
    );
    const fallback = new StubCredentialStore(
      async () => 'db-secret',
      async () => []
    );
    const store = new FallbackCredentialStore(primary, fallback);

    await store.get('a', 'b');
    await store.get('c', 'd');
    await store.get('e', 'f');

    const warnEvents = logEvents.filter((e) => e.level === 'warn');
    expect(warnEvents).toHaveLength(1);
    expect(warnEvents[0]?.message ?? '').toContain('Keychain unavailable');
  });

  it('listServices() merges both stores and de-duplicates', async () => {
    const primary = new StubCredentialStore(
      async () => null,
      async () => ['neokai.provider.a', 'neokai.provider.b']
    );
    const fallback = new StubCredentialStore(
      async () => null,
      async () => ['neokai.provider.b', 'neokai.provider.c']
    );
    const store = new FallbackCredentialStore(primary, fallback);

    expect(await store.listServices('neokai.provider.')).toEqual([
      'neokai.provider.a',
      'neokai.provider.b',
      'neokai.provider.c',
    ]);
  });

  it('listServices() tolerates primary throwing', async () => {
    const primary = new StubCredentialStore(
      async () => null,
      async () => {
        throw new Error('boom');
      }
    );
    const fallback = new StubCredentialStore(
      async () => null,
      async () => ['neokai.provider.a']
    );
    const store = new FallbackCredentialStore(primary, fallback);

    expect(await store.listServices('neokai.provider.')).toEqual(['neokai.provider.a']);
  });

  it('delete() deletes from both stores best-effort', async () => {
    const primary = new StubCredentialStore(
      async () => null,
      async () => [],
      async () => {},
      async () => {}
    );
    const fallback = new StubCredentialStore(
      async () => null,
      async () => [],
      async () => {},
      async () => {}
    );
    const store = new FallbackCredentialStore(primary, fallback);

    await store.delete('neokai.provider.test', 'default');
    expect(primary.deletes).toEqual([['neokai.provider.test', 'default']]);
    expect(fallback.deletes).toEqual([['neokai.provider.test', 'default']]);
  });

  it('delete() tolerates primary throwing', async () => {
    const primary = new StubCredentialStore(
      async () => null,
      async () => [],
      async () => {},
      async () => {
        throw new Error('keychain locked');
      }
    );
    const fallback = new StubCredentialStore(
      async () => null,
      async () => [],
      async () => {},
      async () => {}
    );
    const store = new FallbackCredentialStore(primary, fallback);

    await expect(store.delete('neokai.provider.test', 'default')).resolves.toBeUndefined();
    expect(fallback.deletes).toHaveLength(1);
  });
});
