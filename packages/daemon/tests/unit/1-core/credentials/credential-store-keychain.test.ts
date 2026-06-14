/**
 * KeychainCredentialStore tests with mocked `node:child_process`.
 *
 * Uses dynamic import AFTER `mock.module` registration so the source module
 * picks up the mocked `execFile` / `spawn`.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Database } from 'bun:sqlite';

interface MockSpawnProcess extends EventEmitter {
  stderr: EventEmitter;
  stdout: EventEmitter;
  stdin: { write: () => void; end: () => void };
}

let execFileImpl: ((...args: unknown[]) => unknown) | null = null;
let spawnImpl: ((...args: unknown[]) => MockSpawnProcess) | null = null;

const originalChildProcess = require('node:child_process');

mock.module('node:child_process', () => ({
  ...originalChildProcess,
  execFile: (...args: unknown[]) => {
    if (!execFileImpl) {
      throw new Error('execFileImpl not set for test');
    }
    return execFileImpl(...args);
  },
  spawn: (...args: unknown[]) => {
    if (!spawnImpl) {
      throw new Error('spawnImpl not set for test');
    }
    return spawnImpl(...args);
  },
}));

const { KeychainCredentialStore, FallbackCredentialStore, KeychainUnavailableError } = await import(
  '../../../../src/lib/credentials/credential-store.js'
);

function makeExecFileError(code: number, stderr: string): Error {
  const err = new Error(`Command failed: security exit ${code}`) as Error & {
    code: number;
    stderr: string;
  };
  err.code = code;
  err.stderr = stderr;
  return err;
}

describe('KeychainCredentialStore — exit code 36 handling', () => {
  beforeEach(() => {
    execFileImpl = null;
    spawnImpl = null;
  });
  afterEach(() => {
    execFileImpl = null;
    spawnImpl = null;
  });

  it('get() throws KeychainUnavailableError on exit code 36', async () => {
    execFileImpl = (_cmd: unknown, _args: unknown, cb: (err: unknown) => void) => {
      cb(makeExecFileError(36, 'security: User interaction is not allowed.'));
      return undefined as unknown;
    };
    const store = new KeychainCredentialStore();
    await expect(store.get('neokai.provider.test', 'default')).rejects.toBeInstanceOf(
      KeychainUnavailableError
    );
  });

  it('get() throws KeychainUnavailableError when stderr contains "User interaction is not allowed"', async () => {
    execFileImpl = (_cmd: unknown, _args: unknown, cb: (err: unknown) => void) => {
      cb(makeExecFileError(1, 'User interaction is not allowed.'));
      return undefined as unknown;
    };
    const store = new KeychainCredentialStore();
    await expect(store.get('neokai.provider.test', 'default')).rejects.toBeInstanceOf(
      KeychainUnavailableError
    );
  });

  it('get() still throws on unrelated exit codes', async () => {
    execFileImpl = (_cmd: unknown, _args: unknown, cb: (err: unknown) => void) => {
      cb(makeExecFileError(99, 'something else'));
      return undefined as unknown;
    };
    const store = new KeychainCredentialStore();
    await expect(store.get('neokai.provider.test', 'default')).rejects.toThrow();
  });

  it('set() rejects with KeychainUnavailableError on exit code 36', async () => {
    spawnImpl = () => {
      const proc = new EventEmitter() as MockSpawnProcess;
      proc.stderr = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stdin = { write: () => undefined, end: () => undefined };
      queueMicrotask(() => {
        proc.stderr.emit('data', Buffer.from('User interaction is not allowed.'));
        proc.emit('close', 36);
      });
      return proc;
    };
    const store = new KeychainCredentialStore();
    await expect(store.set('neokai.provider.test', 'default', 'secret')).rejects.toBeInstanceOf(
      KeychainUnavailableError
    );
  });

  it('set() rejects with generic Error on non-zero exit (not 36)', async () => {
    spawnImpl = () => {
      const proc = new EventEmitter() as MockSpawnProcess;
      proc.stderr = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stdin = { write: () => undefined, end: () => undefined };
      queueMicrotask(() => {
        proc.stderr.emit('data', Buffer.from('boom'));
        proc.emit('close', 1);
      });
      return proc;
    };
    const store = new KeychainCredentialStore();
    await expect(store.set('neokai.provider.test', 'default', 'secret')).rejects.toThrow();
  });

  it('delete() rejects with KeychainUnavailableError on exit code 36', async () => {
    execFileImpl = (_cmd: unknown, _args: unknown, cb: (err: unknown) => void) => {
      cb(makeExecFileError(36, 'User interaction is not allowed.'));
      return undefined as unknown;
    };
    const store = new KeychainCredentialStore();
    await expect(store.delete('neokai.provider.test', 'default')).rejects.toBeInstanceOf(
      KeychainUnavailableError
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: real KeychainCredentialStore + FallbackCredentialStore + real
// DatabaseCredentialStore, with `node:child_process` mocked to drive the same
// exit-code paths the daemon sees on a locked macOS Keychain.
//
// These tests guard against the P0 regression where KeychainCredentialStore
// silently swallows code 36 and FallbackCredentialStore consequently drops
// the credential. They use the REAL classes end-to-end.
// ---------------------------------------------------------------------------

describe('FallbackCredentialStore integration (real KeychainCredentialStore + DB fallback)', () => {
  beforeEach(() => {
    execFileImpl = null;
    spawnImpl = null;
  });
  afterEach(() => {
    execFileImpl = null;
    spawnImpl = null;
  });

  function makeStore(): { store: FallbackCredentialStore; db: Database } {
    const db = new Database(':memory:');
    const store = new FallbackCredentialStore(
      new KeychainCredentialStore(),
      // Inject a stable encryption key so tests don't write to ~/.neokai
      new (require('../../../../src/lib/credentials/credential-store.js').DatabaseCredentialStore)(
        db,
        'integration-test-secret'
      )
    );
    return { store, db };
  }

  it('get() falls through to DB and marks keychain unavailable on code 36', async () => {
    // Seed DB fallback with a credential.
    const { store, db } = makeStore();
    try {
      // First write via the fallback so DB has the row.
      execFileImpl = (_cmd: unknown, _args: unknown, cb: (err: unknown) => void) => {
        // dump-keychain returns no services (clean keychain) — fine.
        cb(null, '', '');
        return undefined as unknown;
      };
      // Force keychain failure on write (set goes through spawn, but we also
      // need get() to fail) — set up both.
      spawnImpl = () => {
        const proc = new EventEmitter() as MockSpawnProcess;
        proc.stderr = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stdin = { write: () => undefined, end: () => undefined };
        queueMicrotask(() => {
          proc.stderr.emit('data', Buffer.from('User interaction is not allowed.'));
          proc.emit('close', 36);
        });
        return proc;
      };
      execFileImpl = (_c: unknown, _a: unknown, cb: (err: unknown) => void) => {
        cb(makeExecFileError(36, 'User interaction is not allowed.'));
        return undefined as unknown;
      };

      await store.set('neokai.provider.test', 'default', 'integration-secret');
      // Status should now reflect unavailable.
      expect(store.getStatus().backend).toBe('database-fallback');
      expect(store.getStatus().keychainAvailable).toBe(false);

      const result = await store.get('neokai.provider.test', 'default');
      expect(result).toBe('integration-secret');

      // Verify credential actually persisted in DB (keychain was unavailable).
      const row = db
        .query<{ encrypted_data: Uint8Array }, []>(
          'SELECT encrypted_data FROM provider_credentials WHERE provider_id = ?'
        )
        .get('neokai.provider.test:default');
      expect(row).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('set() persists to DB when keychain unavailable (does NOT silently drop)', async () => {
    const { store, db } = makeStore();
    try {
      spawnImpl = () => {
        const proc = new EventEmitter() as MockSpawnProcess;
        proc.stderr = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stdin = { write: () => undefined, end: () => undefined };
        queueMicrotask(() => {
          proc.stderr.emit('data', Buffer.from('User interaction is not allowed.'));
          proc.emit('close', 36);
        });
        return proc;
      };

      await store.set('neokai.provider.test', 'default', 'must-not-be-lost');

      const row = db
        .query<{ provider_id: string }, []>(
          'SELECT provider_id FROM provider_credentials WHERE provider_id = ?'
        )
        .get('neokai.provider.test:default');
      expect(row).not.toBeNull();
      expect(store.getStatus().backend).toBe('database-fallback');
    } finally {
      db.close();
    }
  });

  it('delete() does not throw when keychain unavailable', async () => {
    const { store, db } = makeStore();
    try {
      execFileImpl = (_cmd: unknown, _args: unknown, cb: (err: unknown) => void) => {
        cb(makeExecFileError(36, 'User interaction is not allowed.'));
        return undefined as unknown;
      };
      // FallbackCredentialStore.delete uses Promise.allSettled so primary
      // rejection is swallowed; fallback delete still runs.
      await expect(store.delete('neokai.provider.test', 'default')).resolves.toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('get() does NOT mark unavailable when primary throws a non-keychain error', async () => {
    const { store, db } = makeStore();
    try {
      execFileImpl = (_cmd: unknown, _args: unknown, cb: (err: unknown) => void) => {
        cb(makeExecFileError(99, 'unexpected'));
        return undefined as unknown;
      };
      // Non-keychain error must propagate, not be masked by fallback.
      await expect(store.get('neokai.provider.test', 'default')).rejects.toThrow();
      expect(store.getStatus().backend).toBe('keychain');
    } finally {
      db.close();
    }
  });
});
