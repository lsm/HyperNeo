import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
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
        } catch {
          // Already closed
        }
      }
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
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

      const backupDir = join(testDir, 'backups');
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

      const backupDir = join(testDir, 'backups');
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
      const backupDir = join(testDir, 'backups');
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
      const backupPath = join(testDir, 'backups', backups[0]);
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
      expect(existsSync(join(testDir, 'backups', `${backups[0]}-wal`))).toBe(false);

      const backup = new RawDatabase(join(testDir, 'backups', backups[0]));
      try {
        expect(backup.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        expect(backup.prepare('SELECT value FROM backup_probe').all()).toEqual([
          { value: 'pre-migration' },
        ]);
      } finally {
        backup.close();
      }
    });

    it('should complete initialization without a backup when the backup directory is unwritable', async () => {
      const backupDir = join(testDir, 'backups');
      mkdirSync(backupDir, { recursive: true });
      chmodSync(backupDir, 0o500);

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
        chmodSync(backupDir, 0o700);
      }

      expect(listBackups()).toHaveLength(0);
      expect(errors).toHaveLength(1);
    });

    it('should prune expired backups together with their WAL sidecars', async () => {
      const backupDir = join(testDir, 'backups');
      mkdirSync(backupDir, { recursive: true });
      const now = Date.now() / 1000;
      const staleWalOwner = 'daemon-2026-01-01T00-00-00-000Z.db';
      for (let i = 0; i < 4; i++) {
        const stale = join(backupDir, `daemon-2026-01-0${i + 1}T00-00-00-000Z.db`);
        writeFileSync(stale, 'stale');
        if (i === 0) {
          writeFileSync(`${stale}-wal`, 'stale-wal');
        }
        utimesSync(stale, now - (5 - i) * 60, now - (5 - i) * 60);
      }

      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const remaining = readdirSync(backupDir);
      expect(remaining.filter((f) => f.endsWith('.db') && f.startsWith('daemon-'))).toHaveLength(3);
      expect(existsSync(join(backupDir, `${staleWalOwner}-wal`))).toBe(false);
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
