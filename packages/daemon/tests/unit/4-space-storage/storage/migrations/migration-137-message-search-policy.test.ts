import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration137 } from '../../../../../src/storage/schema/index.ts';

function indexedSourceIds(db: BunDatabase): string[] {
	return (
		db.prepare(`SELECT source_id FROM message_search_fts ORDER BY source_id`).all() as Array<{
			source_id: string;
		}>
	).map((row) => row.source_id);
}

describe('Migration 137: message search indexing policy', () => {
	let testDir: string;
	let db: BunDatabase;

	beforeEach(() => {
		testDir = join(process.cwd(), 'tmp', 'test-migration-137', `test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		db = new BunDatabase(join(testDir, 'test.db'));
		db.exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				status TEXT NOT NULL,
				type TEXT,
				last_active_at TEXT NOT NULL,
				session_context TEXT
			);
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				task_number INTEGER NOT NULL,
				status TEXT NOT NULL,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL
			);
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
			);
		`);
	}, 10_000);

	afterEach(() => {
		db.close();
		rmSync(testDir, { recursive: true, force: true });
	}, 10_000);

	function insertSession(id: string, status: string, type: string, context: unknown = null): void {
		db.prepare(
			`INSERT INTO sessions (id, title, status, type, last_active_at, session_context)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).run(id, id, status, type, new Date().toISOString(), context ? JSON.stringify(context) : null);
	}

	function insertSearchRow(
		id: string,
		sessionId: string,
		taskId: string | null = null,
		messageType = 'user'
	): void {
		db.prepare(
			`INSERT INTO message_search_fts (kind, source_id, session_id, task_id, message_type, title, body, timestamp)
			 VALUES ('message', ?, ?, ?, ?, ?, ?, ?)`
		).run(id, sessionId, taskId, messageType, id, 'searchable policy marker', Date.now());
	}

	test('prunes room, archived, and old terminal task message rows', () => {
		const old = Date.now() - 45 * 24 * 60 * 60 * 1000;
		const recent = Date.now() - 2 * 24 * 60 * 60 * 1000;
		insertSession('session-1', 'active', 'worker');
		insertSession('archived-session', 'archived', 'worker');
		insertSession('coder:room-1:task-1:exec-1', 'active', 'coder');
		insertSession('space:space-1:task:recent:exec:exec-1', 'active', 'worker', {
			spaceId: 'space-1',
			taskId: 'recent',
		});
		insertSession('space:space-1:task:old:exec:exec-1', 'active', 'worker', {
			spaceId: 'space-1',
			taskId: 'old',
		});
		db.prepare(
			`INSERT INTO space_tasks (id, space_id, task_number, status, completed_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).run('recent', 'space-1', 1, 'done', recent, recent);
		db.prepare(
			`INSERT INTO space_tasks (id, space_id, task_number, status, completed_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).run('old', 'space-1', 2, 'cancelled', old, old);

		insertSearchRow('normal', 'session-1');
		insertSearchRow('archived', 'archived-session');
		insertSearchRow('room', 'coder:room-1:task-1:exec-1');
		insertSearchRow('recent-space', 'space:space-1:task:recent:exec:exec-1', 'recent');
		insertSearchRow('old-space', 'space:space-1:task:old:exec:exec-1', 'old');
		insertSearchRow('result', 'session-1', null, 'result');

		runMigration137(db);

		expect(indexedSourceIds(db)).toEqual(['normal', 'recent-space']);
	});

	test('is idempotent and keeps pruning newly ineligible rows', () => {
		insertSession('session-1', 'active', 'worker');
		insertSearchRow('normal', 'session-1');
		runMigration137(db);
		insertSearchRow('room-after-first-run', 'coder:room-1:task-1:exec-1');

		runMigration137(db);

		expect(indexedSourceIds(db)).toEqual(['normal']);
	});
});
