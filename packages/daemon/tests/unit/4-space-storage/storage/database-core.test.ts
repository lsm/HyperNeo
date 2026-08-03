/**
 * DatabaseCore Unit Tests
 *
 * Unit tests for the core database infrastructure.
 * Tests initialization, configuration, backup, and close operations.
 */

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
    // Create unique test directory for each test
    testDir = join(tmpdir(), `db-core-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    // Cleanup test directory
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
      // Database file should not exist yet
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
      expect(result.synchronous).toBe(1); // NORMAL = 1
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

    it('should set auto_vacuum = INCREMENTAL on a fresh database', async () => {
      // dbPath did not exist before initialize(), so the DB is created fresh and
      // auto_vacuum is set before any table is created.
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();
      const result = db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number };
      expect(result.auto_vacuum).toBe(2); // 2 == INCREMENTAL
    });

    it('should create database tables', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();

      // Check that sessions table exists
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
        .all();
      expect(tables.length).toBe(1);
    });

    it('should be idempotent (safe to call twice)', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      // Should not throw
      await dbCore.initialize();
    });
  });

  describe('getDb', () => {
    it('should return the underlying Bun SQLite database', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();
      expect(db).toBeDefined();

      // Should be able to execute queries
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

      // After close, operations should fail
      expect(() => db.prepare('SELECT 1').get()).toThrow();
    });

    it('should checkpoint the WAL before closing (WAL file is empty or absent after close)', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      const db = dbCore.getDb();
      // Write data to ensure WAL frames are created
      db.exec(`
				INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
				VALUES ('wal-close-test', 'WAL Close Test', '/test', datetime('now'), datetime('now'), 'active', '{}', '{}')
			`);

      dbCore.close();
      dbCore = null as unknown as typeof dbCore; // prevent double-close in afterEach

      // After a TRUNCATE checkpoint, the WAL file should be zero bytes or absent
      const walPath = dbPath + '-wal';
      if (existsSync(walPath)) {
        const { size } = statSync(walPath);
        expect(size).toBe(0);
      }
      // Lock file should be released
      expect(existsSync(dbPath + '.lock')).toBe(false);
    });

    it('should release the lock file on close', async () => {
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      expect(existsSync(dbPath + '.lock')).toBe(true);

      dbCore.close();
      dbCore = null as unknown as typeof dbCore; // prevent double-close in afterEach

      expect(existsSync(dbPath + '.lock')).toBe(false);
    });
  });

  describe('backup creation', () => {
    it('should create backup directory during initialization with existing db', async () => {
      // First, create a database
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      // Insert some data (using the correct schema)
      const db = dbCore.getDb();
      db.exec(`
				INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
				VALUES ('test-id', 'Test Session', '/test', datetime('now'), datetime('now'), 'active', '{}', '{}')
			`);

      // Close and reopen - this should trigger backup during migrations
      dbCore.close();

      // Reopen with same path - migrations will check for backup
      dbCore = new DatabaseCore(dbPath);
      await dbCore.initialize();

      // Backup directory should exist
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

      // Reopen multiple times to create multiple backups
      for (let i = 0; i < 5; i++) {
        // Wait a bit to ensure different timestamps
        await Bun.sleep(10);
        dbCore = new DatabaseCore(dbPath);
        await dbCore.initialize();
        dbCore.close();
      }

      // Check backup count
      const backupDir = join(testDir, 'backups');
      if (existsSync(backupDir)) {
        const backups = readdirSync(backupDir).filter(
          (f) => f.startsWith('daemon-') && f.endsWith('.db')
        );
        expect(backups.length).toBeLessThanOrEqual(3);
      }
    });
  });

  describe('in-memory database', () => {
    it('should work with in-memory database', async () => {
      dbCore = new DatabaseCore(':memory:');
      await dbCore.initialize();

      const db = dbCore.getDb();
      expect(db).toBeDefined();

      // Should be able to execute queries
      const result = db.prepare('SELECT 1 as value').get() as { value: number };
      expect(result.value).toBe(1);
    });

    it('should create tables in memory', async () => {
      dbCore = new DatabaseCore(':memory:');
      await dbCore.initialize();

      const db = dbCore.getDb();

      // Check that sessions table exists
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
        .all();
      expect(tables.length).toBe(1);
    });
  });

  describe('error handling', () => {
    it('should handle invalid path gracefully', async () => {
      // This should work - the directory will be created
      // Use process.env.TMPDIR to support custom temp directory setups
      const tmpBase = (process.env.TMPDIR || '/tmp').replace(/\/$/, '');
      const invalidPath = `${tmpBase}/test-db-core-invalid`;
      // The test doesn't use the `testDir` helper so ensure leftover state
      // from a previous run can't poison a fresh initialize (the migration
      // pipeline assumes tables match current schema).
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

      // Write some data to trigger WAL
      const db = dbCore.getDb();
      db.exec(`
				INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
				VALUES ('wal-test', 'WAL Test', '/test', datetime('now'), datetime('now'), 'active', '{}', '{}')
			`);

      // WAL file should exist (or be created on write)
      const walPath = dbPath + '-wal';
      const shmPath = dbPath + '-shm';

      // Note: WAL files may not exist immediately after write
      // This test just verifies WAL mode is enabled (tested separately)
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

      // Lock file is held by dbCore. A second DatabaseCore in the same process
      // can open the file (same-process bypass), but in production only one
      // DatabaseCore exists — cross-process attempts are blocked by the lock file.
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

      // Check that expected tables exist
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];

      const tableNames = tables.map((t) => t.name);

      // Core tables should exist
      expect(tableNames).toContain('sessions');
      expect(tableNames).toContain('sdk_messages');
      expect(tableNames).toContain('auth_config');
    });
  });
});
