import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRebuiltDatabase,
  performFileSwap,
  run,
  swapRebuiltDatabase,
  verifyRebuiltDatabase,
} from './rebuild-daemon-db.ts';

let workDir: string;

function fixturePath(name: string): string {
  return join(workDir, name);
}

function createFixtureDatabase(path: string, options: { brokenForeignKey?: boolean } = {}): void {
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA user_version = 7');
  db.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY, title TEXT NOT NULL)`);
  db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, payload BLOB)`);
  db.exec(`CREATE TABLE notes (body TEXT)`);
  db.exec(`CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`);
  db.exec(`CREATE TABLE metrics (
    id INTEGER PRIMARY KEY,
    raw TEXT,
    raw_upper TEXT GENERATED ALWAYS AS (upper(raw)) VIRTUAL
  )`);
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    body TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE message_audit (message_id INTEGER, noted_at TEXT)`);
  db.exec(`CREATE TABLE search_content (id INTEGER PRIMARY KEY, title TEXT, body TEXT)`);
  db.exec(`CREATE VIRTUAL TABLE search_fts USING fts5(
    title, body, content='search_content', content_rowid='id', detail=column, tokenize='unicode61'
  )`);
  db.exec(`CREATE INDEX idx_messages_session ON messages(session_id)`);
  db.exec(`CREATE UNIQUE INDEX idx_events_name ON events(name) WHERE name IS NOT NULL`);
  db.exec(`CREATE VIEW session_titles AS SELECT id, title FROM sessions`);
  db.exec(`CREATE TRIGGER message_audit_ai AFTER INSERT ON messages BEGIN
    INSERT INTO message_audit (message_id, noted_at) VALUES (new.id, '2026-08-24T00:00:00Z');
  END`);
  db.exec(`CREATE TRIGGER search_content_ai AFTER INSERT ON search_content BEGIN
    INSERT INTO search_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
  END`);
  db.exec(`CREATE TRIGGER search_content_ad AFTER DELETE ON search_content BEGIN
    INSERT INTO search_fts (search_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
  END`);

  db.exec(`INSERT INTO sessions (id, title) VALUES (1, 'alpha'), (2, 'beta')`);
  db.exec(`INSERT INTO events (name, payload) VALUES
    ('one', x'00112233'),
    ('two', NULL),
    ('three', x'caffee')`);
  db.exec(`INSERT INTO events (name) VALUES ('four'), ('five')`);
  db.exec(`DELETE FROM events WHERE id > 3`);
  db.exec(`INSERT INTO notes (rowid, body) VALUES (10, 'first'), (20, 'second'), (30, 'third')`);
  db.exec(`DELETE FROM notes WHERE rowid = 20`);
  db.exec(`INSERT INTO kv (k, v) VALUES ('a', '1'), ('b', '2')`);
  db.exec(`INSERT INTO metrics (id, raw) VALUES (1, 'hello'), (2, 'mixed CASE')`);
  db.exec(`INSERT INTO messages (id, session_id, body) VALUES
    (1, 1, 'needle in session one'),
    (2, 2, 'plain body'),
    (3, 1, 'another needle')`);
  db.exec(`INSERT INTO search_content (id, title, body) VALUES
    (1, 'alpha title', 'findme alpha body'),
    (2, 'beta title', 'findme beta body'),
    (3, 'gamma title', 'unrelated words')`);

  if (options.brokenForeignKey) {
    db.exec(`INSERT INTO messages (id, session_id, body) VALUES (99, 999, 'dangling reference')`);
  }

  db.exec(`CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)`);
  const chunk = Buffer.alloc(64 * 1024, 7);
  const insert = db.prepare(`INSERT INTO blobs (id, data) VALUES (?, ?)`);
  for (let i = 0; i < 160; i++) {
    insert.run(i + 1, i < 80 ? chunk : null);
  }
  for (let i = 0; i < 80; i++) {
    insert.run(1000 + i, chunk);
  }
  db.exec(`DELETE FROM blobs WHERE id > 1000`);
  db.exec(`UPDATE blobs SET data = NULL WHERE id <= 40`);
  db.exec('ANALYZE');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

function defaultOptions(dbPath: string) {
  return {
    dbPath,
    yes: true,
    force: false,
    noSwap: false,
    fullIntegrity: true,
  };
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function queryInSubprocess(path: string, sql: string): unknown[] {
  const program = `import { Database } from 'bun:sqlite';
