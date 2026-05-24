/**
 * Database Core - Core infrastructure for SQLite database.
 *
 * Responsibilities:
 * - Database initialization with WAL mode
 * - PRAGMA configuration
 * - Backup creation and cleanup
 * - Database path management
 * - Close operation
 */

import { Database as BunDatabase } from 'bun:sqlite';
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
    // Initialize as null until initialize() is called
    // This pattern is necessary because BunDatabase constructor is synchronous
    // but we want to allow async directory creation before opening the DB
    this.db = null as unknown as BunDatabase;
    this.lock = new DatabaseLock(dbPath);
  }

  async initialize(): Promise<void> {
    // Idempotent — safe to call twice on the same instance.
    if (this.db !== null) return;

    // Acquire exclusive lock before opening — prevents two daemon instances from
    // using the same database file simultaneously.
    this.lock.acquire();

    // Ensure directory exists
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Open database
    this.db = new BunDatabase(this.dbPath);

    // Enable WAL mode for better concurrency and crash recovery
    // WAL mode provides:
    // - Better performance for concurrent reads/writes
    // - Atomic commits (prevents partial writes)
    // - Better crash recovery (no data loss on unexpected shutdown)
    this.db.exec('PRAGMA journal_mode = WAL');

    // Wait briefly when the DB is locked by another connection/process instead of
    // failing writes immediately with SQLITE_BUSY.
    this.db.exec('PRAGMA busy_timeout = 5000');

    // Set synchronous mode to NORMAL for durability with good performance
    // NORMAL = fsync only at critical moments (WAL checkpoints)
    // This ensures durability while maintaining performance
    this.db.exec('PRAGMA synchronous = NORMAL');

    // Enable foreign key constraints (required for CASCADE deletes)
    this.db.exec('PRAGMA foreign_keys = ON');

    // Run migrations FIRST (with automatic backup) - this handles neo_* -> new tables
    // CRITICAL: Must run before createTables() to avoid data loss!
    // If createTables() runs first, it creates empty tables that cause
    // renameTableIfExists() to drop populated legacy tables.
    runMigrations(this.db, () => this.createBackup());

    // Create any missing tables (will be no-ops if migrations already created them)
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

  /**
   * Get the underlying Bun SQLite database instance
   * Used by repositories and background job queues that need direct DB access
   */
  getDb(): BunDatabase {
    return this.db;
  }

  /**
   * Get the database file path
   * Used by background job queues to create their own connections to the same DB file
   */
  getDbPath(): string {
    return this.dbPath;
  }

  /**
   * Close the database connection and release the lock file.
   *
   * Runs a WAL checkpoint before closing so all write-ahead log data is flushed
   * to the main database file. This prevents potential data loss on abrupt
   * termination where the WAL is replayed at next startup but uncommitted frames
   * were not yet checkpointed.
   */
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

  /**
   * Create a backup of the database before migrations
   * Keeps up to 3 most recent backups to prevent disk bloat
   */
  private createBackup(): void {
    if (!existsSync(this.dbPath)) return;

    const dir = dirname(this.dbPath);
    const backupDir = join(dir, 'backups');

    // Create backup directory if needed
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { recursive: true });
    }

    // Checkpoint WAL to ensure backup has all data
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // Ignore checkpoint errors
    }

    // Create timestamped backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(backupDir, `daemon-${timestamp}.db`);

    try {
      copyFileSync(this.dbPath, backupPath);
    } catch (err) {
      this.logger.error('Failed to create backup:', err);
      return;
    }

    // Cleanup old backups (keep only 3 most recent)
    this.cleanupOldBackups(backupDir, 3);
  }

  /**
   * Remove old backups, keeping only the N most recent
   */
  private cleanupOldBackups(backupDir: string, keepCount: number): void {
    try {
      const files = readdirSync(backupDir)
        .filter((f) => f.startsWith('daemon-') && f.endsWith('.db'))
        .map((f) => ({
          name: f,
          path: join(backupDir, f),
          mtime: statSync(join(backupDir, f)).mtime.getTime(),
        }))
        .sort((a, b) => b.mtime - a.mtime); // newest first

      // Delete old backups
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
