import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { runMigration129 } from '../../../../../src/storage/schema/index.ts';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
		CREATE TABLE spaces (
			id TEXT PRIMARY KEY,
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
});

describe('Migration 129: space concurrent task limits', () => {
  test('adds max_concurrent_tasks with default 1', () => {
    db.prepare(`INSERT INTO spaces (id, config, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
      'space-1',
      null,
      1,
      1
    );

    runMigration129(db);

    const row = db
      .prepare(`SELECT max_concurrent_tasks FROM spaces WHERE id = ?`)
      .get('space-1') as {
      max_concurrent_tasks: number;
    };
    expect(row.max_concurrent_tasks).toBe(1);
  });

  test('backfills from legacy config.maxConcurrentTasks when valid', () => {
    db.prepare(`INSERT INTO spaces (id, config, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
      'space-1',
      JSON.stringify({ maxConcurrentTasks: 4, taskTimeoutMs: 1000 }),
      1,
      1
    );

    runMigration129(db);

    const row = db
      .prepare(`SELECT max_concurrent_tasks FROM spaces WHERE id = ?`)
      .get('space-1') as {
      max_concurrent_tasks: number;
    };
    expect(row.max_concurrent_tasks).toBe(4);
  });

  test('ignores invalid legacy config.maxConcurrentTasks values', () => {
    db.prepare(`INSERT INTO spaces (id, config, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
      'space-1',
      JSON.stringify({ maxConcurrentTasks: 99 }),
      1,
      1
    );

    runMigration129(db);

    const row = db
      .prepare(`SELECT max_concurrent_tasks FROM spaces WHERE id = ?`)
      .get('space-1') as {
      max_concurrent_tasks: number;
    };
    expect(row.max_concurrent_tasks).toBe(1);
  });

  test('is idempotent', () => {
    runMigration129(db);
    expect(() => runMigration129(db)).not.toThrow();
  });

  test('rejects fractional legacy config values', () => {
    db.prepare(`INSERT INTO spaces (id, config, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
      'space-1',
      JSON.stringify({ maxConcurrentTasks: 2.7 }),
      1,
      1
    );

    runMigration129(db);

    const row = db
      .prepare(`SELECT max_concurrent_tasks FROM spaces WHERE id = ?`)
      .get('space-1') as {
      max_concurrent_tasks: number;
    };
    expect(row.max_concurrent_tasks).toBe(1);
  });

  test('ignores rows with malformed JSON config', () => {
    db.prepare(`INSERT INTO spaces (id, config, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
      'space-1',
      '{not valid json}',
      1,
      1
    );

    runMigration129(db);

    const row = db
      .prepare(`SELECT max_concurrent_tasks FROM spaces WHERE id = ?`)
      .get('space-1') as {
      max_concurrent_tasks: number;
    };
    expect(row.max_concurrent_tasks).toBe(1);
  });
});
