import { describe, test, expect, afterEach } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { MessageSearchWorkerService } from '../../../../src/lib/message-search-worker-service';

function createSearchDb(): string {
	const path = join(process.cwd(), 'tmp', `message-search-worker-${Date.now()}.db`);
	const db = new BunDatabase(path);
	db.exec(`
		CREATE VIRTUAL TABLE message_search_fts USING fts5(
			kind UNINDEXED,
			source_id UNINDEXED,
			message_id UNINDEXED,
			session_id UNINDEXED,
			task_id UNINDEXED,
			space_id UNINDEXED,
			task_number UNINDEXED,
			message_type UNINDEXED,
			title,
			body,
			timestamp UNINDEXED,
			tokenize = 'unicode61'
		)
	`);
	db.prepare(
		`INSERT INTO message_search_fts (kind, source_id, session_id, message_type, title, body, timestamp)
		 VALUES ('message', 'msg-1', 'session-1', 'user', 'Worker Smoke', 'worker smoke marker', ?)`
	).run(Date.now());
	db.close();
	return path;
}

describe('MessageSearchWorkerService', () => {
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
});
