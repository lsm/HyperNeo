import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Logger } from '../lib/logger.ts';

const EMPTY_LOCK_GRACE_MS = 10_000;

export class DatabaseLock {
  private lockPath: string;
  private logger = new Logger('DatabaseLock');
  private acquired = false;
  private exitHandler: (() => void) | null = null;

  constructor(private dbPath: string) {
    this.lockPath = `${DatabaseLock.canonicalDbPath(dbPath)}.lock`;
  }

  private static canonicalDbPath(path: string): string {
    let current = path;
    const visited = new Set<string>([current]);
    for (;;) {
      try {
        return realpathSync(current);
      } catch {}
      try {
        const target = readlinkSync(current);
        current = resolve(dirname(current), target);
        if (visited.has(current)) return current;
        visited.add(current);
      } catch {
        try {
          return join(realpathSync(dirname(current)), basename(current));
        } catch {
          return current;
        }
      }
    }
  }

  acquire(): void {
    if (this.dbPath === ':memory:') return;
    if (this.acquired) return;

    const dir = dirname(this.lockPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      if (this.claimExclusivePath(`${this.lockPath}.${process.pid}.staging`, this.lockPath)) {
        if (existsSync(`${this.lockPath}.takeover`)) {
          rmSync(this.lockPath, { force: true });
          continue;
        }
        this.acquired = true;

        const lockPath = this.lockPath;
        this.exitHandler = () => {
          try {
            unlinkSync(lockPath);
          } catch {}
        };
        process.on('exit', this.exitHandler);
        return;
      }

      let raw = '';
      try {
        raw = readFileSync(this.lockPath, 'utf-8').trim();
      } catch {
        continue;
      }
      if (raw === '') {
        if (!this.isEmptyLockAbandoned()) continue;
        this.logger.warn('[DatabaseLock] Removing an abandoned empty lock');
      }
      const pid = Number.parseInt(raw, 10);
      if (!Number.isNaN(pid) && pid !== process.pid && this.isProcessAlive(pid)) {
        throw new Error(
          `[Daemon] Another HyperNeo daemon is already running with this database (PID ${pid}).\n` +
            `  Database: ${this.dbPath}\n` +
            `  Stop the existing process, or use --db-path to point to a different database.`
        );
      }

      if (!Number.isNaN(pid)) {
        this.logger.warn(`[DatabaseLock] Removing stale lock from PID ${pid}`);
      }
      if (existsSync(`${this.lockPath}.takeover`)) continue;
      if (
        !this.claimExclusivePath(
          `${this.lockPath}.${process.pid}.staging`,
          `${this.lockPath}.takeover`
        )
      ) {
        continue;
      }
      let becameOwner = false;
      try {
        let current = Number.NaN;
        try {
          current = Number.parseInt(readFileSync(this.lockPath, 'utf-8').trim(), 10);
        } catch {}
        if (!Number.isNaN(current) && current !== process.pid && this.isProcessAlive(current)) {
          continue;
        }
        try {
          unlinkSync(this.lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        becameOwner = this.claimExclusivePath(
          `${this.lockPath}.${process.pid}.staging`,
          this.lockPath
        );
      } finally {
        try {
          unlinkSync(`${this.lockPath}.takeover`);
        } catch {}
      }
      if (becameOwner) {
        this.acquired = true;

        const lockPath = this.lockPath;
        this.exitHandler = () => {
          try {
            unlinkSync(lockPath);
          } catch {}
        };
        process.on('exit', this.exitHandler);
        return;
      }
    }

    let raw = '';
    try {
      raw = readFileSync(this.lockPath, 'utf-8').trim();
    } catch {}
    const suffix = existsSync(`${this.lockPath}.takeover`)
      ? ` A takeover marker exists at ${this.lockPath}.takeover; if no other process is` +
        ` reclaiming the stale lock, verify and remove it, then retry.`
      : raw === ''
        ? ` ${this.lockPath} exists but is empty (likely an interrupted creation on a` +
          ` filesystem without hard links); verify no daemon is running and remove the` +
          ` file, then retry.`
        : '';
    throw new Error(
      `[Daemon] Failed to acquire the database lock at ${this.lockPath} after repeated attempts.` +
        suffix
    );
  }

  private isEmptyLockAbandoned(): boolean {
    try {
      return Date.now() - statSync(this.lockPath).mtimeMs >= EMPTY_LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }

  private static stagingNonce = 0;

  private claimExclusivePath(stagingPath: string, targetPath: string): boolean {
    const uniqueStaging = `${stagingPath}.${Date.now()}-${DatabaseLock.stagingNonce++}`;
    try {
      writeFileSync(uniqueStaging, String(process.pid), { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        rmSync(uniqueStaging, { force: true });
        return this.claimExclusivePath(stagingPath, targetPath);
      }
      throw error;
    }
    const staged = uniqueStaging;
    try {
      try {
        linkSync(staged, targetPath);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
            try {
              writeFileSync(targetPath, String(process.pid), { flag: 'wx' });
              return true;
            } catch (writeError) {
              if ((writeError as NodeJS.ErrnoException).code === 'EEXIST') return false;
              throw writeError;
            }
          }
          throw error;
        }
        return false;
      }
    } finally {
      rmSync(staged, { force: true });
    }
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
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}
