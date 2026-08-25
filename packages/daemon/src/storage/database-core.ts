import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Logger } from '../lib/logger.ts';
import { runMessageSearchMerge } from '../lib/message-search-merge.ts';
import { DatabaseLock } from './database-lock.ts';
import type { SQLiteQueryObservabilityOptions } from './sqlite-query-observability.ts';
import {
  configureMessageSearchFts,
  createTables,
  reclaimPendingMigrationSpace,
  runMigrations,
} from './schema/index.ts';
import { Database as BunDatabase } from './sqlite-compat.ts';

const MIGRATION_BACKUP_RETENTION = 3;
const MIGRATION_BACKUP_TEMP_STALE_MS = 60 * 60 * 1000;
const MAX_MESSAGE_SEARCH_MERGE_WORKER_FAILURES = 3;
const MESSAGE_SEARCH_MERGE_INTERVAL_MS = 30_000;

export interface DatabaseCoreOptions {
  queryObservability?: SQLiteQueryObservabilityOptions;
}

export class DatabaseCore {
  private db: BunDatabase;
  private logger = new Logger('Database');
  private lock: DatabaseLock;
  private messageSearchMergeTimer: Timer | null = null;
  private messageSearchMergeInFlight = false;
  private messageSearchMergeClosed = false;
  private messageSearchMergeCancel: (() => void) | null = null;
  private messageSearchMergeWorkerFailures = 0;
  private messageSearchMergeStarted = false;
  private messageSearchMergeIntervalMs = MESSAGE_SEARCH_MERGE_INTERVAL_MS;

  constructor(
    private dbPath: string,
    private readonly options: DatabaseCoreOptions = {}
  ) {
    this.db = null as unknown as BunDatabase;
    this.lock = new DatabaseLock(dbPath);
  }

  async initialize(): Promise<void> {
    if (this.db !== null) return;

    this.lock.acquire();

    try {
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      this.db = this.options.queryObservability
        ? new BunDatabase(this.dbPath, { queryObservability: this.options.queryObservability })
        : new BunDatabase(this.dbPath);

      this.db.exec('PRAGMA journal_mode = WAL');

      this.db.exec('PRAGMA busy_timeout = 5000');

      this.db.exec('PRAGMA synchronous = NORMAL');

      this.db.exec('PRAGMA foreign_keys = ON');

      const pendingSpaceReclaims = runMigrations(this.db, () => this.createBackup());
      const reclaim = reclaimPendingMigrationSpace(this.db, pendingSpaceReclaims);
      if (reclaim.kind === 'reclaimed') {
        this.logger.info(
          `[Database] Reclaimed space after ${reclaim.reclaimedMigrations} rewrite migrations` +
            ` (${reclaim.freelistBefore} free pages${reclaim.vacuumed ? '' : ', no vacuum needed'})`
        );
      } else if (reclaim.kind === 'deferred') {
        this.logger.warn(
          '[Database] Migration space reclaim blocked by an active WAL reader; retrying next startup'
        );
      }

      createTables(this.db);

      configureMessageSearchFts(this.db);
    } catch (error) {
      if (this.db !== null) {
        try {
          this.db.close();
        } catch {}
        this.db = null as unknown as BunDatabase;
      }
      this.lock.release();
      throw error;
    }
  }

  startMessageSearchMerges(): void {
    if (this.messageSearchMergeStarted || this.messageSearchMergeClosed) return;
    this.messageSearchMergeStarted = true;
    this.scheduleMessageSearchMerge();
  }

  private scheduleMessageSearchMerge(): void {
    if (this.messageSearchMergeClosed || this.messageSearchMergeInFlight) return;
    this.messageSearchMergeTimer = setTimeout(() => {
      this.messageSearchMergeTimer = null;
      this.messageSearchMergeInFlight = true;
      const merge = runMessageSearchMerge(this.dbPath);
      this.messageSearchMergeCancel = merge.cancel;
      void merge.promise.then((status) => {
        this.messageSearchMergeCancel = null;
        this.messageSearchMergeInFlight = false;
        if (status === 'worker-unavailable') {
          this.messageSearchMergeWorkerFailures++;
          if (this.messageSearchMergeWorkerFailures >= MAX_MESSAGE_SEARCH_MERGE_WORKER_FAILURES) {
            this.logger.error(
              'message_search_fts merge worker unavailable after repeated attempts; background merges stopped'
            );
            return;
          }
        } else {
          this.messageSearchMergeWorkerFailures = 0;
        }
        this.scheduleMessageSearchMerge();
      });
    }, this.messageSearchMergeIntervalMs);
  }

