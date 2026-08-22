import { describe, test, expect, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMessageSearchMerge } from '../../../../src/lib/message-search-merge';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

const dbDirs: string[] = [];

function createFtsDb(): string {
  const dir = join(
    tmpdir(),
    `message-search-merge-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  dbDirs.push(dir);
  const path = join(dir, 'test.db');
  const db = new BunDatabase(path);
  db.exec(`
		CREATE TABLE message_search_content (kind TEXT, source_id TEXT, message_id TEXT, session_id TEXT, task_id TEXT, space_id TEXT, task_number INTEGER, message_type TEXT, title TEXT, body TEXT, timestamp INTEGER);
		CREATE VIRTUAL TABLE message_search_fts USING fts5(title, body, content='message_search_content', content_rowid='rowid', detail=column, tokenize = 'unicode61');
		CREATE TRIGGER message_search_content_ai AFTER INSERT ON message_search_content BEGIN INSERT INTO message_search_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END;
		CREATE TRIGGER message_search_content_ad AFTER DELETE ON message_search_content BEGIN INSERT INTO message_search_fts(message_search_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body); END;
		CREATE TRIGGER message_search_content_au AFTER UPDATE OF title, body ON message_search_content BEGIN INSERT INTO message_search_fts(message_search_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body); INSERT INTO message_search_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END
	`);
  db.prepare(
    `INSERT INTO message_search_content (kind, source_id, session_id, message_type, title, body, timestamp)
		 VALUES ('message', 'msg-1', 'session-1', 'user', 'Merge Smoke', 'merge smoke marker', ?)`
  ).run(Date.now());
  db.close();
  return path;
}

describe('runMessageSearchMerge without a worker runtime', () => {
  afterEach(() => {
    for (const dir of dbDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolves instead of throwing when Worker is unavailable', async () => {
    const dir = join(
      tmpdir(),
      `message-search-merge-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(dir, { recursive: true });
    dbDirs.push(dir);

    const originalWorker = (globalThis as { Worker?: unknown }).Worker;
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      value: undefined,
      writable: true,
    });
    try {
      await expect(runMessageSearchMerge(join(dir, 'test.db')).promise).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        value: originalWorker,
        writable: true,
      });
    }
  });
});

describe.skipIf(!isBun)('runMessageSearchMerge', () => {
  afterEach(() => {
    for (const dir of dbDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('runs the merge off-thread and keeps the index queryable', async () => {
    const dbPath = createFtsDb();

    await runMessageSearchMerge(dbPath).promise;

    const db = new BunDatabase(dbPath, { readonly: true });
    const hits = db
      .prepare(`SELECT title FROM message_search_fts WHERE message_search_fts MATCH 'merge'`)
      .all() as Array<{ title: string }>;
    db.close();
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('Merge Smoke');
  });

  test('tolerates a database without the fts table', async () => {
    const dir = join(tmpdir(), `message-search-merge-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    dbDirs.push(dir);
    const dbPath = join(dir, 'plain.db');
    const db = new BunDatabase(dbPath);
    db.exec('CREATE TABLE rooms (id TEXT PRIMARY KEY)');
    db.close();

    await expect(runMessageSearchMerge(dbPath).promise).resolves.toBeUndefined();
  });

  test('still resolves when the merge worker exceeds its timeout', async () => {
    const dbPath = createFtsDb();

    await expect(runMessageSearchMerge(dbPath, 1).promise).resolves.toBeUndefined();
  });

  test('cancel terminates an in-flight merge and resolves the promise', async () => {
    const dbPath = createFtsDb();

    const handle = runMessageSearchMerge(dbPath);
    handle.cancel();
    handle.cancel();
    await expect(handle.promise).resolves.toBeUndefined();
  });
});
