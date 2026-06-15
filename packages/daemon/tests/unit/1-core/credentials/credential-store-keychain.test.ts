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

  function makeStore(): KeychainStatusCredentialStore {
    return new KeychainStatusCredentialStore(new KeychainCredentialStore());
  }

  it('get() returns null and marks keychain unavailable on code 36', async () => {
    execFileImpl = (_c: unknown, _a: unknown, cb: (err: unknown) => void) => {
      cb(makeExecFileError(36, 'User interaction is not allowed.'));
      return undefined as unknown;
    };
    const store = makeStore();

    await expect(store.get('neokai.provider.test', 'default')).resolves.toBeNull();
    expect(store.getStatus()).toEqual({
      backend: 'keychain-unavailable',
      keychainAvailable: false,
      warning: KEYCHAIN_UNAVAILABLE_MESSAGE,
    });
  });

  it('set() rejects when keychain is unavailable and does not use DB fallback', async () => {
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
    const store = makeStore();

    await expect(store.set('neokai.provider.test', 'default', 'must-not-be-lost')).rejects.toThrow(
      KEYCHAIN_UNAVAILABLE_MESSAGE
    );
    expect(store.getStatus().backend).toBe('keychain-unavailable');
  });

  it('delete() rejects when keychain is unavailable so logout fails clearly', async () => {
    execFileImpl = (_cmd: unknown, _args: unknown, cb: (err: unknown) => void) => {
      cb(makeExecFileError(36, 'User interaction is not allowed.'));
      return undefined as unknown;
    };
    const store = makeStore();

    await expect(store.delete('neokai.provider.test', 'default')).rejects.toBeInstanceOf(
      KeychainUnavailableError
    );
    await expect(store.delete('neokai.provider.test', 'default')).rejects.toThrow(
      KEYCHAIN_UNAVAILABLE_MESSAGE
    );
    expect(store.getStatus().backend).toBe('keychain-unavailable');
  });

  it('delete() succeeds when keychain is available', async () => {
    execFileImpl = (_cmd: unknown, _args: unknown, cb: (err: unknown) => void) => {
      cb(null, '', '');
      return undefined as unknown;
    };
    const store = makeStore();

    await expect(store.delete('neokai.provider.test', 'default')).resolves.toBeUndefined();
    expect(store.getStatus().backend).toBe('keychain');
  });

  it('get() does NOT mark unavailable when primary throws a non-keychain error', async () => {
    execFileImpl = (_cmd: unknown, _args: unknown, cb: (err: unknown) => void) => {
      cb(makeExecFileError(99, 'unexpected'));
      return undefined as unknown;
    };
    const store = makeStore();

    await expect(store.get('neokai.provider.test', 'default')).rejects.toThrow();
    expect(store.getStatus().backend).toBe('keychain');
  });
});
