import { runLagPhase } from '../lib/event-loop-activity.ts';
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
import { unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Logger } from '../lib/logger.ts';
import {
  freeBytesAt,
  hasRoomForBackupCopy,
  shouldRotateStreamBackups,
  shouldStreamCopyBackup,
  streamCopyFile,
} from './backup-copy.ts';
import { awaitFileCloneSettle } from './clone-settle.ts';
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
import { assertSupportedDatabaseVersion } from './schema/upgrade-floor.ts';
import { backfillSdkMessageColumns } from './schema/m413-sdk-message-columns.ts';
import {
  selectSdkBodyWriteMode,
  startSdkBodyWriteAdmission,
} from './sdk-message-body-admission.ts';
import { migrateSdkMessageBodies } from './sdk-message-body-copy.ts';
import {
  reserveSdkBodyBackupPath,
  sdkBodyBackupChannel,
  SdkBodyCopyTerminalError,
} from './sdk-message-body-backup.ts';

const MIGRATION_BACKUP_RETENTION = 3;
const MIGRATION_BACKUP_TEMP_STALE_MS = 60 * 60 * 1000;
const MIGRATION_BACKUP_ROTATION_DELAY_MS = 2 * 60 * 1000;
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
  private bodyCopyAbort: AbortController | null = null;
  private bodyCopyRetry: ReturnType<typeof setTimeout> | null = null;
  private bodyCopyClosed = false;
  private bodyAdmissionCancel: (() => void) | null = null;

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

      assertSupportedDatabaseVersion(this.db);

      this.db.exec('PRAGMA journal_mode = WAL');

      this.db.exec('PRAGMA busy_timeout = 5000');

      this.db.exec('PRAGMA synchronous = NORMAL');

      this.db.exec('PRAGMA foreign_keys = ON');

      this.db.exec('PRAGMA cache_size = -524288');

      this.db.exec('PRAGMA temp_store = MEMORY');

      this.db.exec('PRAGMA mmap_size = 34359738368');

      const pendingSpaceReclaims = runMigrations(this.db, () => this.createBackup());
      const reclaim = reclaimPendingMigrationSpace(this.db, pendingSpaceReclaims);
      if (reclaim.kind === 'reclaimed') {
        this.logger.info(
          `[Database] Recorded ${reclaim.reclaimedMigrations} rewrite migration space reclaims` +
            ` (${reclaim.freelistBefore} free pages left for reuse; vacuum skipped)`
        );
      }

      this.db.exec('PRAGMA cache_size = 2000');

      this.db.exec('PRAGMA temp_store = 0');

      this.db.exec('PRAGMA mmap_size = 0');

      createTables(this.db);
      await backfillSdkMessageColumns(this.db, (progress) => this.logger.info(progress));

      const reportBodyMode = (mode: Awaited<ReturnType<typeof selectSdkBodyWriteMode>>) =>
        this.logger.warn(`SDK body startup mode selected: ${JSON.stringify(mode)}`);
      if (this.dbPath === ':memory:') reportBodyMode(await selectSdkBodyWriteMode(this.db));
      else
        this.bodyAdmissionCancel = startSdkBodyWriteAdmission(this.db, this.dbPath, reportBodyMode);

      configureMessageSearchFts(this.db);
    } catch (error) {
      this.bodyAdmissionCancel?.();
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
      const merge = runLagPhase('timer:search_merge_worker_start', () =>
        runMessageSearchMerge(this.dbPath)
      );
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

  startSdkMessageBodyCopy(): void {
    if (this.bodyCopyClosed || this.bodyCopyAbort || this.dbPath === ':memory:') return;
    if (typeof Worker === 'undefined') {
      this.logger.info('SDK body copy: {"phase":"refused","reason":"worker_unavailable"}');
      return;
    }
    const abort = (this.bodyCopyAbort = new AbortController());
    const attempt = async () => {
      if (this.bodyCopyClosed || abort.signal.aborted) return;
      const started = performance.now();
      let last = started,
        maxLagMs = 0;
      const heartbeat = setInterval(() => {
        const now = performance.now();
        maxLagMs = Math.max(maxLagMs, now - last - 10);
        last = now;
      }, 10);
      let channel: ReturnType<typeof sdkBodyBackupChannel> | undefined;
      let complete = false;
      let terminal = false;
      try {
        const dbBytes =
          statSync(this.dbPath).size +
          (existsSync(`${this.dbPath}-wal`) ? statSync(`${this.dbPath}-wal`).size : 0);
        const result = await migrateSdkMessageBodies(this.db, {
          dbBytes,
          freeBytes: freeBytesAt(dirname(this.dbPath)),
          signal: abort.signal,
          verifyBackup: async (mustExist, priorPath) => {
            const backupDir = join(dirname(this.dbPath), 'backups', 'sdk-message-bodies-v1');
            if (mustExist && (!priorPath || dirname(priorPath) !== backupDir))
              throw new SdkBodyCopyTerminalError(
                'SDK body copy original backup location is invalid',
                priorPath ?? '<unknown>'
              );
            const backupPath = mustExist
              ? priorPath!
              : await reserveSdkBodyBackupPath(this.db, this.dbPath, abort.signal);
            channel = sdkBodyBackupChannel(this.dbPath, backupPath, abort.signal);
            const verified = await channel.verify(mustExist);
            this.logger.info(
              `SDK body copy: ${JSON.stringify({ phase: 'backup_verified', ...verified })}`
            );
            return backupPath;
          },
          checkpoint: async () => {
            await channel?.checkpoint();
          },
          log: (progress) => this.logger.info(`SDK body copy: ${progress}`),
        });
        complete = result.status === 'complete';
        await new Promise((resolve) => setTimeout(resolve, 0));
        this.logger.info(
          `SDK body copy: ${JSON.stringify({ phase: 'run_finished', status: result.status, elapsedMs: performance.now() - started, maxLagMs })}`
        );
      } catch (error) {
        if (error instanceof SdkBodyCopyTerminalError) {
          terminal = true;
          if (!abort.signal.aborted)
            this.logger.error(
              `SDK body copy stopped; requires operator action; backup=${error.backupPath}`,
              error
            );
        } else if (!abort.signal.aborted)
          this.logger.warn('SDK body copy deferred; no unverified changes permitted', error);
      } finally {
        clearInterval(heartbeat);
        channel?.close();
      }
      if (!complete && !terminal && !this.bodyCopyClosed && !abort.signal.aborted)
        this.bodyCopyRetry = setTimeout(() => {
          void attempt();
        }, 60_000);
    };
    this.bodyCopyRetry = setTimeout(() => {
      void attempt();
    }, 0);
  }

  getDbPath(): string {
    return this.dbPath;
  }

  close(): void {
    this.bodyAdmissionCancel?.();
    this.bodyCopyClosed = true;
    this.bodyCopyAbort?.abort();
    if (this.bodyCopyRetry) clearTimeout(this.bodyCopyRetry);
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

    void this.rotateBackupsInBackground(backupDir, MIGRATION_BACKUP_RETENTION);
    const startedAt = Date.now();
    const strategy = this.writeBackup(backupPath, () =>
      this.cleanupOldBackups(backupDir, MIGRATION_BACKUP_RETENTION - 1)
    );
    if (strategy === null) return;

    this.logger.info(
      `[Database] Migration backup created via ${strategy} in ${Date.now() - startedAt}ms: ${backupPath}`
    );
    if (strategy === 'stream-copy') {
      void this.rotateStreamBackupsInBackground(backupDir, backupPath);
      return;
    }
    if (strategy !== 'fs-copy') {
      this.cleanupOldBackups(backupDir, MIGRATION_BACKUP_RETENTION);
      return;
    }
    this.awaitBackupCloneSettle();
    const rotation = setTimeout(() => {
      void this.rotateBackupsInBackground(backupDir, MIGRATION_BACKUP_RETENTION, backupPath);
    }, MIGRATION_BACKUP_ROTATION_DELAY_MS);
    rotation.unref?.();
  }

  private awaitBackupCloneSettle(): void {
    try {
      const result = awaitFileCloneSettle(this.dbPath);
      if (!result) return;
      this.logger.info(
        `[Database] Migration backup clone ${result.verdict} after ${result.waitedMs}ms (longest read ${result.longestReadMs}ms)`
      );
    } catch (err) {
      this.logger.warn('Failed to wait for migration backup clone to settle:', err);
    }
  }

  private writeBackup(backupPath: string, freeRoom: () => void): string | null {
    const tempDb = `${backupPath}.tmp`;
    const strategy = this.writeBackupTo(tempDb, freeRoom);
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

  private writeBackupTo(tempDb: string, freeRoom: () => void): string | null {
    if (shouldStreamCopyBackup(process.platform, statSync(this.dbPath).size)) {
      if (this.tryStreamCopy(tempDb)) return 'stream-copy';
      if (!this.removePartialBackup(tempDb)) {
        this.logger.error('Failed to create migration backup: partial artifacts remain');
        return null;
      }
    }
    if (this.tryFastCopy(tempDb)) {
      if (this.copyWalSidecar(tempDb)) {
        return 'fs-copy';
      }
      if (!this.removePartialBackup(tempDb)) {
        this.logger.error('Failed to create migration backup: partial artifacts remain');
        return null;
      }
    }
    freeRoom();
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
    for (const path of this.backupsBeyondRetention(backupDir, keepCount)) {
      try {
        unlinkSync(path);
      } catch {}
    }
    this.sweepOrphanBackupWals(backupDir);
  }

  private tryStreamCopy(tempDb: string): boolean {
    const backupDir = dirname(tempDb);
    let checkpointed = false;
    try {
      const result = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
        | { busy?: number; log?: number; checkpointed?: number }
        | null
        | undefined;
      checkpointed = result?.busy === 0 && (result?.checkpointed ?? 0) >= (result?.log ?? 0);
    } catch {
      checkpointed = false;
    }
    const walPath = `${this.dbPath}-wal`;
    const copyBytes =
      statSync(this.dbPath).size +
      (!checkpointed && existsSync(walPath) ? statSync(walPath).size : 0);
    try {
      const oldestFirst = this.backupsBeyondRetention(
        backupDir,
        MIGRATION_BACKUP_RETENTION - 1
      ).reverse();
      while (!hasRoomForBackupCopy(freeBytesAt(backupDir), copyBytes) && oldestFirst.length > 0) {
        try {
          unlinkSync(oldestFirst.shift() as string);
        } catch {}
      }
      if (!hasRoomForBackupCopy(freeBytesAt(backupDir), copyBytes)) {
        this.logger.warn('Not enough free space for a migration backup copy; falling back');
        return false;
      }
    } catch (err) {
      this.logger.error('Failed to make room for migration backup:', err);
      return false;
    }
    try {
      streamCopyFile(this.dbPath, tempDb);
    } catch (err) {
      this.logger.error('Failed to create migration backup:', err);
      return false;
    }
    if (!checkpointed && !this.copyWalSidecar(tempDb)) {
      this.logger.error('Failed to create migration backup: WAL sidecar copy failed');
      return false;
    }
    return true;
  }

  private async rotateStreamBackupsInBackground(backupDir: string, pinned: string): Promise<void> {
    try {
      const dbBytes = statSync(this.dbPath).size;
      const newestFirst = this.backupsBeyondRetention(backupDir, 0, pinned);
      while (
        shouldRotateStreamBackups({
          backupCount: newestFirst.length,
          freeBytes: freeBytesAt(backupDir),
          dbBytes,
        })
      ) {
        try {
          await unlink(newestFirst.pop() as string);
        } catch {}
      }
    } catch (err) {
      this.logger.warn('Failed to rotate migration backups:', err);
    }
    this.sweepOrphanBackupWals(backupDir);
  }

  private async rotateBackupsInBackground(
    backupDir: string,
    keepCount: number,
    pinned?: string
  ): Promise<void> {
    for (const path of this.backupsBeyondRetention(backupDir, keepCount, pinned)) {
      try {
        await unlink(path);
      } catch {}
    }
    this.sweepOrphanBackupWals(backupDir);
  }

  private backupsBeyondRetention(backupDir: string, keepCount: number, pinned?: string): string[] {
    try {
      const entries = readdirSync(backupDir).filter((f) => f.startsWith('daemon-'));
      const staleCutoff = Date.now() - MIGRATION_BACKUP_TEMP_STALE_MS;
      for (const name of entries) {
        if (!name.endsWith('.tmp') && !name.endsWith('.tmp-wal')) continue;
        const path = join(backupDir, name);
        try {
          if (statSync(path).mtime.getTime() > staleCutoff) continue;
          unlinkSync(path);
        } catch {}
      }
      const ranked = entries
        .filter((f) => f.endsWith('.db'))
        .flatMap((f) => {
          const path = join(backupDir, f);
          try {
            return [{ path, mtime: statSync(path).mtime.getTime() }];
          } catch {
            return [];
          }
        })
        .sort((a, b) => b.mtime - a.mtime)
        .map((f) => f.path);
      const ordered =
        pinned && ranked.includes(pinned)
          ? [pinned, ...ranked.filter((path) => path !== pinned)]
          : ranked;
      return ordered.slice(keepCount);
    } catch {
      return [];
    }
  }

  private sweepOrphanBackupWals(backupDir: string): void {
    try {
      const staleCutoff = Date.now() - MIGRATION_BACKUP_TEMP_STALE_MS;
      for (const name of readdirSync(backupDir)) {
        if (!name.startsWith('daemon-') || !name.endsWith('.db-wal')) continue;
        const base = name.slice(0, -'-wal'.length);
        if (existsSync(join(backupDir, base))) continue;
        const path = join(backupDir, name);
        try {
          if (statSync(path).mtime.getTime() > staleCutoff) continue;
          unlinkSync(path);
        } catch {}
      }
    } catch {}
  }
}