const db = new Database(${JSON.stringify(path)});
console.log(JSON.stringify(db.prepare(${JSON.stringify(sql)}).all()));
db.close();`;
  const result = Bun.spawnSync({
    cmd: [process.execPath, '-e', program],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`subprocess query failed: ${result.stderr.toString().trim()}`);
  }
  return JSON.parse(result.stdout.toString()) as unknown[];
}

beforeAll(() => {
  workDir = join(tmpdir(), `rebuild-daemon-db-test-${process.pid}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('rebuild-daemon-db', () => {
  test('rebuild copies every table exactly and enables INCREMENTAL auto_vacuum with WAL', async () => {
    const oldPath = fixturePath('exact.db');
    createFixtureDatabase(oldPath);
    const oldBytes = sha256OfFile(oldPath);
    const oldFreelist = (() => {
      const db = new Database(oldPath, { readonly: true });
      const row = db.prepare('PRAGMA freelist_count').get() as { freelist_count: number };
      db.close();
      return row.freelist_count;
    })();
    expect(oldFreelist).toBeGreaterThan(0);

    const newPath = `${oldPath}.rebuild.db`;
    const db = createRebuiltDatabase(oldPath, newPath);
    try {
      expect(verifyRebuiltDatabase(db, { fullIntegrity: true })).toEqual([]);

      const autoVacuum = db.prepare('PRAGMA main.auto_vacuum').get() as { auto_vacuum: number };
      expect(autoVacuum.auto_vacuum).toBe(2);
      const journal = db.prepare('PRAGMA main.journal_mode').get() as { journal_mode: string };
      expect(journal.journal_mode).toBe('wal');
      const userVersion = db.prepare('PRAGMA main.user_version').get() as {
        user_version: number;
      };
      expect(userVersion.user_version).toBe(7);

      const sessionRows = db.prepare('SELECT id, title FROM main.sessions ORDER BY id').all();
      expect(sessionRows).toEqual([
        { id: 1, title: 'alpha' },
        { id: 2, title: 'beta' },
      ]);

      const noteRowids = db.prepare('SELECT rowid FROM main.notes ORDER BY rowid').all() as {
        rowid: number;
      }[];
      expect(noteRowids.map((row) => row.rowid)).toEqual([10, 30]);

      const kvRows = db.prepare('SELECT k, v FROM main.kv ORDER BY k').all();
      expect(kvRows).toEqual([
        { k: 'a', v: '1' },
        { k: 'b', v: '2' },
      ]);

      const sequence = db.prepare('SELECT name, seq FROM main.sqlite_sequence').all() as {
        name: string;
        seq: number;
      }[];
      expect(sequence).toEqual([{ name: 'events', seq: 5 }]);

      const metricUppers = db.prepare('SELECT raw_upper FROM main.metrics ORDER BY id').all() as {
        raw_upper: string;
      }[];
      expect(metricUppers.map((row) => row.raw_upper)).toEqual(['HELLO', 'MIXED CASE']);

      const viewRows = db.prepare('SELECT count(*) AS count FROM main.session_titles').get() as {
        count: number;
      };
      expect(viewRows.count).toBe(2);

      const auditRows = db.prepare('SELECT count(*) AS count FROM main.message_audit').get() as {
        count: number;
      };
      expect(auditRows.count).toBe(3);

      const ftsMatches = db
        .prepare(`SELECT rowid FROM main.search_fts WHERE search_fts MATCH 'findme' ORDER BY rowid`)
        .all() as { rowid: number }[];
      expect(ftsMatches.map((row) => row.rowid)).toEqual([1, 2]);

      const foreignKeys = db.prepare('PRAGMA main.foreign_key_check').values();
      expect(foreignKeys).toEqual([]);
    } finally {
      db.exec('DETACH DATABASE src');
      db.close();
    }

    const oldSize = statSync(oldPath).size;
    const newSize = statSync(newPath).size;
    expect(newSize).toBeLessThan(oldSize);
    expect(sha256OfFile(oldPath)).toBe(oldBytes);
    rmSync(newPath, { force: true });
    rmSync(`${newPath}-wal`, { force: true });
    rmSync(`${newPath}-shm`, { force: true });
  });

  test('verification fails closed on row loss and schema drift', async () => {
    const oldPath = fixturePath('tamper.db');
    createFixtureDatabase(oldPath);
    const newPath = `${oldPath}.rebuild.db`;
    const db = createRebuiltDatabase(oldPath, newPath);
    try {
      db.exec('DELETE FROM main.events WHERE id = 1');
      const failures = verifyRebuiltDatabase(db, { fullIntegrity: false });
      expect(failures.some((failure) => failure.includes('row count mismatch for events'))).toBe(
        true
      );

      db.exec('DROP VIEW main.session_titles');
      const schemaFailures = verifyRebuiltDatabase(db, { fullIntegrity: false });
      expect(
        schemaFailures.some((failure) => failure.includes('schema object missing in rebuild'))
      ).toBe(true);
    } finally {
      db.exec('DETACH DATABASE src');
      db.close();
    }
    rmSync(newPath, { force: true });
    rmSync(`${newPath}-wal`, { force: true });
    rmSync(`${newPath}-shm`, { force: true });
  });

  test('swap keeps the original as a readable backup and promotes the rebuilt file', async () => {
    const oldPath = fixturePath('swap.db');
    createFixtureDatabase(oldPath);
    const oldSize = statSync(oldPath).size;
    const newPath = `${oldPath}.rebuild.db`;
    const backupPath = `${oldPath}.pre-rebuild`;

    const db = createRebuiltDatabase(oldPath, newPath);
    expect(verifyRebuiltDatabase(db, { fullIntegrity: false })).toEqual([]);
    swapRebuiltDatabase(db, oldPath, newPath, backupPath);

    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(backupPath)).toBe(true);
    expect(existsSync(newPath)).toBe(false);
    expect(existsSync(`${newPath}-wal`)).toBe(false);
    expect(existsSync(`${newPath}-shm`)).toBe(false);

    const backupEvents = queryInSubprocess(backupPath, 'SELECT count(*) AS count FROM events') as {
      count: number;
    }[];
    expect(backupEvents).toEqual([{ count: 3 }]);

    const promotedNotes = queryInSubprocess(oldPath, 'SELECT rowid FROM notes ORDER BY rowid') as {
      rowid: number;
    }[];
    expect(promotedNotes).toEqual([{ rowid: 10 }, { rowid: 30 }]);

    const promotedMatches = queryInSubprocess(
      oldPath,
      `SELECT rowid FROM search_fts WHERE search_fts MATCH 'findme' ORDER BY rowid`
    ) as { rowid: number }[];
    expect(promotedMatches).toEqual([{ rowid: 1 }, { rowid: 2 }]);
    expect(statSync(oldPath).size).toBeLessThan(oldSize);
  });

  test('run() folds a leftover WAL, rebuilds, verifies, swaps, and retains the backup', async () => {
    const livePath = fixturePath('wal-source.db');
    const dbPath = fixturePath('wal-target.db');
    createFixtureDatabase(livePath);

    const live = new Database(livePath);
    live.exec(`INSERT INTO sessions (id, title) VALUES (99, 'wal-only session')`);
    live.exec(`INSERT INTO notes (rowid, body) VALUES (99, 'wal-only note')`);
    copyFileSync(livePath, dbPath);
    copyFileSync(`${livePath}-wal`, `${dbPath}-wal`);
    live.close();
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

    await run(defaultOptions(dbPath));

    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    const leftovers = readdirSync(workDir).filter((name) => name.startsWith('wal-target.db'));
    const backupName = leftovers.find((name) => name.includes('pre-rebuild'));
    expect(backupName).toBeDefined();
    const backupPath = join(workDir, backupName as string);
    expect(leftovers.filter((name) => name.includes('.rebuild-'))).toEqual([]);

    const walSessions = queryInSubprocess(dbPath, 'SELECT title FROM sessions WHERE id = 99') as {
      title: string;
    }[];
    const walNotes = queryInSubprocess(dbPath, 'SELECT rowid FROM notes WHERE rowid = 99') as {
      rowid: number;
    }[];
    expect(walSessions).toEqual([{ title: 'wal-only session' }]);
    expect(walNotes).toEqual([{ rowid: 99 }]);

    const backupSessions = queryInSubprocess(
      backupPath,
      'SELECT count(*) AS count FROM sessions'
    ) as { count: number }[];
    expect(backupSessions).toEqual([{ count: 3 }]);
  });

  test('run() leaves the original untouched when verification fails', async () => {
    const dbPath = fixturePath('broken-fk.db');
    createFixtureDatabase(dbPath, { brokenForeignKey: true });
    const beforeSize = statSync(dbPath).size;
    const beforeHash = sha256OfFile(dbPath);

    await expect(run(defaultOptions(dbPath))).rejects.toThrow('Verification failed');

    expect(statSync(dbPath).size).toBe(beforeSize);
    expect(sha256OfFile(dbPath)).toBe(beforeHash);
    const leftovers = readdirSync(workDir).filter(
      (name) => name.startsWith('broken-fk.db') && name.includes('.rebuild-')
    );
    expect(leftovers).toEqual([]);
  });

  test('run() with --no-swap builds and verifies but keeps both files in place', async () => {
    const dbPath = fixturePath('noswap.db');
    createFixtureDatabase(dbPath);

    await run({ ...defaultOptions(dbPath), noSwap: true });

    const originalEvents = queryInSubprocess(dbPath, 'SELECT count(*) AS count FROM events') as {
      count: number;
    }[];
    expect(originalEvents).toEqual([{ count: 3 }]);

    const rebuiltName = readdirSync(workDir).find(
      (name) => name.startsWith('noswap.db') && name.endsWith('.db') && name.includes('.rebuild-')
    );
    expect(rebuiltName).toBeDefined();
    const rebuiltEvents = queryInSubprocess(
      join(workDir, rebuiltName as string),
      'SELECT count(*) AS count FROM events'
    ) as { count: number }[];
    expect(rebuiltEvents).toEqual([{ count: 3 }]);
  });

  test('run() acquires the daemon lock, releases it, and refuses against a live PID', async () => {
    const dbPath = fixturePath('lock.db');
    createFixtureDatabase(dbPath);
    const lockPath = `${dbPath}.lock`;

    const holder = Bun.spawn(['sleep', '30']);
    writeFileSync(lockPath, String(holder.pid));
    try {
      await expect(run(defaultOptions(dbPath))).rejects.toThrow('Refusing to rebuild');
    } finally {
      holder.kill();
      await holder.exited;
    }
    expect(readFileSync(lockPath, 'utf-8')).toBe(String(holder.pid));

    const stale = Bun.spawn(['sleep', '0']);
    await stale.exited;
    writeFileSync(lockPath, String(stale.pid));

    await run(defaultOptions(dbPath));
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
    expect(
      readdirSync(workDir).some(
        (name) => name.startsWith('lock.db') && name.includes('pre-rebuild')
      )
    ).toBe(true);
  });

  test('run() releases the lock when verification fails', async () => {
    const dbPath = fixturePath('lock-fail.db');
    createFixtureDatabase(dbPath, { brokenForeignKey: true });

    await expect(run(defaultOptions(dbPath))).rejects.toThrow('Verification failed');
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });

  test('the promoted file keeps the original permission bits', async () => {
    const dbPath = fixturePath('mode.db');
    createFixtureDatabase(dbPath);
    chmodSync(dbPath, 0o600);

    await run(defaultOptions(dbPath));

    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });

  test('run() fails closed when a foreign reader blocks the WAL checkpoint', async () => {
    const dbPath = fixturePath('busy-reader.db');
    createFixtureDatabase(dbPath);

    const reader = new Database(dbPath);
    const writer = new Database(dbPath);
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT count(*) AS count FROM events').get();
      writer.exec(`INSERT INTO events (name) VALUES ('wal-only row')`);
      expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

      await expect(run(defaultOptions(dbPath))).rejects.toThrow('blocked by another reader');
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
      writer.close();
    }
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
  });

  test('a swap that fails mid-sequence restores the original file', async () => {
    const dbPath = fixturePath('swapfail.db');
    createFixtureDatabase(dbPath);
    const originalHash = sha256OfFile(dbPath);
    const newPath = `${dbPath}.rebuild.db`;
    const backupPath = `${dbPath}.pre-rebuild`;

    const db = createRebuiltDatabase(dbPath, newPath);
    expect(verifyRebuiltDatabase(db, { fullIntegrity: false })).toEqual([]);
    db.exec('DETACH DATABASE src');
    db.close();

    writeFileSync(`${dbPath}-wal`, 'stale-wal-bytes');
    mkdirSync(`${backupPath}-wal`);

    expect(() => performFileSwap(dbPath, newPath, backupPath)).toThrow();

    expect(sha256OfFile(dbPath)).toBe(originalHash);
    expect(existsSync(backupPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
    rmSync(newPath, { force: true });
    rmSync(`${newPath}-wal`, { force: true });
    rmSync(`${newPath}-shm`, { force: true });
    rmSync(`${backupPath}-wal`, { recursive: true, force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  test('a failure after promotion keeps the backup instead of deleting it', async () => {
    const dbPath = fixturePath('postpromote.db');
    createFixtureDatabase(dbPath);
    const originalHash = sha256OfFile(dbPath);
    const newPath = `${dbPath}.rebuild.db`;
    const backupPath = `${dbPath}.pre-rebuild`;

    const db = createRebuiltDatabase(dbPath, newPath);
    expect(verifyRebuiltDatabase(db, { fullIntegrity: false })).toEqual([]);
    db.exec('DETACH DATABASE src');
    db.close();

    rmSync(`${newPath}-shm`, { force: true });
    mkdirSync(`${newPath}-shm`);

    expect(() => performFileSwap(dbPath, newPath, backupPath)).toThrow();
    expect(existsSync(backupPath)).toBe(true);
    expect(sha256OfFile(backupPath)).toBe(originalHash);

    const promotedRows = queryInSubprocess(dbPath, 'SELECT count(*) AS count FROM events') as {
      count: number;
    }[];
    expect(promotedRows).toEqual([{ count: 3 }]);

    rmSync(`${newPath}-shm`, { recursive: true, force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(backupPath, { force: true });
  });

  test('tables larger than one batch copy across multiple batches', async () => {
    const dbPath = fixturePath('multibatch.db');
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT)`);
    const insert = db.prepare(`INSERT INTO big (id, v) VALUES (?, ?)`);
    db.exec('BEGIN');
    for (let i = 1; i <= 120_000; i++) insert.run(i, `row-${i}`);
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();

    const newPath = `${dbPath}.rebuild.db`;
    const rebuilt = createRebuiltDatabase(dbPath, newPath);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
      const first = rebuilt.prepare('SELECT v FROM main.big WHERE id = 50000').get() as {
        v: string;
      };
      const last = rebuilt.prepare('SELECT v FROM main.big WHERE id = 120000').get() as {
        v: string;
      };
      expect(first.v).toBe('row-50000');
      expect(last.v).toBe('row-120000');
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(newPath, { force: true });
    rmSync(`${newPath}-wal`, { force: true });
    rmSync(`${newPath}-shm`, { force: true });
  });

  test('batch cursors stay exact for rowids beyond the safe-integer range', async () => {
    const dbPath = fixturePath('bigid.db');
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE bigids (id INTEGER PRIMARY KEY, v TEXT)`);
    const insert = db.prepare(`INSERT INTO bigids (id, v) VALUES (?, ?)`);
    db.exec('BEGIN');
    for (let i = 1; i <= 50_001; i++) insert.run(i, `row-${i}`);
    insert.run(2n ** 60n, 'huge-row');
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();

    const newPath = `${dbPath}.rebuild.db`;
    const rebuilt = createRebuiltDatabase(dbPath, newPath);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
      const huge = rebuilt
        .prepare('SELECT v FROM main.bigids WHERE id = 1152921504606846976')
        .get() as { v: string };
      expect(huge.v).toBe('huge-row');
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(newPath, { force: true });
    rmSync(`${newPath}-wal`, { force: true });
    rmSync(`${newPath}-shm`, { force: true });
  });

  test('ordinary tables prefixed like an FTS table are still copied', async () => {
    const dbPath = fixturePath('prefix.db');
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE vsearch_notes (id INTEGER PRIMARY KEY, note TEXT)`);
    db.exec(`INSERT INTO vsearch_notes (note) VALUES ('kept')`);
    db.exec(`CREATE TABLE vc (id INTEGER PRIMARY KEY, body TEXT)`);
    db.exec(`INSERT INTO vc (body) VALUES ('findme prefix')`);
    db.exec(`CREATE VIRTUAL TABLE vsearch USING fts5(body, content='vc', content_rowid='id')`);
    db.exec(`INSERT INTO vsearch(vsearch) VALUES('rebuild')`);
    db.close();

    const newPath = `${dbPath}.rebuild.db`;
    const rebuilt = createRebuiltDatabase(dbPath, newPath);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
      const notes = rebuilt.prepare('SELECT count(*) AS count FROM main.vsearch_notes').get() as {
        count: number;
      };
      expect(notes.count).toBe(1);
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(newPath, { force: true });
    rmSync(`${newPath}-wal`, { force: true });
    rmSync(`${newPath}-shm`, { force: true });
  });

  test('internal-content FTS tables copy their index data and stay searchable', async () => {
    const dbPath = fixturePath('internal-fts.db');
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE VIRTUAL TABLE ivs USING fts5(body)`);
    const insert = db.prepare(`INSERT INTO ivs (body) VALUES (?)`);
    insert.run('findme internal words');
    insert.run('other entry');
    db.exec(`INSERT INTO ivs(ivs, rank) VALUES('automerge', 16)`);
    db.exec(`INSERT INTO ivs(ivs, rank) VALUES('crisismerge', 64)`);
    db.close();

    const newPath = `${dbPath}.rebuild.db`;
    const rebuilt = createRebuiltDatabase(dbPath, newPath);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
      const matches = rebuilt
        .prepare(`SELECT body FROM main.ivs WHERE ivs MATCH 'findme'`)
        .all() as { body: string }[];
      expect(matches).toHaveLength(1);
      const configs = rebuilt
        .prepare(`SELECT k, v FROM main.ivs_config WHERE k != 'version' ORDER BY k`)
        .all() as { k: string; v: string | number }[];
      expect(configs.map((row) => [row.k, String(row.v)])).toEqual([
        ['automerge', '16'],
        ['crisismerge', '64'],
      ]);
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(newPath, { force: true });
    rmSync(`${newPath}-wal`, { force: true });
    rmSync(`${newPath}-shm`, { force: true });
  });

  test('external FTS rebuild restores persistent merge settings', async () => {
    const dbPath = fixturePath('ftsconfig.db');
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE fts_config_src (id INTEGER PRIMARY KEY, body TEXT)`);
    db.exec(`INSERT INTO fts_config_src (body) VALUES ('indexed words')`);
    db.exec(
      `CREATE VIRTUAL TABLE fcs USING fts5(body, content='fts_config_src', content_rowid='id')`
    );
    db.exec(`INSERT INTO fcs(fcs) VALUES('rebuild')`);
    db.exec(`INSERT INTO fcs(fcs, rank) VALUES('automerge', 16)`);
    db.exec(`INSERT INTO fcs(fcs, rank) VALUES('crisismerge', 64)`);
    db.close();

    const newPath = `${dbPath}.rebuild.db`;
    const rebuilt = createRebuiltDatabase(dbPath, newPath);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
      const configs = rebuilt
        .prepare(`SELECT k, v FROM main.fcs_config WHERE k != 'version' ORDER BY k`)
        .all() as { k: string; v: string }[];
      expect(configs.map((row) => [row.k, String(row.v)])).toEqual([
        ['automerge', '16'],
        ['crisismerge', '64'],
      ]);
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(newPath, { force: true });
    rmSync(`${newPath}-wal`, { force: true });
    rmSync(`${newPath}-shm`, { force: true });
  });

  test('a generated column shadowing rowid does not break the copy', async () => {
    const dbPath = fixturePath('genshadow.db');
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE genshadow (a INTEGER, rowid INTEGER GENERATED ALWAYS AS (a + 1) STORED)`);
    db.exec(`INSERT INTO genshadow (a) VALUES (10), (20), (30)`);
    db.exec(`DELETE FROM genshadow WHERE a = 20`);
    db.close();

    const newPath = `${dbPath}.rebuild.db`;
    const rebuilt = createRebuiltDatabase(dbPath, newPath);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
      const values = rebuilt.prepare('SELECT a FROM main.genshadow ORDER BY a').all() as {
        a: number;
      }[];
      expect(values.map((row) => row.a)).toEqual([10, 30]);
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(newPath, { force: true });
    rmSync(`${newPath}-wal`, { force: true });
    rmSync(`${newPath}-shm`, { force: true });
  });

  test('content= text inside another quoted option does not change the mode', async () => {
    const dbPath = fixturePath('nested-quote.db');
    const db = new Database(dbPath);
    db.exec(
      `CREATE VIRTUAL TABLE nft USING fts5(body, tokenize="unicode61 tokenchars 'content=foo'")`
    );
    const insert = db.prepare(`INSERT INTO nft (body) VALUES (?)`);
    insert.run('findme nested');
    db.close();

    const rebuilt = createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
      const matches = rebuilt
        .prepare(`SELECT body FROM main.nft WHERE nft MATCH 'findme'`)
        .all() as { body: string }[];
      expect(matches).toHaveLength(1);
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(`${dbPath}.rebuild.db`, { force: true });
    rmSync(`${dbPath}.rebuild.db-wal`, { force: true });
    rmSync(`${dbPath}.rebuild.db-shm`, { force: true });
  });

  test('bracket-quoted contentless FTS options abort in preflight', async () => {
    const dbPath = fixturePath('bracket-contentless.db');
    const db = new Database(dbPath);
    db.exec(`CREATE VIRTUAL TABLE bvs USING fts5(body, content=[])`);
    db.close();

    const newPath = `${dbPath}.rebuild.db`;
    expect(() => createRebuiltDatabase(dbPath, newPath)).toThrow(
      /Contentless FTS5 table bvs is not supported/
    );
    expect(existsSync(dbPath)).toBe(true);
  });

  test('backtick-quoted external content is classified as external', async () => {
    const dbPath = fixturePath('backtick-external.db');
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE bt_src (id INTEGER PRIMARY KEY, body TEXT)`);
    db.exec(`INSERT INTO bt_src (body) VALUES ('findme ticked')`);
    db.exec('CREATE VIRTUAL TABLE bts USING fts5(body, content=`bt_src`, content_rowid="id")');
    db.exec(`INSERT INTO bts(bts) VALUES('rebuild')`);
    db.close();

    const rebuilt = createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
      const rows = rebuilt.prepare('SELECT count(*) AS count FROM main.bt_src').get() as {
        count: number;
      };
      expect(rows.count).toBe(1);
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(`${dbPath}.rebuild.db`, { force: true });
    rmSync(`${dbPath}.rebuild.db-wal`, { force: true });
    rmSync(`${dbPath}.rebuild.db-shm`, { force: true });
  });

  test('an external content table named like a shadow is still copied', async () => {
    const dbPath = fixturePath('shadowname.db');
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE search_content (id INTEGER PRIMARY KEY, body TEXT)`);
    db.exec(`INSERT INTO search_content (body) VALUES ('findme shadow-named')`);
    db.exec(
      `CREATE VIRTUAL TABLE search USING fts5(body, content='search_content', content_rowid='id')`
    );
    db.exec(`INSERT INTO search(search) VALUES('rebuild')`);
    db.close();

    expect(() => createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`)).toThrow(
      /reserved FTS5 shadow naming/
    );
    expect(existsSync(dbPath)).toBe(true);
  });

  test('contentless FTS tables abort the rebuild before any import', async () => {
    const dbPath = fixturePath('contentless.db');
    const db = new Database(dbPath);
    db.exec(`CREATE VIRTUAL TABLE cvs USING fts5(body, content='')`);
    db.close();

    const newPath = `${dbPath}.rebuild.db`;
    expect(() => createRebuiltDatabase(dbPath, newPath)).toThrow(
      /Contentless FTS5 table cvs is not supported/
    );
    expect(existsSync(dbPath)).toBe(true);
  });

  test('tables with a descending integer primary key or NULL ids copy fully', async () => {
    const dbPath = fixturePath('descpk.db');
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE dpk (id INTEGER PRIMARY KEY DESC, v TEXT)`);
    db.exec(`INSERT INTO dpk (v) VALUES ('first'), ('second'), ('third')`);
    db.exec(`DELETE FROM dpk WHERE v = 'second'`);
    db.close();

    const newPath = `${dbPath}.rebuild.db`;
    const rebuilt = createRebuiltDatabase(dbPath, newPath);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
      const rows = rebuilt.prepare('SELECT v FROM main.dpk ORDER BY rowid').all() as {
        v: string;
      }[];
      expect(rows.map((row) => row.v)).toEqual(['first', 'third']);
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(newPath, { force: true });
    rmSync(`${newPath}-wal`, { force: true });
    rmSync(`${newPath}-shm`, { force: true });
  });

  test('internal sqlite_-prefixed lookalikes are copied', async () => {
    const dbPath = fixturePath('sqlitefoo.db');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE sqlitefoo (id INTEGER PRIMARY KEY, v TEXT)`);
    db.exec(`INSERT INTO sqlitefoo (v) VALUES ('kept')`);
    db.close();

    const rebuilt = createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
      const rows = rebuilt.prepare('SELECT count(*) AS count FROM main.sqlitefoo').get() as {
        count: number;
      };
      expect(rows.count).toBe(1);
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(`${dbPath}.rebuild.db`, { force: true });
    rmSync(`${dbPath}.rebuild.db-wal`, { force: true });
    rmSync(`${dbPath}.rebuild.db-shm`, { force: true });
  });

  test('text-valued FTS rank configuration survives the rebuild', async () => {
    const dbPath = fixturePath('ftsrank.db');
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE rk_src (id INTEGER PRIMARY KEY, body TEXT)`);
    db.exec(`INSERT INTO rk_src (body) VALUES ('ranked words')`);
    db.exec(`CREATE VIRTUAL TABLE rks USING fts5(body, content='rk_src', content_rowid='id')`);
    db.exec(`INSERT INTO rks(rks) VALUES('rebuild')`);
    db.exec(`INSERT INTO rks(rks, rank) VALUES('rank', 'bm25(10.0, 5.0)')`);
    db.close();

    const rebuilt = createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
      const rank = rebuilt.prepare(`SELECT v FROM main.rks_config WHERE k = 'rank'`).get() as {
        v: string;
      };
      expect(String(rank.v)).toBe('bm25(10.0, 5.0)');
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(`${dbPath}.rebuild.db`, { force: true });
    rmSync(`${dbPath}.rebuild.db-wal`, { force: true });
    rmSync(`${dbPath}.rebuild.db-shm`, { force: true });
  });

  test('unquoted external content options classify as external', async () => {
    const dbPath = fixturePath('unquoted.db');
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE uq_src (id INTEGER PRIMARY KEY, body TEXT)`);
    db.exec(`INSERT INTO uq_src (body) VALUES ('findme unquoted')`);
    db.exec(`CREATE VIRTUAL TABLE uqs USING fts5(body, content=uq_src, content_rowid=id)`);
    db.exec(`INSERT INTO uqs(uqs) VALUES('rebuild')`);
    db.close();

    const rebuilt = createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
      const rows = rebuilt.prepare('SELECT count(*) AS count FROM main.uq_src').get() as {
        count: number;
      };
      expect(rows.count).toBe(1);
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(`${dbPath}.rebuild.db`, { force: true });
    rmSync(`${dbPath}.rebuild.db-wal`, { force: true });
    rmSync(`${dbPath}.rebuild.db-shm`, { force: true });
  });

  test('locale options followed by line comments still abort in preflight', async () => {
    const dbPath = fixturePath('locale-line.db');
    const db = new Database(dbPath);
    db.exec(`CREATE VIRTUAL TABLE lvl USING fts5(
      body,
      locale=1-- chosen
    )`);
    db.close();

    expect(() => createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`)).toThrow(/per-row locales/);
    expect(existsSync(dbPath)).toBe(true);
  });

  test('UTF-16 sources rebuild with their original encoding', async () => {
    const dbPath = fixturePath('utf16.db');
    const db = new Database(dbPath);
    db.exec(`PRAGMA encoding = "UTF-16le"`);
    db.exec(`CREATE TABLE wide (id INTEGER PRIMARY KEY, v TEXT)`);
    db.exec(`INSERT INTO wide (v) VALUES ('unicode ✓ content')`);
    db.close();

    const rebuilt = createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`);
    try {
      const encoding = rebuilt.prepare('PRAGMA main.encoding').get() as { encoding: string };
      expect(encoding.encoding).toBe('UTF-16le');
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
      const rows = rebuilt.prepare('SELECT v FROM main.wide').all() as { v: string }[];
      expect(rows[0].v).toBe('unicode ✓ content');
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(`${dbPath}.rebuild.db`, { force: true });
    rmSync(`${dbPath}.rebuild.db-wal`, { force: true });
    rmSync(`${dbPath}.rebuild.db-shm`, { force: true });
  });

  test('quoted locale values with trailing comments still abort in preflight', async () => {
    const dbPath = fixturePath('locale-quoted.db');
    const db = new Database(dbPath);
    db.exec(`CREATE VIRTUAL TABLE lvq USING fts5(body, locale='1'/**/)`);
    db.close();

    expect(() => createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`)).toThrow(/per-row locales/);
    expect(existsSync(dbPath)).toBe(true);
  });

  test('locale options separated by SQL comments still abort in preflight', async () => {
    const dbPath = fixturePath('locale-comment.db');
    const db = new Database(dbPath);
    db.exec(`CREATE VIRTUAL TABLE lvc USING fts5(body, locale=1/**/)`);
    db.close();

    expect(() => createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`)).toThrow(/per-row locales/);
    expect(existsSync(dbPath)).toBe(true);
  });

  test('commas inside SQL block comments do not split FTS option lists', async () => {
    const dbPath = fixturePath('locale-comment-comma.db');
    const db = new Database(dbPath);
    db.exec(`CREATE VIRTUAL TABLE lvc2 USING fts5(body, locale=1/*,*/)`);
    db.close();

    expect(() => createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`)).toThrow(/per-row locales/);
    expect(existsSync(dbPath)).toBe(true);
  });

  test('quoted FTS5 module names are accepted', async () => {
    const dbPath = fixturePath('fts5-quoted.db');
    const db = new Database(dbPath);
    db.exec(`CREATE VIRTUAL TABLE fq USING "fts5"(body)`);
    db.exec(`INSERT INTO fq(body) VALUES ('alpha'), ('beta')`);
    db.close();

    const rebuilt = createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
      const rows = rebuilt.prepare(`SELECT body FROM main.fq ORDER BY rowid`).all() as {
        body: string;
      }[];
      expect(rows.map((row) => row.body)).toEqual(['alpha', 'beta']);
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(`${dbPath}.rebuild.db`, { force: true });
    rmSync(`${dbPath}.rebuild.db-wal`, { force: true });
    rmSync(`${dbPath}.rebuild.db-shm`, { force: true });
  });

  test('single-quoted FTS5 module names are accepted', async () => {
    const dbPath = fixturePath('fts5-single-quoted.db');
    const db = new Database(dbPath);
    db.exec(`CREATE VIRTUAL TABLE fsq USING 'fts5'(body)`);
    db.exec(`INSERT INTO fsq(body) VALUES ('alpha'), ('beta')`);
    db.close();

    const rebuilt = createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
      const rows = rebuilt.prepare(`SELECT body FROM main.fsq ORDER BY rowid`).all() as {
        body: string;
      }[];
      expect(rows.map((row) => row.body)).toEqual(['alpha', 'beta']);
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(`${dbPath}.rebuild.db`, { force: true });
    rmSync(`${dbPath}.rebuild.db-wal`, { force: true });
    rmSync(`${dbPath}.rebuild.db-shm`, { force: true });
  });

  test('FTS5 module declarations may be surrounded by SQL comments', async () => {
    const dbPath = fixturePath('fts5-comments.db');
    const db = new Database(dbPath);
    db.exec(`CREATE VIRTUAL TABLE fc USING /* c1 */ fts5 /* c2 */ (body)`);
    db.exec(`INSERT INTO fc(body) VALUES ('alpha')`);
    db.close();

    const rebuilt = createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(`${dbPath}.rebuild.db`, { force: true });
    rmSync(`${dbPath}.rebuild.db-wal`, { force: true });
    rmSync(`${dbPath}.rebuild.db-shm`, { force: true });
  });

  test('FTS5 options preceded by SQL comments are recognized', async () => {
    const dbPath = fixturePath('fts5-comment-prefix.db');
    const db = new Database(dbPath);
    db.exec(`CREATE VIRTUAL TABLE fcp USING fts5(body, /* lead */ content='')`);
    db.close();

    expect(() => createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`)).toThrow(/Contentless FTS5/);
    expect(existsSync(dbPath)).toBe(true);
  });

  test('FTS5 argument opener is found outside quoted table names', async () => {
    const dbPath = fixturePath('fts5-paren-name.db');
    const db = new Database(dbPath);
    db.exec(`CREATE VIRTUAL TABLE "ft(x" USING fts5(body, content='')`);
    db.close();

    expect(() => createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`)).toThrow(/Contentless FTS5/);
    expect(existsSync(dbPath)).toBe(true);
  });

  test('FTS5 column names with bracket-quoted commas are not split as options', async () => {
    const dbPath = fixturePath('fts5-bracket-column.db');
    const db = new Database(dbPath);
    db.exec(`CREATE VIRTUAL TABLE fbc USING fts5([x, content=foo])`);
    db.exec(`INSERT INTO fbc([x, content=foo]) VALUES ('alpha')`);
    db.close();

    const rebuilt = createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(`${dbPath}.rebuild.db`, { force: true });
    rmSync(`${dbPath}.rebuild.db-wal`, { force: true });
    rmSync(`${dbPath}.rebuild.db-shm`, { force: true });
  });

  test('comment markers inside quoted FTS option values are preserved', async () => {
    const dbPath = fixturePath('fts5-comment-value.db');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE '/*x*/' (id INTEGER PRIMARY KEY, body TEXT)`);
    db.exec(`INSERT INTO '/*x*/' (id, body) VALUES (1, 'hello')`);
    db.exec(`CREATE VIRTUAL TABLE fcv USING fts5(body, content='/*x*/', content_rowid='id')`);
    db.close();

    const rebuilt = createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
      const rows = rebuilt.prepare(`SELECT body FROM main.'/*x*/' ORDER BY id`).all() as {
        body: string;
      }[];
      expect(rows.map((row) => row.body)).toEqual(['hello']);
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(`${dbPath}.rebuild.db`, { force: true });
    rmSync(`${dbPath}.rebuild.db-wal`, { force: true });
    rmSync(`${dbPath}.rebuild.db-shm`, { force: true });
  });

  test('rebuild target must not be a symlink', async () => {
    const dbPath = fixturePath('symlink-rebuild-target.db');
    createFixtureDatabase(dbPath);
    const linkPath = `${dbPath}.rebuild.db`;
    if (existsSync(linkPath)) rmSync(linkPath, { force: true });
    symlinkSync(dbPath, linkPath);
    try {
      expect(() => createRebuiltDatabase(dbPath, linkPath)).toThrow(/symlink/);
    } finally {
      rmSync(linkPath, { force: true });
    }
  });

  test('locale-enabled FTS tables abort in preflight', async () => {
    const dbPath = fixturePath('locale.db');
    const db = new Database(dbPath);
    db.exec(`CREATE VIRTUAL TABLE lvs USING fts5(body, locale=1)`);
    db.close();

    expect(() => createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`)).toThrow(/per-row locales/);
    expect(existsSync(dbPath)).toBe(true);
  });

  test('application_id is copied to the rebuilt database', async () => {
    const dbPath = fixturePath('appid.db');
    const db = new Database(dbPath);
    db.exec(`PRAGMA application_id = 1196434467`);
    db.exec(`CREATE TABLE marked (id INTEGER PRIMARY KEY)`);
    db.close();

    const rebuilt = createRebuiltDatabase(dbPath, `${dbPath}.rebuild.db`);
    try {
      expect(verifyRebuiltDatabase(rebuilt, { fullIntegrity: false })).toEqual([]);
      const appId = rebuilt.prepare('PRAGMA main.application_id').get() as {
        application_id: number;
      };
      expect(appId.application_id).toBe(1196434467);
    } finally {
      rebuilt.exec('DETACH DATABASE src');
      rebuilt.close();
    }
    rmSync(`${dbPath}.rebuild.db`, { force: true });
    rmSync(`${dbPath}.rebuild.db-wal`, { force: true });
    rmSync(`${dbPath}.rebuild.db-shm`, { force: true });
  });

  test('run() refuses multiply linked database files', async () => {
    const realPath = fixturePath('hardlinked-real.db');
    const aliasPath = fixturePath('hardlinked-alias.db');
    createFixtureDatabase(realPath);
    linkSync(realPath, aliasPath);

    await expect(run({ ...defaultOptions(aliasPath), noSwap: true })).rejects.toThrow(
      /2 hard links/
    );
    expect(existsSync(realPath)).toBe(true);
    expect(existsSync(aliasPath)).toBe(true);
    rmSync(aliasPath, { force: true });
  });

  test('run() resolves a symlinked database path to its target', async () => {
    const realPath = fixturePath('symlink-target.db');
    createFixtureDatabase(realPath);
    const linkPath = fixturePath('symlink-input.db');
    symlinkSync(realPath, linkPath);

    await run({ ...defaultOptions(linkPath), noSwap: true });

    const originalRows = queryInSubprocess(realPath, 'SELECT count(*) AS count FROM events') as {
      count: number;
    }[];
    expect(originalRows).toEqual([{ count: 3 }]);

    const rebuiltBesideTarget = readdirSync(workDir).filter(
      (name) =>
        name.startsWith('symlink-target.db') && name.endsWith('.db') && name.includes('.rebuild-')
    );
    expect(rebuiltBesideTarget.length).toBe(1);
    const rebuiltBesideLink = readdirSync(workDir).filter(
      (name) => name.startsWith('symlink-input.db') && name.includes('.rebuild-')
    );
    expect(rebuiltBesideLink).toEqual([]);
  });
});
