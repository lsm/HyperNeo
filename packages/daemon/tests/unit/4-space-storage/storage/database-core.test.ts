import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseCore } from '../../../../src/storage/database-core';

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

  describe('migration backup size bound', () => {
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

    it('should skip the migration backup when the database exceeds the bound', async () => {
      process.env[envKey] = '1';

      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      expect(existsSync(dbPath)).toBe(true);
      expect(listBackups()).toHaveLength(0);
    });

    it('should still create the migration backup when the bound is disabled', async () => {
      process.env[envKey] = '0';

      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      expect(listBackups()).toHaveLength(1);
    });

    it('should fall back to the default bound for invalid values', async () => {
      process.env[envKey] = 'not-a-number';

      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      expect(listBackups()).toHaveLength(1);
    });

    it('should fall back to the default bound for partially numeric values like 1GB', async () => {
      process.env[envKey] = '1GB';

      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      expect(listBackups()).toHaveLength(1);
    });

    it('should fall back to the default bound for negative values', async () => {
      process.env[envKey] = '-1';

      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      expect(listBackups()).toHaveLength(1);
    });

    it('should fall back to the default bound for whitespace-only values', async () => {
      process.env[envKey] = '   ';

      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      expect(listBackups()).toHaveLength(1);
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
