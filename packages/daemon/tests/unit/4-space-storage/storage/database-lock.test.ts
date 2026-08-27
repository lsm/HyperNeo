import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    } catch {}
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
      lock.acquire();

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

      const afterListeners = process.rawListeners('exit') as (() => void)[];
      const newHandler = afterListeners.find((l) => !beforeListeners.includes(l));
      expect(newHandler).toBeDefined();

      newHandler!();

      expect(existsSync(lockPath)).toBe(false);

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

      expect(() => lock.release()).not.toThrow();
    });

    it('should be safe to call without a prior acquire', () => {
      const lock = new DatabaseLock(dbPath);
      expect(() => lock.release()).not.toThrow();
    });
  });

  describe('stale lock detection', () => {
    it('should take over a stale lock from a dead process', () => {
      writeFileSync(lockPath, '2147483647', 'utf-8');

      const lock = new DatabaseLock(dbPath);
      expect(() => lock.acquire()).not.toThrow();

      const content = readFileSync(lockPath, 'utf-8');
      expect(parseInt(content, 10)).toBe(process.pid);

      lock.release();
    });

    it('should take over a lock file with non-numeric content', () => {
      writeFileSync(lockPath, 'not-a-pid', 'utf-8');

      const lock = new DatabaseLock(dbPath);
      expect(() => lock.acquire()).not.toThrow();

      const content = readFileSync(lockPath, 'utf-8');
      expect(parseInt(content, 10)).toBe(process.pid);

      lock.release();
    });

    it('should retry when the lock file is empty and leave it untouched', () => {
      writeFileSync(lockPath, '', 'utf-8');

      const lock = new DatabaseLock(dbPath);
      let threw = false;
      try {
        lock.acquire();
        lock.release();
      } catch (err) {
        threw = true;
        expect(String(err)).toContain('after repeated attempts');
      }
      expect(threw).toBe(true);
      expect(existsSync(lockPath)).toBe(true);
      expect(readFileSync(lockPath, 'utf-8')).toBe('');
    });

    it('should derive the lock from a dangling symlink target', () => {
      const realDir = join(testDir, 'real');
      mkdirSync(realDir, { recursive: true });
      const linkPath = join(testDir, 'link.db');
      symlinkSync(join(realDir, 'daemon.db'), linkPath);

      const lock = new DatabaseLock(linkPath);
      lock.acquire();

      expect(existsSync(join(realDir, 'daemon.db.lock'))).toBe(true);
      expect(existsSync(`${linkPath}.lock`)).toBe(false);
      expect(parseInt(readFileSync(join(realDir, 'daemon.db.lock'), 'utf-8'), 10)).toBe(
        process.pid
      );

      lock.release();
      expect(existsSync(join(realDir, 'daemon.db.lock'))).toBe(false);
    });

    it('should refuse while a takeover marker is present and leave it untouched', () => {
      writeFileSync(lockPath, '999999999', 'utf-8');
      writeFileSync(`${lockPath}.takeover`, String(process.ppid ?? 1), 'utf-8');

      const lock = new DatabaseLock(dbPath);
      let threw = false;
      try {
        lock.acquire();
        lock.release();
      } catch (err) {
        threw = true;
        expect(String(err)).toContain('after repeated attempts');
        expect(String(err)).toContain('.takeover');
      }
      expect(threw).toBe(true);
      expect(existsSync(`${lockPath}.takeover`)).toBe(true);
    });

    it('should take over a lock naming its own pid', () => {
      writeFileSync(lockPath, String(process.pid), 'utf-8');

      const lock = new DatabaseLock(dbPath);
      expect(() => lock.acquire()).not.toThrow();

      const content = readFileSync(lockPath, 'utf-8');
      expect(parseInt(content, 10)).toBe(process.pid);

      lock.release();
    });

    it('should throw when another live process holds the lock', () => {
      const alivePid = process.ppid ?? 1;
      writeFileSync(lockPath, String(alivePid), 'utf-8');

      const lock = new DatabaseLock(dbPath);
      let threw = false;
      try {
        lock.acquire();
        lock.release();
      } catch (err) {
        threw = true;
        expect(String(err)).toContain('Another HyperNeo daemon is already running');
      }

      if (alivePid !== process.pid) {
        expect(threw).toBe(true);
      }
    });
  });
});
