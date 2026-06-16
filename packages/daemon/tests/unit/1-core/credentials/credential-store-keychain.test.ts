/**
 * KeychainCredentialStore tests with mocked `node:child_process`.
 *
 * Uses dynamic import AFTER `mock.module` registration so the source module
 * picks up the mocked `execFile` / `spawn`.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';

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

const {
  KeychainCredentialStore,
  KeychainStatusCredentialStore,
  KeychainUnavailableError,
  KEYCHAIN_UNAVAILABLE_MESSAGE,
} = await import('../../../../src/lib/credentials/credential-store.js');

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

  it('set() rejects with KeychainUnavailableError when stderr says user interaction is not allowed', async () => {
    spawnImpl = () => {
      const proc = new EventEmitter() as MockSpawnProcess;
      proc.stderr = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stdin = { write: () => undefined, end: () => undefined };
      queueMicrotask(() => {
        proc.stderr.emit('data', Buffer.from('User interaction is not allowed.'));
        proc.emit('close', 1);
      });
      return proc;
    };
    const store = new KeychainCredentialStore();
    await expect(store.set('neokai.provider.test', 'default', 'secret')).rejects.toBeInstanceOf(
      KeychainUnavailableError
    );
  });

  it('set() rejects with generic Error on non-zero exit (not unavailable)', async () => {
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

describe('KeychainCredentialStore — security argv sanity', () => {
  let lastSpawnArgs: string[] | null = null;
  let lastExecFileArgs: string[] | null = null;

  beforeEach(() => {
    lastSpawnArgs = null;
    lastExecFileArgs = null;
    execFileImpl = (
      _cmd: unknown,
      args: string[],
      cb: (err: unknown, stdout: string, stderr: string) => void
    ) => {
      lastExecFileArgs = args;
      cb(null, '', '');
      return undefined as unknown;
    };
    spawnImpl = (_cmd: unknown, args: string[]) => {
      lastSpawnArgs = args;
      const proc = new EventEmitter() as MockSpawnProcess;
      proc.stderr = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stdin = { write: () => undefined, end: () => undefined };
      queueMicrotask(() => proc.emit('close', 0));
      return proc;
    };
  });
  afterEach(() => {
    execFileImpl = null;
    spawnImpl = null;
  });

  it('set() invokes security add-generic-password against the default keychain', async () => {
    const store = new KeychainCredentialStore();
    await store.set('neokai.provider.test', 'default', 'secret');
    expect(lastSpawnArgs?.[0]).toBe('add-generic-password');
    // No trailing positional path arg — default login.keychain-db.
    expect(lastSpawnArgs?.[lastSpawnArgs.length - 1]).toBe('secret');
  });

  it('get() invokes security find-generic-password against the default keychain', async () => {
    const store = new KeychainCredentialStore();
    await store.get('neokai.provider.test', 'default');
    expect(lastExecFileArgs?.[0]).toBe('find-generic-password');
    expect(lastExecFileArgs?.[lastExecFileArgs!.length - 1]).toBe('-w');
  });
});

// ---------------------------------------------------------------------------
// Integration: real KeychainCredentialStore + KeychainStatusCredentialStore,
// with `node:child_process` mocked to drive locked-Keychain paths.
// ---------------------------------------------------------------------------

describe('KeychainStatusCredentialStore integration (real KeychainCredentialStore)', () => {
  beforeEach(() => {
    execFileImpl = null;
    spawnImpl = null;
  });
  afterEach(() => {
    execFileImpl = null;
    spawnImpl = null;
  });

  function makeLockedSpawn(): void {
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
  }

  function makeSuccessSpawn(): void {
    spawnImpl = () => {
      const proc = new EventEmitter() as MockSpawnProcess;
      proc.stderr = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stdin = { write: () => undefined, end: () => undefined };
      queueMicrotask(() => proc.emit('close', 0));
      return proc;
    };
  }

  function makeLockedExecFile(): void {
    execFileImpl = (_c: unknown, _a: unknown, cb: (err: unknown) => void) => {
      cb(makeExecFileError(36, 'User interaction is not allowed.'));
      return undefined as unknown;
    };
  }

  it('get() returns null and marks keychain unavailable on code 36 (no fallback)', async () => {
    makeLockedExecFile();
    const store = new KeychainStatusCredentialStore(new KeychainCredentialStore());

    await expect(store.get('neokai.provider.test', 'default')).resolves.toBeNull();
    expect(store.getStatus()).toEqual({
      backend: 'keychain-unavailable',
      keychainAvailable: false,
      warning: KEYCHAIN_UNAVAILABLE_MESSAGE,
    });
  });

  it('set() rejects with KeychainUnavailableError when no fallback is configured', async () => {
    makeLockedSpawn();
    const store = new KeychainStatusCredentialStore(new KeychainCredentialStore());

    await expect(store.set('neokai.provider.test', 'default', 'must-not-be-lost')).rejects.toThrow(
      KEYCHAIN_UNAVAILABLE_MESSAGE
    );
    expect(store.getStatus().backend).toBe('keychain-unavailable');
  });

  it('set() falls back to the fallback store when keychain is locked', async () => {
    makeLockedSpawn();
    let fallbackSetCalled = false;
    const fallback = {
      get: async () => null as string | null,
      set: async () => {
        fallbackSetCalled = true;
      },
      delete: async () => undefined,
      listServices: async () => [] as string[],
    };
    const store = new KeychainStatusCredentialStore(new KeychainCredentialStore(), fallback);

    await store.set('neokai.provider.test', 'default', 'fallback-data');
    expect(fallbackSetCalled).toBe(true);
    expect(store.getStatus().backend).toBe('keychain-fallback');
  });

  it('set() retries the primary store after a successful unlock and clears fallback copy', async () => {
    let attempt = 0;
    spawnImpl = () => {
      attempt += 1;
      const proc = new EventEmitter() as MockSpawnProcess;
      proc.stderr = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stdin = { write: () => undefined, end: () => undefined };
      queueMicrotask(() => {
        if (attempt === 1) {
          // First attempt: keychain locked.
          proc.stderr.emit('data', Buffer.from('User interaction is not allowed.'));
          proc.emit('close', 36);
        } else {
          // Retry after unlock succeeds.
          proc.emit('close', 0);
        }
      });
      return proc;
    };
    const fallbackDeleteCalls: string[] = [];
    const fallback = {
      get: async () => null as string | null,
      set: async () => undefined,
      delete: async (service: string) => {
        fallbackDeleteCalls.push(service);
      },
      listServices: async () => [] as string[],
    };
    let unlockCalled = false;
    const unlockers = [
      async () => {
        unlockCalled = true;
        return true;
      },
    ];
    const store = new KeychainStatusCredentialStore(
      new KeychainCredentialStore(),
      fallback,
      unlockers
    );

    await store.set('neokai.provider.test', 'default', 'recovered');
    expect(unlockCalled).toBe(true);
    expect(store.getStatus().backend).toBe('keychain');
    // Cleanup of stale fallback copy attempted.
    expect(fallbackDeleteCalls).toEqual(['neokai.provider.test']);
  });

  it('set() falls back when unlock succeeds but keychain write still fails', async () => {
    // Spawn always fails with 36 — simulates a keychain that can't be unlocked
    // interactively (e.g., CI sandbox).
    makeLockedSpawn();
    let fallbackSetCalled = false;
    const fallback = {
      get: async () => null as string | null,
      set: async () => {
        fallbackSetCalled = true;
      },
      delete: async () => undefined,
      listServices: async () => [] as string[],
    };
    let unlockCalled = false;
    const unlockers = [
      async () => {
        unlockCalled = true;
        return true;
      },
    ];
    const store = new KeychainStatusCredentialStore(
      new KeychainCredentialStore(),
      fallback,
      unlockers
    );

    await store.set('neokai.provider.test', 'default', 'data');
    expect(unlockCalled).toBe(true);
    expect(fallbackSetCalled).toBe(true);
    expect(store.getStatus().backend).toBe('keychain-fallback');
  });

  it('set() does not retry unlockers after the first failure (one-shot per session)', async () => {
    makeLockedSpawn();
    let unlockCalls = 0;
    const fallback = {
      get: async () => null as string | null,
      set: async () => undefined,
      delete: async () => undefined,
      listServices: async () => [] as string[],
    };
    const unlockers = [
      async () => {
        unlockCalls += 1;
        return false;
      },
    ];
    const store = new KeychainStatusCredentialStore(
      new KeychainCredentialStore(),
      fallback,
      unlockers
    );

    await store.set('neokai.provider.test', 'default', 'first');
    await store.set('neokai.provider.test', 'default', 'second');
    expect(unlockCalls).toBe(1); // Only the first failure triggers unlock attempt.
  });

  it('delete() falls back when keychain delete is locked', async () => {
    makeLockedExecFile();
    let fallbackDeleteCalled = false;
    const fallback = {
      get: async () => null as string | null,
      set: async () => undefined,
      delete: async () => {
        fallbackDeleteCalled = true;
      },
      listServices: async () => [] as string[],
    };
    const store = new KeychainStatusCredentialStore(new KeychainCredentialStore(), fallback);

    await store.delete('neokai.provider.test', 'default');
    expect(fallbackDeleteCalled).toBe(true);
    expect(store.getStatus().backend).toBe('keychain-fallback');
  });

  it('delete() succeeds on the primary when keychain is available', async () => {
    execFileImpl = (_cmd: unknown, _args: unknown, cb: (err: unknown) => void) => {
      cb(null, '', '');
      return undefined as unknown;
    };
    const store = new KeychainStatusCredentialStore(new KeychainCredentialStore());

    await expect(store.delete('neokai.provider.test', 'default')).resolves.toBeUndefined();
    expect(store.getStatus().backend).toBe('keychain');
  });

  it('get() does NOT mark unavailable when primary throws a non-keychain error', async () => {
    execFileImpl = (_cmd: unknown, _args: unknown, cb: (err: unknown) => void) => {
      cb(makeExecFileError(99, 'unexpected'));
      return undefined as unknown;
    };
    const store = new KeychainStatusCredentialStore(new KeychainCredentialStore());

    await expect(store.get('neokai.provider.test', 'default')).rejects.toThrow();
    expect(store.getStatus().backend).toBe('keychain');
  });

  it('get() surfaces fallback copy when keychain is locked and fallback has the value', async () => {
    makeLockedExecFile();
    const fallback = {
      get: async () => '{"type":"api_key","apiKey":"fb"}',
      set: async () => undefined,
      delete: async () => undefined,
      listServices: async () => [] as string[],
    };
    const store = new KeychainStatusCredentialStore(new KeychainCredentialStore(), fallback);

    await expect(store.get('neokai.provider.test', 'default')).resolves.toBe(
      '{"type":"api_key","apiKey":"fb"}'
    );
  });
});

describe('KeychainStatusCredentialStore — statusChangeCallback on transitions', () => {
  beforeEach(() => {
    execFileImpl = null;
    spawnImpl = null;
  });
  afterEach(() => {
    execFileImpl = null;
    spawnImpl = null;
  });

  it('fires statusChangeCallback when transitioning from keychain -> fallback', async () => {
    let calls = 0;
    let attempt = 0;
    spawnImpl = () => {
      attempt += 1;
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
    const fallback = {
      get: async () => null as string | null,
      set: async () => undefined,
      delete: async () => undefined,
      listServices: async () => [] as string[],
    };
    const store = new KeychainStatusCredentialStore(new KeychainCredentialStore(), fallback);
    store.setStatusChangeCallback(() => {
      calls += 1;
    });
    expect(attempt).toBe(0); // satisfy unused-var lint pattern.

    await store.set('neokai.provider.test', 'default', 'first');
    expect(store.getStatus().backend).toBe('keychain-fallback');
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});
