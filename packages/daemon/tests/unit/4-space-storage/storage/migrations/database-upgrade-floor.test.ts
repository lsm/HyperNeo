import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseCore } from '../../../../../src/storage/database-core.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

const directories: string[] = [];

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hyperneo-upgrade-floor-'));
  directories.push(dir);
  return join(dir, 'test.db');
}

function writeOldDatabase(path: string, version: number | null): void {
  const db = new Database(path);
  try {
    db.exec(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT); INSERT INTO sessions VALUES ('keep', 'untouched')"
    );
    if (version !== null) {
      db.exec('CREATE TABLE migration_markers (key TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
      db.prepare('INSERT INTO migration_markers VALUES (?, 1)').run(
        `migration_${String(version).padStart(3, '0')}`
      );
    }
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('DatabaseCore upgrade floor', () => {
  for (const version of [null, 0, 156, 157, 237]) {
    test(`refuses version ${version ?? 'unknown'} without changing the database`, async () => {
      const path = databasePath();
      writeOldDatabase(path, version);
      const before = readFileSync(path);
      const core = new DatabaseCore(path);
      await expect(core.initialize()).rejects.toThrow(
        version === null ? 'version unknown (no numbered migration markers)' : `version ${version} `
      );
      await expect(core.initialize()).rejects.toThrow('v0.41.0–v0.44.x first');
      expect(readFileSync(path)).toEqual(before);
      expect(existsSync(`${path}.lock`)).toBe(false);
      expect(existsSync(`${path}-wal`)).toBe(false);
      expect(existsSync(join(path, '..', 'backups'))).toBe(false);
    });
  }

  test('does not treat an existing empty marker table as a fresh database', async () => {
    const path = databasePath();
    const db = new Database(path);
    db.exec('CREATE TABLE migration_markers (key TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    db.close();
    await expect(new DatabaseCore(path).initialize()).rejects.toThrow('version unknown');
  });

  test('refuses an old database with committed WAL data without changing either file', async () => {
    const path = databasePath();
    writeOldDatabase(path, 237);
    const writer = new Database(path);
    try {
      writer.exec('PRAGMA journal_mode = WAL');
      writer.exec("UPDATE sessions SET title = 'committed in WAL' WHERE id = 'keep'");
      const before = readFileSync(path);
      const walBefore = readFileSync(`${path}-wal`);
      await expect(new DatabaseCore(path).initialize()).rejects.toThrow('version 237');
      expect(readFileSync(path)).toEqual(before);
      expect(readFileSync(`${path}-wal`)).toEqual(walBefore);
      expect(writer.prepare('SELECT title FROM sessions').get()).toEqual({
        title: 'committed in WAL',
      });
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      writer.close();
    }
  });

  for (const fixture of [null, 'v0.41.0.sql', 'dev-383.sql']) {
    test(`accepts ${fixture ?? 'a fresh database'}`, async () => {
      const path = databasePath();
      if (fixture) {
        const db = new Database(path);
        db.exec(
          readFileSync(new URL(`./fixtures/schema-baseline/${fixture}`, import.meta.url), 'utf8')
        );
        db.close();
      }
      const core = new DatabaseCore(path);
      try {
        await core.initialize();
        expect(
          core
            .getDb()
            .prepare("SELECT key FROM migration_markers WHERE key = 'migration_383'")
            .get()
        ).toEqual({ key: 'migration_383' });
      } finally {
        core.close();
      }
    });
  }
});
