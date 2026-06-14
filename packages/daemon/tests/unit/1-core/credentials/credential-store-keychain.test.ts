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

const { KeychainCredentialStore } = await import(
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

  it('get() returns null on exit code 36 (keychain locked)', async () => {
    execFileImpl = (_cmd: unknown, _args: unknown, cb: (err: unknown) => void) => {
      cb(makeExecFileError(36, 'security: User interaction is not allowed.'));
      return undefined as unknown;
    };
    const store = new KeychainCredentialStore();
    expect(await store.get('neokai.provider.test', 'default')).toBeNull();
  });

  it('get() returns null when stderr contains "User interaction is not allowed"', async () => {
    execFileImpl = (_cmd: unknown, _args: unknown, cb: (err: unknown) => void) => {
      cb(makeExecFileError(1, 'User interaction is not allowed.'));
      return undefined as unknown;
    };
    const store = new KeychainCredentialStore();
    expect(await store.get('neokai.provider.test', 'default')).toBeNull();
  });

  it('get() still throws on unrelated exit codes', async () => {
    execFileImpl = (_cmd: unknown, _args: unknown, cb: (err: unknown) => void) => {
      cb(makeExecFileError(99, 'something else'));
      return undefined as unknown;
    };
    const store = new KeychainCredentialStore();
    await expect(store.get('neokai.provider.test', 'default')).rejects.toThrow();
  });

  it('set() resolves silently on exit code 36', async () => {
    spawnImpl = () => {
      const proc = new EventEmitter() as MockSpawnProcess;
      proc.stderr = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stdin = { write: () => undefined, end: () => undefined };
      queueMicrotask(() => proc.emit('close', 36));
      return proc;
    };
    const store = new KeychainCredentialStore();
    await store.set('neokai.provider.test', 'default', 'secret');
  });

  it('set() rejects on non-zero exit (not 36)', async () => {
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

  it('delete() resolves silently on exit code 36', async () => {
    execFileImpl = (_cmd: unknown, _args: unknown, cb: (err: unknown) => void) => {
      cb(makeExecFileError(36, 'User interaction is not allowed.'));
      return undefined as unknown;
    };
    const store = new KeychainCredentialStore();
    await expect(store.delete('neokai.provider.test', 'default')).resolves.toBeUndefined();
  });
});
