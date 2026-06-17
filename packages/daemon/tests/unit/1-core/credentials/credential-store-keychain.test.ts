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
  buildDefaultUnlockers,
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

// Module-scope mock helpers so multiple `describe` blocks can drive the
// locked / success paths without redefining them per scope.
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

  it('set() retries the primary store after a successful unlock (no fallback cleanup to avoid race)', async () => {
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
    // Deliberately NOT calling fallback.delete on primary success: a
    // concurrent writer (oauth-refresh-scheduler, daemon startup) could
    // have routed a write to the fallback between our primary success and
    // a cleanup delete. Reads prefer the keychain whenever it's reachable,
    // so a stale fallback copy is harmless.
    expect(fallbackDeleteCalls).toEqual([]);
  });

  it('set() re-attempts unlock after recovery (unlockAttempted resets on markKeychainAvailable)', async () => {
    // First set: keychain locked, unlock fails, fallback used.
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
        return false; // Always fails — won't actually unlock.
      },
    ];
    const store = new KeychainStatusCredentialStore(
      new KeychainCredentialStore(),
      fallback,
      unlockers
    );

    await store.set('neokai.provider.test', 'default', 'first');
    expect(unlockCalls).toBe(1);
    expect(store.getStatus().backend).toBe('keychain-fallback');

    // Simulate external `security unlock-keychain` succeeding: next read
    // hits the keychain successfully and flips status back to available,
    // which should reset unlockAttempted so subsequent writes retry.
    execFileImpl = (
      _c: unknown,
      _a: unknown,
      cb: (err: unknown, stdout: string, stderr: string) => void
    ) => {
      cb(null, '{"ok":true}', '');
      return undefined as unknown;
    };
    makeSuccessSpawn();
    await store.get('neokai.provider.test', 'default');
    expect(store.getStatus().backend).toBe('keychain');

    // Now next set should retry unlocker since latch reset.
    makeLockedSpawn();
    await store.set('neokai.provider.test', 'default', 'second');
    expect(unlockCalls).toBe(2);
  });

  it('get() prefers keychain over fallback when keychain is reachable (authoritative)', async () => {
    // Keychain returns a value; fallback has a stale different value.
    // Without preferring keychain, we'd surface stale fallback data.
    execFileImpl = (
      _c: unknown,
      _a: unknown,
      cb: (err: unknown, stdout: string, stderr: string) => void
    ) => {
      cb(null, '{"fresh":"keychain"}', '');
      return undefined as unknown;
    };
    const fallback = {
      get: async () => '{"stale":"fallback"}',
      set: async () => undefined,
      delete: async () => undefined,
      listServices: async () => [] as string[],
    };
    const store = new KeychainStatusCredentialStore(new KeychainCredentialStore(), fallback);
    // Mark as previously fallen back to exercise the "always keychain first" path.
    store.setStatusChangeCallback(() => {});
    expect(store.getStatus().backend).toBe('keychain'); // sanity

    const result = await store.get('neokai.provider.test', 'default');
    expect(result).toBe('{"fresh":"keychain"}');
  });

  it('get() falls through to fallback when keychain is reachable but item missing', async () => {
    // Value was previously written to fallback while keychain was locked;
    // keychain has since been unlocked but never had this item. Get should
    // return fallback copy, not null.
    execFileImpl = (_c: unknown, _a: unknown, cb: (err: unknown) => void) => {
      const err = new Error('not found') as Error & { code: number; stderr: string };
      err.code = 44; // errSecItemNotFound
      err.stderr = 'could not be found';
      cb(err);
      return undefined as unknown;
    };
    const fallback = {
      get: async () => '{"only":"in-fallback"}',
      set: async () => undefined,
      delete: async () => undefined,
      listServices: async () => [] as string[],
    };
    const store = new KeychainStatusCredentialStore(new KeychainCredentialStore(), fallback);

    const result = await store.get('neokai.provider.test', 'default');
    expect(result).toBe('{"only":"in-fallback"}');
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

  it('delete() throws when keychain is locked — no fallback for irreversible op', async () => {
    // Delete is an irreversible op against the authoritative store.
    // Deleting only from the fallback would leave the keychain copy
    // behind, and the next time the keychain becomes reachable `get()`
    // would prefer it — provider appears re-authenticated after the
    // user explicitly logged out. Surface the failure instead.
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

    await expect(store.delete('neokai.provider.test', 'default')).rejects.toThrow(
      /\(blocked: delete\(neokai\.provider\.test:default\)\)$/
    );
    // Fallback must NOT be touched: partial delete would mislead callers
    // (UI shows "logged out" but keychain copy survives).
    expect(fallbackDeleteCalled).toBe(false);
    expect(store.getStatus().backend).toBe('keychain-unavailable');
  });

  it('set() refreshes an existing fallback copy on keychain-success (no stale rotation)', async () => {
    // API key was written to fallback while keychain was locked.
    // Keychain later unlocks; user rotates key. Without write-through,
    // fallback has stale key, surfaces on next keychain lock.
    let fallbackValue: string | null = 'old-rotated-away-value';
    let fallbackSetCalls = 0;
    const fallback = {
      get: async () => fallbackValue,
      set: async (_s: string, _a: string, data: string) => {
        fallbackSetCalls += 1;
        fallbackValue = data;
      },
      delete: async () => {
        fallbackValue = null;
      },
      listServices: async () => [] as string[],
    };
    // Keychain set succeeds (keychain reachable).
    makeSuccessSpawn();
    const store = new KeychainStatusCredentialStore(new KeychainCredentialStore(), fallback);

    await store.set('neokai.provider.test', 'default', 'new-rotated-value');
    expect(fallbackSetCalls).toBe(1);
    expect(fallbackValue).toBe('new-rotated-value');
  });

  it('set() does NOT create a new fallback entry on keychain-success (keeps weaker-isolation surface minimal)', async () => {
    // Entry was never in fallback (user wrote it while keychain was
    // reachable). Don't broaden the weaker-isolation surface by writing
    // a copy now.
    let fallbackValue: string | null = null;
    let fallbackSetCalls = 0;
    const fallback = {
      get: async () => fallbackValue,
      set: async () => {
        fallbackSetCalls += 1;
      },
      delete: async () => undefined,
      listServices: async () => [] as string[],
    };
    makeSuccessSpawn();
    const store = new KeychainStatusCredentialStore(new KeychainCredentialStore(), fallback);

    await store.set('neokai.provider.test', 'default', 'value');
    expect(fallbackSetCalls).toBe(0);
  });

  it('statusChangeCallback fires AFTER fallback write completes (no re-entrant race)', async () => {
    // Reproduces the round 4 re-entrancy concern: callback fires inline
    // during state transition while the fallback write is still pending.
    // Reorder guarantees the write is durable before subscribers observe
    // the keychain-fallback transition.
    makeLockedSpawn();
    let callbackFiredBeforeFallbackSet = false;
    let fallbackSetDone = false;
    let callbackFireCount = 0;
    const fallback = {
      get: async () => null as string | null,
      set: async () => {
        // Defer slightly so we can observe ordering.
        await new Promise((r) => setTimeout(r, 5));
        fallbackSetDone = true;
      },
      delete: async () => undefined,
      listServices: async () => [] as string[],
    };
    const store = new KeychainStatusCredentialStore(new KeychainCredentialStore(), fallback);
    store.setStatusChangeCallback(() => {
      callbackFireCount += 1;
      if (!fallbackSetDone) callbackFiredBeforeFallbackSet = true;
    });

    await store.set('neokai.provider.test', 'default', 'data');
    expect(callbackFireCount).toBeGreaterThanOrEqual(1);
    expect(callbackFiredBeforeFallbackSet).toBe(false);
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

describe('KeychainStatusCredentialStore — ttyCheck gate on default unlocker', () => {
  beforeEach(() => {
    execFileImpl = null;
    spawnImpl = null;
  });
  afterEach(() => {
    execFileImpl = null;
    spawnImpl = null;
  });

  it('buildDefaultUnlockers: ttyCheck=false short-circuits before spawn (pins production gate)', async () => {
    // Exercises the REAL buildDefaultUnlockers factory — not a stub. If a
    // future refactor drops the ttyCheck gate inside the factory, the
    // unlocker would fall through to tryUnlockKeychainViaGUI → spawnImpl
    // would be invoked → spawnObserved becomes true → test fails. That's
    // the regression the round 2 review asked us to pin.
    let spawnObserved = false;
    let execFileObserved = false;
    spawnImpl = () => {
      spawnObserved = true;
      const proc = new EventEmitter() as MockSpawnProcess;
      proc.stderr = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stdin = { write: () => undefined, end: () => undefined };
      queueMicrotask(() => proc.emit('close', 0));
      return proc;
    };
    execFileImpl = (
      _cmd: unknown,
      _args: unknown,
      cb: (err: unknown, stdout: string, stderr: string) => void
    ) => {
      execFileObserved = true;
      cb(null, '', '');
      return undefined as unknown;
    };

    const unlockers = buildDefaultUnlockers(() => false);
    expect(unlockers.length).toBe(1);
    const result = await unlockers[0]();
    expect(result).toBe(false);
    expect(spawnObserved).toBe(false);
    expect(execFileObserved).toBe(false);
  });

  it('buildDefaultUnlockers: ttyCheck=true falls through to tryUnlockKeychainViaGUI (spawn observed)', async () => {
    // Positive control — verifies the gate is the ONLY thing preventing
    // the spawn. With ttyCheck=true, the unlocker reaches the GUI spawn
    // path. Uses execFile (tryUnlockKeychainViaGUI calls execFileAsync,
    // not spawn), so assert against execFileImpl.
    let execFileObserved = false;
    execFileImpl = (
      _cmd: unknown,
      _args: unknown,
      cb: (err: unknown, stdout: string, stderr: string) => void
    ) => {
      execFileObserved = true;
      cb(null, '', '');
      return undefined as unknown;
    };

    const unlockers = buildDefaultUnlockers(() => true);
    const result = await unlockers[0]();
    expect(result).toBe(true);
    expect(execFileObserved).toBe(true);
  });
});

describe('KeychainStatusCredentialStore — error message shape', () => {
  beforeEach(() => {
    execFileImpl = null;
    spawnImpl = null;
  });
  afterEach(() => {
    execFileImpl = null;
    spawnImpl = null;
  });

  it('set() appends (blocked: label) suffix when no fallback is configured', async () => {
    // Pins the suffix format consumed by callers / log scrapers. The base
    // message lives in KEYCHAIN_UNAVAILABLE_MESSAGE; the suffix identifies
    // which operation was blocked so operators can correlate.
    makeLockedSpawn();
    const store = new KeychainStatusCredentialStore(new KeychainCredentialStore());

    await expect(store.set('neokai.provider.foo', 'default', 'data')).rejects.toThrow(
      /\(blocked: set\(neokai\.provider\.foo:default\)\)$/
    );
  });

  it('delete() appends (blocked: label) suffix when no fallback is configured', async () => {
    makeLockedExecFile();
    const store = new KeychainStatusCredentialStore(new KeychainCredentialStore());

    await expect(store.delete('neokai.provider.bar', 'default')).rejects.toThrow(
      /\(blocked: delete\(neokai\.provider\.bar:default\)\)$/
    );
  });
});
