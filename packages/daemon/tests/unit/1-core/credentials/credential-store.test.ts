import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  configureLogger,
  getLoggerConfig,
  subscribeToStructuredLogs,
  LogLevel,
} from '@hyperneo/shared';
import {
  createCredentialStore,
  DatabaseCredentialStore,
  KeychainStatusCredentialStore,
  KeychainUnavailableError,
  KEYCHAIN_UNAVAILABLE_MESSAGE,
  type CredentialStore,
} from '../../../../src/lib/credentials/credential-store';

// node:os namespace exports are not configurable in ESM, so `spyOn(os, ...)`
// cannot work under Vitest. Mock the module with mutable overrides instead.
const osOverrides = vi.hoisted(() => ({
  homedir: null as string | null,
  platform: null as NodeJS.Platform | null,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => osOverrides.homedir ?? actual.homedir(),
    platform: () => osOverrides.platform ?? actual.platform(),
  };
});

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

  it('uses HYPERNEO_PROVIDER_CREDENTIAL_KEY env var when set', async () => {
    const prev = process.env.HYPERNEO_PROVIDER_CREDENTIAL_KEY;
    process.env.HYPERNEO_PROVIDER_CREDENTIAL_KEY = 'env-derived-key';
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
        delete process.env.HYPERNEO_PROVIDER_CREDENTIAL_KEY;
      } else {
        process.env.HYPERNEO_PROVIDER_CREDENTIAL_KEY = prev;
      }
    }
  });

  it('generates and persists a random key when no secret is provided', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperneo-cred-test-'));
    osOverrides.homedir = tmpHome;
    const prevEnv = process.env.HYPERNEO_PROVIDER_CREDENTIAL_KEY;
    delete process.env.HYPERNEO_PROVIDER_CREDENTIAL_KEY;
    let db: Database | undefined;

    try {
      db = new Database(':memory:');
      const store = new DatabaseCredentialStore(db);
      await store.set('neokai.provider.test', 'default', 'secret-data');
      expect(await store.get('neokai.provider.test', 'default')).toBe('secret-data');

      const keyPath = path.join(tmpHome, '.hyperneo', '.provider-credential-key');
      expect(fs.existsSync(keyPath)).toBe(true);
      const key = fs.readFileSync(keyPath, 'utf-8').trim();
      expect(key.length).toBe(64); // 32 bytes hex-encoded

      // A second store using the same key file should decrypt the same data
      const store2 = new DatabaseCredentialStore(db);
      expect(await store2.get('neokai.provider.test', 'default')).toBe('secret-data');
    } finally {
      db?.close();
      osOverrides.homedir = null;
      if (prevEnv === undefined) {
        delete process.env.HYPERNEO_PROVIDER_CREDENTIAL_KEY;
      } else {
        process.env.HYPERNEO_PROVIDER_CREDENTIAL_KEY = prevEnv;
      }
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('createCredentialStore', () => {
  it('returns DatabaseCredentialStore on non-darwin platforms', () => {
    osOverrides.platform = 'linux';
    const db = new Database(':memory:');
    try {
      const store = createCredentialStore(db);
      expect(store).toBeInstanceOf(DatabaseCredentialStore);
    } finally {
      db.close();
      osOverrides.platform = null;
    }
  });

  it('uses Keychain-only store on darwin outside tests', () => {
    osOverrides.platform = 'darwin';
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const db = new Database(':memory:');
    try {
      const store = createCredentialStore(db);
      expect(store).toBeInstanceOf(KeychainStatusCredentialStore);
      expect(store).not.toBeInstanceOf(DatabaseCredentialStore);
    } finally {
      db.close();
      osOverrides.platform = null;
      if (prevNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = prevNodeEnv;
      }
    }
  });

  it('uses database store on darwin during tests', () => {
    osOverrides.platform = 'darwin';
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const db = new Database(':memory:');
    try {
      const store = createCredentialStore(db);
      expect(store).toBeInstanceOf(DatabaseCredentialStore);
    } finally {
      db.close();
      osOverrides.platform = null;
      if (prevNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = prevNodeEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// KeychainStatusCredentialStore — Keychain-only macOS behavior + warn-once.
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

describe('KeychainStatusCredentialStore', () => {
  let logEvents: Array<{ level: string; message: string }>;
  let unsubscribe: () => void;
  let originalConfig: ReturnType<typeof getLoggerConfig>;

  beforeEach(() => {
    originalConfig = getLoggerConfig();
    configureLogger({ level: LogLevel.WARN, filter: ['hyperneo:daemon:*'] });
    logEvents = [];
    unsubscribe = subscribeToStructuredLogs((event) => {
      logEvents.push({ level: event.level, message: event.message });
    });
  });

  afterEach(() => {
    unsubscribe();
    configureLogger(originalConfig);
  });

  it('get() reads from keychain only', async () => {
    const keychain = new StubCredentialStore(
      async () => 'keychain-value',
      async () => []
    );
    const store = new KeychainStatusCredentialStore(keychain);

    expect(await store.get('neokai.provider.test', 'default')).toBe('keychain-value');
    expect(keychain.gets).toEqual([['neokai.provider.test', 'default']]);
    expect(store.getStatus()).toEqual({ backend: 'keychain', keychainAvailable: true });
  });

  it('get() returns null and marks unavailable when keychain is locked', async () => {
    const keychain = new StubCredentialStore(
      async () => {
        throw new KeychainUnavailableError('keychain locked');
      },
      async () => []
    );
    const store = new KeychainStatusCredentialStore(keychain);

    expect(await store.get('neokai.provider.test', 'default')).toBeNull();
    expect(store.getStatus()).toEqual({
      backend: 'keychain-unavailable',
      keychainAvailable: false,
      warning: KEYCHAIN_UNAVAILABLE_MESSAGE,
    });
  });

  it('get() propagates non-keychain errors', async () => {
    const keychain = new StubCredentialStore(
      async () => {
        throw new Error('corrupted keychain');
      },
      async () => []
    );
    const store = new KeychainStatusCredentialStore(keychain);

    await expect(store.get('neokai.provider.test', 'default')).rejects.toThrow(
      'corrupted keychain'
    );
    expect(store.getStatus().backend).toBe('keychain');
  });

  it('set() writes to keychain only', async () => {
    const keychain = new StubCredentialStore(
      async () => null,
      async () => [],
      async () => {}
    );
    const store = new KeychainStatusCredentialStore(keychain);

    await store.set('neokai.provider.test', 'default', 'secret');
    expect(keychain.sets).toEqual([['neokai.provider.test', 'default', 'secret']]);
  });

  it('set() rejects KeychainUnavailableError and does not persist elsewhere', async () => {
    const keychain = new StubCredentialStore(
      async () => null,
      async () => [],
      async () => {
        throw new KeychainUnavailableError('keychain locked');
      }
    );
    const store = new KeychainStatusCredentialStore(keychain);

    await expect(store.set('neokai.provider.test', 'default', 'secret')).rejects.toThrow(
      KEYCHAIN_UNAVAILABLE_MESSAGE
    );
    expect(store.getStatus().backend).toBe('keychain-unavailable');
  });

  it('delete() rejects KeychainUnavailableError so callers do not claim logout succeeded', async () => {
    const keychain = new StubCredentialStore(
      async () => null,
      async () => [],
      async () => {},
      async () => {
        throw new KeychainUnavailableError('keychain locked');
      }
    );
    const store = new KeychainStatusCredentialStore(keychain);

    await expect(store.delete('neokai.provider.test', 'default')).rejects.toThrow(
      KEYCHAIN_UNAVAILABLE_MESSAGE
    );
    expect(keychain.deletes).toEqual([['neokai.provider.test', 'default']]);
    expect(store.getStatus().backend).toBe('keychain-unavailable');
  });

  it('listServices() uses keychain only', async () => {
    const keychain = new StubCredentialStore(
      async () => null,
      async () => ['neokai.provider.a', 'neokai.provider.b']
    );
    const store = new KeychainStatusCredentialStore(keychain);

    expect(await store.listServices('neokai.provider.')).toEqual([
      'neokai.provider.a',
      'neokai.provider.b',
    ]);
  });

  it('status change callback fires on unavailable → available transition', async () => {
    let keychainThrowing = true;
    const keychain = new StubCredentialStore(
      async () => {
        if (keychainThrowing) throw new KeychainUnavailableError('locked');
        return null;
      },
      async () => []
    );
    const store = new KeychainStatusCredentialStore(keychain);
    const calls: string[] = [];
    store.setStatusChangeCallback(() => calls.push('fired'));

    await store.get('a', 'b');
    expect(store.getStatus().backend).toBe('keychain-unavailable');
    expect(calls).toHaveLength(1);

    keychainThrowing = false;
    await store.get('a', 'b');
    expect(store.getStatus().backend).toBe('keychain');
    expect(calls).toHaveLength(2);
  });

  it('warns once when keychain remains unavailable', async () => {
    const keychain = new StubCredentialStore(
      async () => {
        throw new KeychainUnavailableError('locked');
      },
      async () => []
    );
    const store = new KeychainStatusCredentialStore(keychain);

    await store.get('a', 'b');
    await store.get('c', 'd');
    await store.get('e', 'f');

    const warnEvents = logEvents.filter((e) => e.level === 'warn');
    expect(warnEvents).toHaveLength(1);
    expect(warnEvents[0]?.message ?? '').toContain('Keychain is locked or unavailable');
  });
});
