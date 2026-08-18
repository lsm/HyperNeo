import { Database as BunDatabase } from './sqlite-compat';
import { dirname, join } from 'node:path';
import { mkdirSync, existsSync, copyFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { Logger } from '../lib/logger';
import { configureMessageSearchFts, createTables, runMigrations } from './schema';
import { DatabaseLock } from './database-lock';

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
      mkdirSync(backupDir, { recursive: true });
    }

    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // Ignore checkpoint errors
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(backupDir, `daemon-${timestamp}.db`);

    try {
      copyFileSync(this.dbPath, backupPath);
    } catch (err) {
      this.logger.error('Failed to create backup:', err);
      return;
    }

    this.cleanupOldBackups(backupDir, 3);
  }

  private cleanupOldBackups(backupDir: string, keepCount: number): void {
    try {
      const files = readdirSync(backupDir)
        .filter((f) => f.startsWith('daemon-') && f.endsWith('.db'))
        .map((f) => ({
          name: f,
          path: join(backupDir, f),
          mtime: statSync(join(backupDir, f)).mtime.getTime(),
        }))
        .sort((a, b) => b.mtime - a.mtime);

      for (const file of files.slice(keepCount)) {
        try {
          unlinkSync(file.path);
        } catch {
          // Ignore deletion errors
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}
