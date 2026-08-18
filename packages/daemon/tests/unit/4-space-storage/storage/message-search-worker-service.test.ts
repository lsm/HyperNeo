import { describe, test, expect, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { MessageSearchWorkerService } from '../../../../src/lib/message-search-worker-service';

function createSearchDb(): string {
  const tmpDir = join(process.cwd(), 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const path = join(tmpDir, `message-search-worker-${Date.now()}.db`);
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
		 VALUES ('message', 'msg-1', 'session-1', 'user', 'Worker Smoke', 'worker smoke marker', ?)`
  ).run(Date.now());
  db.close();
  return path;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

describe.skipIf(!isBun)('MessageSearchWorkerService', () => {
  const dbPaths: string[] = [];

  afterEach(() => {
    for (const path of dbPaths.splice(0)) {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  test('runs message search on a worker connection', async () => {
    const dbPath = createSearchDb();
    dbPaths.push(dbPath);
    const service = new MessageSearchWorkerService(dbPath, 2_000);

    const result = await service.search({ query: 'worker', limit: 5 }, 'test-client');

    expect(result.results).toHaveLength(1);
    expect(result.results[0].sourceId).toBe('msg-1');
  });

  test('resolves canceled searches with their original pagination params', async () => {
    const dbPath = createSearchDb();
    dbPaths.push(dbPath);
    const service = new MessageSearchWorkerService(dbPath, 2_000);

    const canceled = service.search({ query: 'worker', limit: 7, offset: 3 }, 'test-client');
    const current = service.search({ query: 'worker', limit: 2, offset: 1 }, 'test-client');

    expect(await canceled).toMatchObject({ results: [], limit: 7, offset: 3 });
    const currentResult = await current;
    expect(currentResult.limit).toBe(2);
    expect(currentResult.offset).toBe(1);
  });
});