  getDb(): BunDatabase {
    return this.db;
  }

  getDbPath(): string {
    return this.dbPath;
  }

  close(): void {
    this.messageSearchMergeClosed = true;
    if (this.messageSearchMergeTimer) {
      clearTimeout(this.messageSearchMergeTimer);
      this.messageSearchMergeTimer = null;
    }
    this.messageSearchMergeCancel?.();
    this.messageSearchMergeCancel = null;
    try {
      this.db.exec('PRAGMA optimize');
    } catch {}
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {}
    this.db.close();
    this.lock.release();
  }

  private createBackup(): void {
    if (!existsSync(this.dbPath)) return;

    const dir = dirname(this.dbPath);
    const backupDir = join(dir, 'backups', basename(this.dbPath));

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

    this.cleanupOldBackups(backupDir, MIGRATION_BACKUP_RETENTION - 1);

    const startedAt = Date.now();
    const strategy = this.writeBackup(backupPath);
    if (strategy === null) return;

    this.logger.info(
      `[Database] Migration backup created via ${strategy} in ${Date.now() - startedAt}ms: ${backupPath}`
    );
    this.cleanupOldBackups(backupDir, MIGRATION_BACKUP_RETENTION);
  }

  private writeBackup(backupPath: string): string | null {
    const tempDb = `${backupPath}.tmp`;
    const strategy = this.writeBackupTo(tempDb);
    if (strategy === null) {
      this.removePartialBackup(tempDb);
      return null;
    }
    try {
      if (existsSync(`${tempDb}-wal`)) {
        renameSync(`${tempDb}-wal`, `${backupPath}-wal`);
      }
      renameSync(tempDb, backupPath);
      return strategy;
    } catch (err) {
      this.logger.error('Failed to publish migration backup:', err);
      this.removePartialBackup(tempDb);
      return null;
    }
  }

  private writeBackupTo(tempDb: string): string | null {
    if (this.tryFastCopy(tempDb)) {
      if (this.copyWalSidecar(tempDb)) {
        return 'fs-copy';
      }
      if (!this.removePartialBackup(tempDb)) {
        this.logger.error('Failed to create migration backup: partial artifacts remain');
        return null;
      }
    }
    if (this.tryVacuumInto(tempDb)) return 'vacuum-into';
    if (!this.removePartialBackup(tempDb)) {
      this.logger.error('Failed to create migration backup: partial artifacts remain');
      return null;
    }
    return this.tryCheckpointCopy(tempDb) ? 'checkpoint-copy' : null;
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

  private removePartialBackup(backupPath: string): boolean {
    try {
      rmSync(backupPath, { force: true });
      rmSync(`${backupPath}-wal`, { force: true });
      return !existsSync(backupPath) && !existsSync(`${backupPath}-wal`);
    } catch {
      return false;
    }
  }

  private tryVacuumInto(backupPath: string): boolean {
    if (!this.removePartialBackup(backupPath)) return false;
    try {
      this.db.prepare('VACUUM INTO ?').run(backupPath);
      return existsSync(backupPath) && !existsSync(`${backupPath}-wal`);
    } catch {
      return false;
    }
  }

  private tryCheckpointCopy(backupPath: string): boolean {
    let checkpointed = false;
    try {
      const result = this.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as
        | { busy?: number; log?: number; checkpointed?: number }
        | null
        | undefined;
      checkpointed = result?.busy === 0 && (result?.checkpointed ?? 0) >= (result?.log ?? 0);
    } catch {
      checkpointed = false;
    }
    try {
      copyFileSync(this.dbPath, backupPath);
    } catch (err) {
      this.logger.error('Failed to create migration backup:', err);
      this.removePartialBackup(backupPath);
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
      const staleCutoff = Date.now() - MIGRATION_BACKUP_TEMP_STALE_MS;

      for (const name of entries) {
        if (!name.endsWith('.tmp') && !name.endsWith('.tmp-wal')) continue;
        const path = join(backupDir, name);
        try {
          if (statSync(path).mtime.getTime() > staleCutoff) continue;
          unlinkSync(path);
        } catch {}
      }
      for (const file of databases.slice(keepCount)) {
        try {
          unlinkSync(file.path);
        } catch {}
      }
      for (const name of entries) {
        if (!name.endsWith('.db-wal')) continue;
        const base = name.slice(0, -'-wal'.length);
        if (kept.has(base) || existsSync(join(backupDir, base))) continue;
        const path = join(backupDir, name);
        try {
          if (statSync(path).mtime.getTime() > staleCutoff) continue;
          unlinkSync(path);
        } catch {}
      }
    } catch {}
  }
}
