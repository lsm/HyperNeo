import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Logger } from '../lib/logger';
import { DatabaseLock } from './database-lock';
import { configureMessageSearchFts, createTables, runMigrations } from './schema';
import { Database as BunDatabase } from './sqlite-compat';

const MIGRATION_BACKUP_RETENTION = 3;

export class DatabaseCore {
  private db: BunDatabase;
  private logger = new Logger('Database');
  private lock: DatabaseLock;
  private messageSearchMergeTimer: Timer | null = null;

  constructor(private dbPath: string) {
    this.db = null as unknown as BunDatabase;
    this.lock = new DatabaseLock(dbPath);
  }

  async initialize(): Promise<void> {
    if (this.db !== null) return;

    this.lock.acquire();

    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new BunDatabase(this.dbPath);

    this.db.exec('PRAGMA journal_mode = WAL');

    this.db.exec('PRAGMA busy_timeout = 5000');

    this.db.exec('PRAGMA synchronous = NORMAL');

    this.db.exec('PRAGMA foreign_keys = ON');

    runMigrations(this.db, () => this.createBackup());

    createTables(this.db);

    configureMessageSearchFts(this.db);
    this.startMessageSearchMergeTimer();
  }

  private startMessageSearchMergeTimer(): void {
    if (this.messageSearchMergeTimer) return;
    this.messageSearchMergeTimer = setInterval(() => {
      try {
        this.db.exec(
          `INSERT INTO message_search_fts(message_search_fts, rank) VALUES('merge', 4096)`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/no such table/i.test(message)) {
          this.logger.warn('message_search_fts background merge failed:', err);
        }
      }
    }, 30_000);
  }

  getDb(): BunDatabase {
    return this.db;
  }

  getDbPath(): string {
    return this.dbPath;
  }

  close(): void {
    if (this.messageSearchMergeTimer) {
      clearInterval(this.messageSearchMergeTimer);
      this.messageSearchMergeTimer = null;
    }
    try {
      this.db.exec('PRAGMA optimize');
    } catch {}
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // Ignore checkpoint errors — the DB may already be closed or in an error state
    }
    this.db.close();
    this.lock.release();
  }

  private createBackup(): void {
    if (!existsSync(this.dbPath)) return;

    const dir = dirname(this.dbPath);
    const backupDir = join(dir, 'backups');

    if (!existsSync(backupDir)) {
      try {
        mkdirSync(backupDir, { recursive: true });
      } catch (err) {
        this.logger.error('Failed to create migration backup directory:', err);
        return;
      }
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(backupDir, `daemon-${timestamp}.db`);

    const startedAt = Date.now();
    const strategy = this.writeBackup(backupPath);
    if (strategy === null) return;

    this.logger.info(
      `[Database] Migration backup created via ${strategy} in ${Date.now() - startedAt}ms: ${backupPath}`
    );
    this.cleanupOldBackups(backupDir, MIGRATION_BACKUP_RETENTION);
  }

  private writeBackup(backupPath: string): string | null {
    if (this.tryFastCopy(backupPath)) {
      if (this.copyWalSidecar(backupPath)) {
        return 'fs-copy';
      }
      this.removePartialBackup(backupPath);
    }
    if (this.tryVacuumInto(backupPath)) return 'vacuum-into';
    return this.tryCheckpointCopy(backupPath) ? 'checkpoint-copy' : null;
  }

  private tryFastCopy(backupPath: string): boolean {
    if (typeof Bun === 'undefined') return false;
    try {
      copyFileSync(this.dbPath, backupPath);
      return true;
    } catch {
      return false;
    }
  }

  private removePartialBackup(backupPath: string): void {
    rmSync(backupPath, { force: true });
    rmSync(`${backupPath}-wal`, { force: true });
  }

  private tryVacuumInto(backupPath: string): boolean {
    try {
      this.removePartialBackup(backupPath);
      this.db.prepare('VACUUM INTO ?').run(backupPath);
      return existsSync(backupPath);
    } catch {
      return false;
    }
  }

  private tryCheckpointCopy(backupPath: string): boolean {
    let checkpointed = true;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      checkpointed = false;
    }
    try {
      copyFileSync(this.dbPath, backupPath);
    } catch (err) {
      this.logger.error('Failed to create migration backup:', err);
      return false;
    }
    if (!checkpointed && !this.copyWalSidecar(backupPath)) {
      this.logger.error('Failed to create migration backup: WAL sidecar copy failed');
      this.removePartialBackup(backupPath);
      return false;
    }
    return true;
  }

  private copyWalSidecar(backupPath: string): boolean {
    const walPath = `${this.dbPath}-wal`;
    try {
      if (!existsSync(walPath) || statSync(walPath).size === 0) return true;
      copyFileSync(walPath, `${backupPath}-wal`);
      return true;
    } catch (err) {
      this.logger.warn('Failed to copy WAL sidecar into migration backup:', err);
      return false;
    }
  }

  private cleanupOldBackups(backupDir: string, keepCount: number): void {
    try {
      const entries = readdirSync(backupDir).filter((f) => f.startsWith('daemon-'));
      const databases = entries
        .filter((f) => f.endsWith('.db'))
        .map((f) => ({
          name: f,
          path: join(backupDir, f),
          mtime: statSync(join(backupDir, f)).mtime.getTime(),
        }))
        .sort((a, b) => b.mtime - a.mtime);

      const kept = new Set(databases.slice(0, keepCount).map((f) => f.name));

      for (const file of databases.slice(keepCount)) {
        try {
          unlinkSync(file.path);
        } catch {}
      }
      for (const name of entries) {
        if (!name.endsWith('.db-wal') || kept.has(name.slice(0, -'-wal'.length))) continue;
        try {
          unlinkSync(join(backupDir, name));
        } catch {}
      }
    } catch {}
  }
}
