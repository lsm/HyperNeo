/**
 * DatabaseLock Unit Tests
 *
 * Tests for database lock acquisition, release, and the synchronous
 * process.on('exit') fallback that removes the lock file when async
 * signal handlers do not fire (SIGTERM, SIGHUP, Bun Ctrl+C kill).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseLock } from '../../../../src/storage/database-lock';

describe('DatabaseLock', () => {
  let testDir: string;
  let dbPath: string;
  let lockPath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `db-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    dbPath = join(testDir, 'test.db');
    lockPath = `${dbPath}.lock`;
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('acquire', () => {
    it('should create a lock file containing the current PID', () => {
      const lock = new DatabaseLock(dbPath);
      lock.acquire();

      expect(existsSync(lockPath)).toBe(true);
      const content = readFileSync(lockPath, 'utf-8');
      expect(parseInt(content, 10)).toBe(process.pid);

      lock.release();
    });

    it('should be idempotent when called twice', () => {
      const lock = new DatabaseLock(dbPath);
      lock.acquire();

      const countAfterFirst = process.listenerCount('exit');
      lock.acquire(); // Should not register another listener

      expect(process.listenerCount('exit')).toBe(countAfterFirst);
      expect(existsSync(lockPath)).toBe(true);

      lock.release();
    });

    it('should register exactly one process.on("exit") listener', () => {
      const before = process.listenerCount('exit');
      const lock = new DatabaseLock(dbPath);
      lock.acquire();

      expect(process.listenerCount('exit')).toBe(before + 1);

      lock.release();
    });

    it('should not register an exit listener for in-memory databases', () => {
      const before = process.listenerCount('exit');
      const lock = new DatabaseLock(':memory:');
      lock.acquire();

      expect(process.listenerCount('exit')).toBe(before);
    });

    it('should remove the lock file when the exit handler is invoked directly', () => {
      const beforeListeners = process.rawListeners('exit') as (() => void)[];
      const lock = new DatabaseLock(dbPath);
      lock.acquire();

      expect(existsSync(lockPath)).toBe(true);

      // Find the handler that was just registered (not present before acquire)
      const afterListeners = process.rawListeners('exit') as (() => void)[];
      const newHandler = afterListeners.find((l) => !beforeListeners.includes(l));
      expect(newHandler).toBeDefined();

      // Invoke it directly to simulate a process.on('exit') fire without
      // actually exiting — safe because we bypass the event system.
      newHandler!();

      expect(existsSync(lockPath)).toBe(false);

      // Remove the handler from the process since we bypassed release()
      process.removeListener('exit', newHandler!);
    });
  });

  describe('release', () => {
    it('should remove the lock file', () => {
      const lock = new DatabaseLock(dbPath);
      lock.acquire();
      expect(existsSync(lockPath)).toBe(true);

      lock.release();

      expect(existsSync(lockPath)).toBe(false);
    });

    it('should deregister the process.exit listener', () => {
      const lock = new DatabaseLock(dbPath);
      lock.acquire();
      const afterAcquire = process.listenerCount('exit');

      lock.release();

      expect(process.listenerCount('exit')).toBe(afterAcquire - 1);
    });

    it('should be idempotent when called twice', () => {
      const lock = new DatabaseLock(dbPath);
      lock.acquire();
      lock.release();

      // Second release should be a no-op and not throw
      expect(() => lock.release()).not.toThrow();
    });

    it('should be safe to call without a prior acquire', () => {
      const lock = new DatabaseLock(dbPath);
      expect(() => lock.release()).not.toThrow();
    });
  });

  describe('stale lock detection', () => {
    it('should take over a stale lock from a dead process', () => {
      // Write a lock file with a PID that is almost certainly dead
      writeFileSync(lockPath, '2147483647', 'utf-8'); // Max int32 — no such process

      const lock = new DatabaseLock(dbPath);
      expect(() => lock.acquire()).not.toThrow();

      // Our PID should now be in the lock file
      const content = readFileSync(lockPath, 'utf-8');
      expect(parseInt(content, 10)).toBe(process.pid);

      lock.release();
    });

    it('should throw when another live process holds the lock', () => {
      // Write a lock file for the parent process (which is alive)
      const alivePid = process.ppid ?? 1;
      writeFileSync(lockPath, String(alivePid), 'utf-8');

      const lock = new DatabaseLock(dbPath);
      let threw = false;
      try {
        lock.acquire();
        // If ppid isn't alive or equals our PID, acquire succeeds — clean up
        lock.release();
      } catch (err) {
        threw = true;
        expect(String(err)).toContain('Another HyperNeo daemon is already running');
      }

      // On platforms where ppid is verifiably alive and ≠ process.pid this
      // should always throw; on edge cases (ppid === pid) we skip the check.
      if (alivePid !== process.pid) {
        expect(threw).toBe(true);
      }
    });
  });
});
