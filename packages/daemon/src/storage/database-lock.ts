/**
 * Database Lock Manager
 *
 * Ensures only one daemon process can use a given database file at a time.
 * Uses a PID lock file alongside the database with stale-lock detection.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Logger } from '../lib/logger';

export class DatabaseLock {
  private lockPath: string;
  private logger = new Logger('DatabaseLock');
  private acquired = false;
  /** Synchronous exit handler registered after acquire(); removed by release(). */
  private exitHandler: (() => void) | null = null;

  constructor(private dbPath: string) {
    this.lockPath = `${dbPath}.lock`;
  }

  /**
   * Acquire the lock. Throws if another live process already holds it.
   * No-op for in-memory databases (:memory:).
   */
  acquire(): void {
    if (this.dbPath === ':memory:') return;
    if (this.acquired) return; // idempotent — already held by this instance

    if (existsSync(this.lockPath)) {
      const raw = readFileSync(this.lockPath, 'utf-8').trim();
      const pid = parseInt(raw, 10);
      if (!isNaN(pid) && pid !== process.pid && this.isProcessAlive(pid)) {
        throw new Error(
          `[Daemon] Another HyperNeo daemon is already running with this database (PID ${pid}).\n` +
            `  Database: ${this.dbPath}\n` +
            `  Stop the existing process, or use --db-path to point to a different database.`
        );
      }
      // Stale lock — previous process crashed or was killed. Take it over.
      this.logger.warn(`[DatabaseLock] Removing stale lock from PID ${pid}`);
    }

    // Ensure directory exists before writing lock file
    const dir = dirname(this.lockPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(this.lockPath, String(process.pid), 'utf-8');
    this.acquired = true;

    // Register a synchronous process.on('exit') fallback so the lock file is
    // removed even when async signal handlers (SIGTERM, SIGHUP) don't fire —
    // e.g. when Bun kills the child process directly on Ctrl+C during `bun run`.
    // 'exit' is always synchronous and fires before the process terminates.
    const lockPath = this.lockPath;
    this.exitHandler = () => {
      try {
        unlinkSync(lockPath);
      } catch {
        // Ignore — file may already be gone
      }
    };
    process.on('exit', this.exitHandler);
  }

  /**
   * Release the lock. Called on graceful shutdown.
   * The OS reclaims the lock file on crash; the next startup treats it as stale.
   */
  release(): void {
    if (!this.acquired) return;

    // Deregister the exit-fallback handler so it doesn't attempt to remove a
    // lock file that we're about to delete (and won't exist after this call).
    if (this.exitHandler !== null) {
      process.removeListener('exit', this.exitHandler);
      this.exitHandler = null;
    }

    try {
      unlinkSync(this.lockPath);
    } catch {
      // Ignore — may have already been removed
    }
    this.acquired = false;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      // ESRCH = no such process (stale lock)
      return false;
    }
  }
}
