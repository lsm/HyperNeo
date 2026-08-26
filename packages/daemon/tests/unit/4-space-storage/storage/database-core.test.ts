import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLogger, LogLevel, subscribeToStructuredLogs } from '../../../../src/lib/logger';
import { DatabaseCore } from '../../../../src/storage/database-core';
import { Database as RawDatabase } from '../../../../src/storage/sqlite-compat';

describe('DatabaseCore', () => {
  let testDir: string;
  let dbPath: string;
  let dbCore: DatabaseCore;

  beforeEach(() => {
    testDir = join(tmpdir(), `db-core-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    try {
      if (dbCore) {
        try {
          dbCore.close();
        } catch {}
      }
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe('constructor', () => {
    it('should create DatabaseCore with dbPath', () => {
      dbCore = new DatabaseCore(dbPath);
      expect(dbCore.getDbPath()).toBe(dbPath);
    });

    it('should not open database until initialize() is called', () => {
      dbCore = new DatabaseCore(dbPath);
      expect(existsSync(dbPath)).toBe(false);
    });
  });

  describe('initialize', () => {
    it('should create database file', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      expect(existsSync(dbPath)).toBe(true);
    });

    it('should create parent directory if needed', async () => {
      const nestedPath = join(testDir, 'nested', 'deep', 'test.db');
      dbCore = new DatabaseCore(nestedPath);
      await dbCore.initialize();

      expect(existsSync(nestedPath)).toBe(true);
    });

    it('should enable WAL mode', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();
      const result = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(result.journal_mode.toLowerCase()).toBe('wal');
    });

    it('should set synchronous mode to NORMAL', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();
      const result = db.prepare('PRAGMA synchronous').get() as { synchronous: number };
      expect(result.synchronous).toBe(1);
    });

    it('should set busy timeout to reduce SQLITE_BUSY write failures', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();
      const result = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      expect(result.timeout).toBe(5000);
    });

    it('should enable foreign key constraints', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();
      const result = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(result.foreign_keys).toBe(1);
    });

    it('should raise cache, temp store, and mmap limits while migrations run', async () => {
      dbCore = new DatabaseCore(dbPath);
      const internals = dbCore as unknown as Record<string, unknown>;
      const originalCreateBackup = internals.createBackup as () => void;
      const windowPragmas: Record<string, number> = {};
      internals.createBackup = () => {
        const db = dbCore.getDb();
        const readPragma = (name: string): number =>
          (db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[name];
        windowPragmas.cacheSize = readPragma('cache_size');
        windowPragmas.tempStore = readPragma('temp_store');
        windowPragmas.mmapSize = readPragma('mmap_size');
        return originalCreateBackup.call(dbCore);
      };

      await dbCore.initialize();

      expect(windowPragmas.cacheSize).toBe(-524288);
      expect(windowPragmas.tempStore).toBe(2);
      expect(windowPragmas.mmapSize).toBeGreaterThanOrEqual(1073741824);
    });

    it('should restore bounded runtime cache, temp store, and mmap defaults after migrations', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();
      expect(db.prepare('PRAGMA cache_size').get()).toEqual({ cache_size: 2000 });
      expect(db.prepare('PRAGMA temp_store').get()).toEqual({ temp_store: 0 });
      expect(db.prepare('PRAGMA mmap_size').get()).toEqual({ mmap_size: 0 });
    });

    it('should create database tables', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
        .all();
      expect(tables.length).toBe(1);
    });

    it('should be idempotent (safe to call twice)', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      await dbCore.initialize();
    });

    it('should release the lock when initialization fails', async () => {
      writeFileSync(dbPath, 'not a sqlite database');
      dbCore = new DatabaseCore(dbPath);

      await expect(dbCore.initialize()).rejects.toThrow();
      expect(existsSync(dbPath + '.lock')).toBe(false);
    });
  });

  describe('getDb', () => {
    it('should return the underlying Bun SQLite database', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();
      expect(db).toBeDefined();

      const result = db.prepare('SELECT 1 as value').get() as { value: number };
      expect(result.value).toBe(1);
    });
  });

  describe('getDbPath', () => {
    it('should return the database file path', () => {
      dbCore = new DatabaseCore(dbPath);
      expect(dbCore.getDbPath()).toBe(dbPath);
    });

    it('should work with in-memory database path', () => {
      dbCore = new DatabaseCore(':memory:');
      expect(dbCore.getDbPath()).toBe(':memory:');
    });
  });

  describe('close', () => {
    it('should close the database connection', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();
      expect(db).toBeDefined();

      dbCore.close();

      expect(() => db.prepare('SELECT 1').get()).toThrow();
    });

    it('should checkpoint the WAL before closing (WAL file is empty or absent after close)', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();
      db.exec(`
				INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
				VALUES ('wal-close-test', 'WAL Close Test', '/test', datetime('now'), datetime('now'), 'active', '{}', '{}')
			`);

      dbCore.close();
      dbCore = null as unknown as typeof dbCore;

      const walPath = dbPath + '-wal';
      if (existsSync(walPath)) {
        const { size } = statSync(walPath);
        expect(size).toBe(0);
      }
      expect(existsSync(dbPath + '.lock')).toBe(false);
    });

    it('should release the lock file on close', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      expect(existsSync(dbPath + '.lock')).toBe(true);

      dbCore.close();
      dbCore = null as unknown as typeof dbCore;

      expect(existsSync(dbPath + '.lock')).toBe(false);
    });

    it('should run PRAGMA optimize before the final WAL checkpoint', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();
      const originalExec = db.exec.bind(db);
      const executed: string[] = [];
      db.exec = (sql: string) => {
        executed.push(sql);
        return originalExec(sql);
      };

      dbCore.close();
      dbCore = null as unknown as typeof dbCore;

      const optimizeIndex = executed.indexOf('PRAGMA optimize');
      const checkpointIndex = executed.indexOf('PRAGMA wal_checkpoint(TRUNCATE)');
      expect(optimizeIndex).toBeGreaterThanOrEqual(0);
      expect(checkpointIndex).toBeGreaterThan(optimizeIndex);
    });
  });

  describe('backup creation', () => {
    it('should create backup directory during initialization with existing db', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();
      db.exec(`
				INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
				VALUES ('test-id', 'Test Session', '/test', datetime('now'), datetime('now'), 'active', '{}', '{}')
			`);

      dbCore.close();

      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const backupDir = join(testDir, 'backups', 'test.db');
      expect(existsSync(backupDir)).toBe(true);
    });

    it('should keep only 3 most recent backups', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();
      db.exec(`
				INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
				VALUES ('test-id', 'Test Session', '/test', datetime('now'), datetime('now'), 'active', '{}', '{}')
			`);
      dbCore.close();

      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        dbCore = new DatabaseCore(dbPath);
        await dbCore.initialize();
        dbCore.close();
      }

      const backupDir = join(testDir, 'backups', 'test.db');
      if (existsSync(backupDir)) {
        const backups = readdirSync(backupDir).filter(
          (f) => f.startsWith('daemon-') && f.endsWith('.db')
        );
        expect(backups.length).toBeLessThanOrEqual(3);
      }
    });
  });

  describe('pre-migration backups', () => {
    const envKey = 'HYPERNEO_DB_MIGRATION_BACKUP_MAX_BYTES';
    let previousValue: string | undefined;

    beforeEach(() => {
      previousValue = process.env[envKey];
    });

    afterEach(() => {
      if (previousValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = previousValue;
      }
    });

    const listBackups = (): string[] => {
      const backupDir = join(testDir, 'backups', 'test.db');
      return existsSync(backupDir)
        ? readdirSync(backupDir).filter((f) => f.startsWith('daemon-') && f.endsWith('.db'))
        : [];
    };

    const seedWalData = (db: RawDatabase): void => {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('CREATE TABLE backup_probe (id INTEGER PRIMARY KEY, value TEXT)');
      db.exec("INSERT INTO backup_probe (value) VALUES ('pre-migration')");
    };

    it('should create a backup before pending migrations even with the legacy size bound set to skip', async () => {
      process.env[envKey] = '1';

      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      expect(listBackups()).toHaveLength(1);
    });

    it('should not create a backup when no migrations are pending', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();
      dbCore.close();

      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();
      dbCore.close();

      expect(listBackups()).toHaveLength(1);
    });

    it('should create a valid backup that includes data committed to the WAL', async () => {
      const raw = new RawDatabase(dbPath);
      seedWalData(raw);

      configureLogger({ level: LogLevel.INFO });
      const strategies: string[] = [];
      const unsubscribe = subscribeToStructuredLogs((event) => {
        const match = /Migration backup created via (\S+)/.exec(event.message);
        if (match) strategies.push(match[1]);
      });

      try {
        dbCore = new DatabaseCore(dbPath);
        await dbCore.initialize();
      } finally {
        unsubscribe();
        configureLogger({ level: LogLevel.SILENT });
        raw.close();
      }

      const backups = listBackups();
      expect(backups).toHaveLength(1);
      expect(strategies).toHaveLength(1);
      const backupPath = join(testDir, 'backups', 'test.db', backups[0]);
      if (typeof Bun === 'undefined') {
        expect(strategies[0]).toBe('vacuum-into');
      } else {
        expect(strategies[0]).toBe('fs-copy');
        expect(statSync(`${backupPath}-wal`).size).toBeGreaterThan(0);
      }

      const backup = new RawDatabase(backupPath);
      try {
        expect(backup.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        expect(backup.prepare('SELECT value FROM backup_probe').all()).toEqual([
          { value: 'pre-migration' },
        ]);
        expect(
          backup
            .prepare(`SELECT COUNT(*) as count FROM migration_markers WHERE key = 'migration_001'`)
            .get()
        ).toEqual({ count: 0 });
      } finally {
        backup.close();
      }
    });

    it('should fall back to checkpoint and copy when faster backup strategies fail', async () => {
      const raw = new RawDatabase(dbPath);
      seedWalData(raw);

      configureLogger({ level: LogLevel.INFO });
      const strategies: string[] = [];
      const unsubscribe = subscribeToStructuredLogs((event) => {
        const match = /Migration backup created via (\S+)/.exec(event.message);
        if (match) strategies.push(match[1]);
      });

      try {
        dbCore = new DatabaseCore(dbPath);
        const internals = dbCore as unknown as Record<string, unknown>;
        internals.tryFastCopy = () => false;
        internals.tryVacuumInto = () => false;
        await dbCore.initialize();
      } finally {
        unsubscribe();
        configureLogger({ level: LogLevel.SILENT });
        raw.close();
      }

      const backups = listBackups();
      expect(backups).toHaveLength(1);
      expect(strategies).toEqual(['checkpoint-copy']);
      expect(existsSync(join(testDir, 'backups', 'test.db', `${backups[0]}-wal`))).toBe(false);

      const backup = new RawDatabase(join(testDir, 'backups', 'test.db', backups[0]));
      try {
        expect(backup.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        expect(backup.prepare('SELECT value FROM backup_probe').all()).toEqual([
          { value: 'pre-migration' },
        ]);
      } finally {
        backup.close();
      }
    });

    it('should copy the WAL sidecar when the checkpoint is capped by a concurrent reader', async () => {
      const raw = new RawDatabase(dbPath);
      seedWalData(raw);
      raw.exec('BEGIN');
      raw.prepare('SELECT COUNT(*) as c FROM backup_probe').get();

      configureLogger({ level: LogLevel.INFO });
      const strategies: string[] = [];
      const unsubscribe = subscribeToStructuredLogs((event) => {
        const match = /Migration backup created via (\S+)/.exec(event.message);
        if (match) strategies.push(match[1]);
      });

      try {
        dbCore = new DatabaseCore(dbPath);
        const internals = dbCore as unknown as Record<string, unknown>;
        internals.tryFastCopy = () => false;
        internals.tryVacuumInto = () => false;
        await dbCore.initialize();
      } finally {
        unsubscribe();
        configureLogger({ level: LogLevel.SILENT });
        raw.exec('ROLLBACK');
        raw.close();
      }

      dbCore.close();
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const backups = listBackups();
      expect(backups).toHaveLength(1);
      expect(strategies).toEqual(['checkpoint-copy']);
      expect(
        statSync(join(testDir, 'backups', 'test.db', `${backups[0]}-wal`)).size
      ).toBeGreaterThan(0);

      const backup = new RawDatabase(join(testDir, 'backups', 'test.db', backups[0]));
      try {
        expect(backup.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        expect(backup.prepare('SELECT value FROM backup_probe').all()).toEqual([
          { value: 'pre-migration' },
        ]);
      } finally {
        backup.close();
      }
    }, 15000);

    it('should fall back to a self-contained snapshot when the WAL sidecar copy fails', async () => {
      const raw = new RawDatabase(dbPath);
      seedWalData(raw);

      configureLogger({ level: LogLevel.INFO });
      const strategies: string[] = [];
      const unsubscribe = subscribeToStructuredLogs((event) => {
        const match = /Migration backup created via (\S+)/.exec(event.message);
        if (match) strategies.push(match[1]);
      });

      try {
        dbCore = new DatabaseCore(dbPath);
        const internals = dbCore as unknown as Record<string, unknown>;
        internals.tryFastCopy = (backupPath: string) => {
          copyFileSync(dbPath, backupPath);
          return true;
        };
        internals.copyWalSidecar = () => false;
        await dbCore.initialize();
      } finally {
        unsubscribe();
        configureLogger({ level: LogLevel.SILENT });
        raw.close();
      }

      const backups = listBackups();
      expect(backups).toHaveLength(1);
      expect(strategies).toEqual(['vacuum-into']);
      expect(existsSync(join(testDir, 'backups', 'test.db', `${backups[0]}-wal`))).toBe(false);

      const backup = new RawDatabase(join(testDir, 'backups', 'test.db', backups[0]));
      try {
        expect(backup.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        expect(backup.prepare('SELECT value FROM backup_probe').all()).toEqual([
          { value: 'pre-migration' },
        ]);
      } finally {
        backup.close();
      }
    });

    it('should fail closed when partial backup artifacts cannot be removed', async () => {
      const raw = new RawDatabase(dbPath);
      seedWalData(raw);

      configureLogger({ level: LogLevel.INFO });
      const strategies: string[] = [];
      const errors: string[] = [];
      const unsubscribe = subscribeToStructuredLogs((event) => {
        const match = /Migration backup created via (\S+)/.exec(event.message);
        if (match) strategies.push(match[1]);
        if (event.level === 'error') errors.push(event.message);
      });

      try {
        dbCore = new DatabaseCore(dbPath);
        const internals = dbCore as unknown as Record<string, unknown>;
        internals.tryFastCopy = (backupPath: string) => {
          copyFileSync(dbPath, backupPath);
          writeFileSync(`${backupPath}-wal`, 'stale sidecar');
          return true;
        };
        internals.copyWalSidecar = () => false;
        internals.removePartialBackup = (backupPath: string) => {
          rmSync(backupPath, { force: true });
          return false;
        };
        await dbCore.initialize();
      } finally {
        unsubscribe();
        configureLogger({ level: LogLevel.SILENT });
        raw.close();
      }

      expect(strategies).toHaveLength(0);
      expect(listBackups()).toHaveLength(0);
      expect(errors).toHaveLength(1);
    });

    it('should complete initialization without a backup when the backup directory is unusable', async () => {
      mkdirSync(join(testDir, 'backups'), { recursive: true });
      const backupDir = join(testDir, 'backups', 'test.db');
      writeFileSync(backupDir, 'not a directory');

      configureLogger({ level: LogLevel.INFO });
      const errors: string[] = [];
      const unsubscribe = subscribeToStructuredLogs((event) => {
        if (event.level === 'error') errors.push(event.message);
      });

      try {
        dbCore = new DatabaseCore(dbPath);
        await dbCore.initialize();
      } finally {
        unsubscribe();
        configureLogger({ level: LogLevel.SILENT });
      }

      let backups: string[] = [];
      try {
        backups = readdirSync(backupDir).filter((f) => f.startsWith('daemon-'));
      } catch {}
      expect(backups).toHaveLength(0);
      expect(errors).toHaveLength(1);
    });

    it('should free room for a new backup before writing it', async () => {
      const backupDir = join(testDir, 'backups', 'test.db');
      mkdirSync(backupDir, { recursive: true });
      const now = Date.now() / 1000;
      for (let i = 0; i < 3; i++) {
        const stale = join(backupDir, `daemon-2026-02-0${i + 1}T00-00-00-000Z.db`);
        writeFileSync(stale, 'stale');
        utimesSync(stale, now - (4 - i) * 60, now - (4 - i) * 60);
      }

      let listingAtWrite: string[] = [];
      dbCore = new DatabaseCore(dbPath);
      const internals = dbCore as unknown as Record<string, unknown>;
      const originalWriteBackup = internals.writeBackup as (path: string) => string | null;
      internals.writeBackup = (backupPath: string) => {
        listingAtWrite = readdirSync(backupDir)
          .filter((f) => f.endsWith('.db'))
          .sort();
        return originalWriteBackup.call(dbCore, backupPath);
      };

      await dbCore.initialize();

      expect(listingAtWrite).toEqual([
        'daemon-2026-02-02T00-00-00-000Z.db',
        'daemon-2026-02-03T00-00-00-000Z.db',
      ]);
      const remaining = readdirSync(backupDir).filter((f) => f.endsWith('.db'));
      expect(remaining).toHaveLength(3);
      expect(remaining).toContain('daemon-2026-02-03T00-00-00-000Z.db');
    });

    it('should publish backups via temporary names and sweep crashed leftovers', async () => {
      const backupDir = join(testDir, 'backups', 'test.db');
      mkdirSync(backupDir, { recursive: true });
      const crashed = join(backupDir, 'daemon-2026-03-01T00-00-00-000Z.db.tmp');
      const crashedWal = join(backupDir, 'daemon-2026-03-01T00-00-00-000Z.db.tmp-wal');
      writeFileSync(crashed, 'crashed partial');
      writeFileSync(crashedWal, 'crashed partial wal');
      const stale = Date.now() / 1000 - 7200;
      utimesSync(crashed, stale, stale);
      utimesSync(crashedWal, stale, stale);

      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const remaining = readdirSync(backupDir);
      expect(remaining.some((f) => f.endsWith('.tmp') || f.endsWith('.tmp-wal'))).toBe(false);
      expect(remaining.filter((f) => f.endsWith('.db'))).toHaveLength(1);
    });

    it('should not sweep temporary artifacts from concurrent in-progress backups', async () => {
      const backupDir = join(testDir, 'backups', 'test.db');
      mkdirSync(backupDir, { recursive: true });
      const inProgress = join(backupDir, 'daemon-2026-04-01T00-00-00-000Z.db.tmp');
      const stale = join(backupDir, 'daemon-2026-04-02T00-00-00-000Z.db.tmp-wal');
      writeFileSync(inProgress, 'being written by another daemon');
      writeFileSync(stale, 'abandoned long ago');
      const now = Date.now() / 1000;
      utimesSync(inProgress, now, now);
      utimesSync(stale, now - 7200, now - 7200);

      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      expect(existsSync(inProgress)).toBe(true);
      expect(existsSync(stale)).toBe(false);
    });

    it('should scope retention to the source database when databases share a directory', async () => {
      const backupDir = join(testDir, 'backups', 'test.db');
      mkdirSync(backupDir, { recursive: true });
      const now = Date.now() / 1000;
      for (let i = 0; i < 3; i++) {
        const stale = join(backupDir, `daemon-2026-05-0${i + 1}T00-00-00-000Z.db`);
        writeFileSync(stale, 'owned by the first database');
        utimesSync(stale, now - (4 - i) * 60, now - (4 - i) * 60);
      }

      dbCore = new DatabaseCore(join(testDir, 'other.db'));
      await dbCore.initialize();
      dbCore.close();

      const firstDbBackups = readdirSync(backupDir).filter((f) => f.endsWith('.db'));
      expect(firstDbBackups).toHaveLength(3);
      const otherDbBackups = readdirSync(join(testDir, 'backups', 'other.db')).filter((f) =>
        f.endsWith('.db')
      );
      expect(otherDbBackups).toHaveLength(1);
    });

    it('should prune expired backups together with their WAL sidecars', async () => {
      const backupDir = join(testDir, 'backups', 'test.db');
      mkdirSync(backupDir, { recursive: true });
      const now = Date.now() / 1000;
      const staleWalOwner = 'daemon-2026-01-01T00-00-00-000Z.db';
      const orphanWal = 'daemon-2025-12-31T00-00-00-000Z.db-wal';
      const undeletable = 'daemon-2025-06-01T00-00-00-000Z.db';
      for (let i = 0; i < 4; i++) {
        const stale = join(backupDir, `daemon-2026-01-0${i + 1}T00-00-00-000Z.db`);
        writeFileSync(stale, 'stale');
        if (i === 0) {
          writeFileSync(`${stale}-wal`, 'stale-wal');
          utimesSync(`${stale}-wal`, now - 7200, now - 7200);
        }
        utimesSync(stale, now - (5 - i) * 60, now - (5 - i) * 60);
      }
      writeFileSync(join(backupDir, orphanWal), 'orphan-wal');
      utimesSync(join(backupDir, orphanWal), now - 7200, now - 7200);
      const freshOrphanWal = 'daemon-2025-12-30T00-00-00-000Z.db-wal';
      writeFileSync(join(backupDir, freshOrphanWal), 'sidecar mid-publish elsewhere');
      mkdirSync(join(backupDir, undeletable));
      writeFileSync(join(backupDir, undeletable, 'filler'), 'blocks unlink');
      writeFileSync(join(backupDir, `${undeletable}-wal`), 'must survive with its database');
      utimesSync(join(backupDir, undeletable), now - 270, now - 270);

      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const remainingDbs = readdirSync(backupDir).filter(
        (f) => f.endsWith('.db') && f.startsWith('daemon-')
      );
      expect(remainingDbs).toHaveLength(4);
      expect(remainingDbs).toContain(undeletable);
      expect(remainingDbs).not.toContain(staleWalOwner);
      expect(existsSync(join(backupDir, `${staleWalOwner}-wal`))).toBe(false);
      expect(existsSync(join(backupDir, orphanWal))).toBe(false);
      expect(existsSync(join(backupDir, freshOrphanWal))).toBe(true);
      expect(existsSync(join(backupDir, `${undeletable}-wal`))).toBe(true);
    });
  });

  describe('in-memory database', () => {
    it('should work with in-memory database', async () => {
      dbCore = new DatabaseCore(':memory:');
      await dbCore.initialize();

      const db = dbCore.getDb();
      expect(db).toBeDefined();

      const result = db.prepare('SELECT 1 as value').get() as { value: number };
      expect(result.value).toBe(1);
    });

    it('should create tables in memory', async () => {
      dbCore = new DatabaseCore(':memory:');
      await dbCore.initialize();

      const db = dbCore.getDb();

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
        .all();
      expect(tables.length).toBe(1);
    });
  });

  describe('error handling', () => {
    it('should handle invalid path gracefully', async () => {
      const tmpBase = (process.env.TMPDIR || '/tmp').replace(/\/$/, '');
      const invalidPath = `${tmpBase}/test-db-core-invalid`;
      rmSync(invalidPath, { recursive: true, force: true });
      dbCore = new DatabaseCore(`${invalidPath}/test.db`);
      await dbCore.initialize();
    });
  });

  describe('database operations', () => {
    beforeEach(async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();
    });

    it('should allow inserting and querying data', async () => {
      const db = dbCore.getDb();

      db.exec(`
				INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
				VALUES ('test-1', 'Test Session', '/test', datetime('now'), datetime('now'), 'active', '{}', '{}')
			`);

      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('test-1') as {
        id: string;
        title: string;
        workspace_path: string;
      };

      expect(session).toBeDefined();
      expect(session.id).toBe('test-1');
      expect(session.title).toBe('Test Session');
      expect(session.workspace_path).toBe('/test');
    });

    it('should support transactions', async () => {
      const db = dbCore.getDb();

      db.transaction(() => {
        db.exec(`
					INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
					VALUES ('tx-1', 'TX 1', '/test', datetime('now'), datetime('now'), 'active', '{}', '{}')
				`);
        db.exec(`
					INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
					VALUES ('tx-2', 'TX 2', '/test', datetime('now'), datetime('now'), 'active', '{}', '{}')
				`);
      })();

      const count = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
      expect(count.count).toBe(2);
    });
  });

  describe('WAL mode benefits', () => {
    it('should create WAL and SHM files', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();
      db.exec(`
				INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
				VALUES ('wal-test', 'WAL Test', '/test', datetime('now'), datetime('now'), 'active', '{}', '{}')
			`);

      const walPath = dbPath + '-wal';
      const shmPath = dbPath + '-shm';

      expect(existsSync(dbPath)).toBe(true);
    });
  });

  describe('concurrent access', () => {
    it('should allow reading from a second connection to the same file', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db1 = dbCore.getDb();
      db1.exec(`
				INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
				VALUES ('concurrent-1', 'Concurrent Test', '/test', datetime('now'), datetime('now'), 'active', '{}', '{}')
			`);

      const dbCore2 = new DatabaseCore(dbPath);
      await dbCore2.initialize();
      const db2 = dbCore2.getDb();

      const session = db2.prepare('SELECT * FROM sessions WHERE id = ?').get('concurrent-1') as {
        id: string;
      };
      expect(session).toBeDefined();
      expect(session.id).toBe('concurrent-1');

      dbCore2.close();
    });
  });

  describe('schema migrations', () => {
    it('should run migrations on initialize', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];

      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('sessions');
      expect(tableNames).toContain('sdk_messages');
      expect(tableNames).toContain('auth_config');
    });
  });
});
