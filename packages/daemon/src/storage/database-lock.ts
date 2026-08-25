import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Logger } from '../lib/logger.ts';

export class DatabaseLock {
  private lockPath: string;
  private logger = new Logger('DatabaseLock');
  private acquired = false;
  private exitHandler: (() => void) | null = null;

  constructor(private dbPath: string) {
    this.lockPath = `${dbPath}.lock`;
  }

  acquire(): void {
    if (this.dbPath === ':memory:') return;
    if (this.acquired) return;

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
      this.logger.warn(`[DatabaseLock] Removing stale lock from PID ${pid}`);
    }

    const dir = dirname(this.lockPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(this.lockPath, String(process.pid), 'utf-8');
    this.acquired = true;

    const lockPath = this.lockPath;
    this.exitHandler = () => {
      try {
        unlinkSync(lockPath);
      } catch {}
    };
    process.on('exit', this.exitHandler);
  }

  release(): void {
    if (!this.acquired) return;

    if (this.exitHandler !== null) {
      process.removeListener('exit', this.exitHandler);
      this.exitHandler = null;
    }

    try {
      unlinkSync(this.lockPath);
    } catch {}
    this.acquired = false;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
