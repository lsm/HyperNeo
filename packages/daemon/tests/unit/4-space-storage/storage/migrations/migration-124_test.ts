import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTables,
  runMigration124,
  runMigrations,
} from '../../../../../src/storage/schema/index.ts';

function columnNames(db: BunDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function tableExists(db: BunDatabase, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name?: string } | undefined;
  return !!row?.name;
}

function indexExists(db: BunDatabase, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(name) as { name?: string } | undefined;
  return !!row?.name;
}

function seedPreM124Schema(db: BunDatabase): void {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
		CREATE TABLE spaces (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			workspace_path TEXT NOT NULL,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
  db.exec(`
		CREATE TABLE space_external_events (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			source TEXT NOT NULL,
			topic TEXT NOT NULL,
			dedupe_key TEXT NOT NULL,
			occurred_at INTEGER NOT NULL,
			ingested_at INTEGER NOT NULL,
			source_event_id TEXT,
			pr_number INTEGER,
			repo_owner TEXT,
			repo_name TEXT,
			branch TEXT,
			summary TEXT NOT NULL,
			external_url TEXT,
			payload_json TEXT NOT NULL,
			routed_task_id TEXT,
			state TEXT NOT NULL DEFAULT 'published'
				CHECK(state IN ('published', 'routed', 'delivered', 'delivery_failed', 'failed', 'ignored', 'ambiguous')),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(space_id, source, dedupe_key),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(`
		CREATE TABLE space_external_event_deliveries (
			event_id TEXT NOT NULL,
			delivery_key TEXT NOT NULL,
			workflow_run_id TEXT NOT NULL,
			task_id TEXT NOT NULL,
			node_id TEXT NOT NULL,
			agent_name TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'pending'
				CHECK(state IN ('pending', 'delivered', 'failed')),
			failure_reason TEXT,
			delivered_at INTEGER,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY(event_id, delivery_key),
			FOREIGN KEY (event_id) REFERENCES space_external_events(id) ON DELETE CASCADE
		)
	`);
  db.exec('PRAGMA foreign_keys = ON');
}

describe('Migration 124: simplify external-event schema', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-124',
      `test-${Date.now()}-${Math.random()}`
    );
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('fresh DB (all migrations applied)', () => {
    beforeEach(() => {
      runMigrations(db, () => {});
      createTables(db);
    });

    test('space_external_events does not have legacy columns', () => {
      const columns = columnNames(db, 'space_external_events');
      expect(columns).not.toContain('pr_number');
      expect(columns).not.toContain('repo_owner');
      expect(columns).not.toContain('repo_name');
      expect(columns).not.toContain('branch');
      expect(columns).not.toContain('routed_task_id');
    });

    test('space_external_events has the simplified state CHECK', () => {
      expect(() =>
        db.exec(`
					INSERT INTO space_external_events (
						id, space_id, source, topic, dedupe_key,
						occurred_at, ingested_at, summary, payload_json,
						state, created_at, updated_at
					) VALUES (
						'evt-1', 'sp-1', 'github', 'github/o/r/t.a', 'dk-1',
						1, 1, 's', '{}',
						'routed', 1, 1
					)
				`)
      ).toThrow();
    });

    test('indexes are recreated', () => {
      expect(indexExists(db, 'idx_space_external_events_lookup')).toBe(true);
      expect(indexExists(db, 'idx_space_external_events_state')).toBe(true);
    });
  });

  describe('backfill from pre-124 schema', () => {
    beforeEach(() => {
      seedPreM124Schema(db);
      db.prepare(
        `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run('sp-1', 'sp-1', '/tmp/test', 'Test Space', 1, 1);

      db.prepare(`
				INSERT INTO space_external_events (
					id, space_id, source, topic, dedupe_key,
					occurred_at, ingested_at, source_event_id,
					pr_number, repo_owner, repo_name, branch,
					summary, external_url, payload_json, routed_task_id,
					state, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
        'evt-legacy',
        'sp-1',
        'github',
        'github/lsm/neokai/pull_request.opened',
        'dk-legacy',
        1_700_000_000_000,
        1_700_000_001_000,
        'del-123',
        42,
        'lsm',
        'neokai',
        'feature-42',
        'PR #42 opened',
        'https://github.com/lsm/neokai/pull/42',
        JSON.stringify({ action: 'opened' }),
        'task-42',
        'routed',
        1_700_000_000_000,
        1_700_000_000_000
      );

      db.prepare(`
				INSERT INTO space_external_events (
					id, space_id, source, topic, dedupe_key,
					occurred_at, ingested_at, source_event_id,
					pr_number, repo_owner, repo_name, branch,
					summary, external_url, payload_json, routed_task_id,
					state, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
        'evt-payload-dup',
        'sp-1',
        'github',
        'github/lsm/neokai/pull_request.closed',
        'dk-payload-dup',
        1_700_000_000_000,
        1_700_000_001_000,
        null,
        99,
        'acme',
        'widget',
        'hotfix-99',
        'PR #99 closed',
        null,
        JSON.stringify({
          prNumber: 99,
          repoOwner: 'acme',
          repoName: 'widget',
          branch: 'hotfix-99',
        }),
        null,
        'delivery_failed',
        1_700_000_000_000,
        1_700_000_000_000
      );

      db.prepare(`
				INSERT INTO space_external_events (
					id, space_id, source, topic, dedupe_key,
					occurred_at, ingested_at, source_event_id,
					pr_number, repo_owner, repo_name, branch,
					summary, external_url, payload_json, routed_task_id,
					state, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
        'evt-minimal',
        'sp-1',
        'github',
        'github/lsm/neokai/issue.created',
        'dk-minimal',
        1_700_000_000_000,
        1_700_000_001_000,
        null,
        null,
        null,
        null,
        null,
        'Issue created',
        null,
        JSON.stringify({ number: 1 }),
        null,
        'ambiguous',
        1_700_000_000_000,
        1_700_000_000_000
      );

      db.prepare(`
				INSERT INTO space_external_events (
					id, space_id, source, topic, dedupe_key,
					occurred_at, ingested_at, source_event_id,
					pr_number, repo_owner, repo_name, branch,
					summary, external_url, payload_json, routed_task_id,
					state, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
        'evt-payload-wins',
        'sp-1',
        'github',
        'github/lsm/neokai/pull_request.closed',
        'dk-payload-wins',
        1_700_000_000_000,
        1_700_000_001_000,
        null,
        999,
        'LEGACY_OWNER',
        'LEGACY_NAME',
        'legacy-branch',
        'PR #99 closed',
        null,
        JSON.stringify({
          prNumber: 99,
          repoOwner: 'acme',
          repoName: 'widget',
          branch: 'hotfix-99',
        }),
        null,
        'published',
        1_700_000_000_000,
        1_700_000_000_000
      );

      db.prepare(`
				INSERT INTO space_external_events (
					id, space_id, source, topic, dedupe_key,
					occurred_at, ingested_at, source_event_id,
					pr_number, repo_owner, repo_name, branch,
					summary, external_url, payload_json, routed_task_id,
					state, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
        'evt-array-root',
        'sp-1',
        'github',
        'github/lsm/neokai/pull_request.closed',
        'dk-array-root',
        1_700_000_000_000,
        1_700_000_001_000,
        null,
        55,
        'acme',
        'widget',
        'hotfix-55',
        'PR #55 closed',
        null,
        JSON.stringify([1, 2, 3]),
        null,
        'published',
        1_700_000_000_000,
        1_700_000_000_000
      );

      db.prepare(`
				INSERT INTO space_external_events (
					id, space_id, source, topic, dedupe_key,
					occurred_at, ingested_at, source_event_id,
					pr_number, repo_owner, repo_name, branch,
					summary, external_url, payload_json, routed_task_id,
					state, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
        'evt-routed-task',
        'sp-1',
        'github',
        'github/lsm/neokai/pull_request.opened',
        'dk-routed-task',
        1_700_000_000_000,
        1_700_000_001_000,
        null,
        1,
        'lsm',
        'neokai',
        'main',
        'PR #1 opened',
        null,
        JSON.stringify({ action: 'opened' }),
        'task-routed-1',
        'routed',
        1_700_000_000_000,
        1_700_000_000_000
      );

      db.prepare(`
				INSERT INTO space_external_events (
					id, space_id, source, topic, dedupe_key,
					occurred_at, ingested_at, source_event_id,
					pr_number, repo_owner, repo_name, branch,
					summary, external_url, payload_json, routed_task_id,
					state, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
        'evt-malformed',
        'sp-1',
        'github',
        'github/lsm/neokai/pull_request.closed',
        'dk-malformed',
        1_700_000_000_000,
        1_700_000_001_000,
        null,
        77,
        'acme',
        'widget',
        'bugfix-77',
        'PR #77 closed',
        null,
        '{not-valid-json',
        null,
        'published',
        1_700_000_000_000,
        1_700_000_000_000
      );

      db.prepare(`
				INSERT INTO space_external_event_deliveries (
					event_id, delivery_key, workflow_run_id, task_id, node_id, agent_name,
					state, failure_reason, delivered_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
        'evt-legacy',
        'dk-1',
        'run-1',
        'task-1',
        'node-1',
        'coder',
        'pending',
        null,
        null,
        1_700_000_000_000
      );
    });

    test('legacy columns are backfilled into payload_json', () => {
      runMigration124(db);
      const row = db
        .prepare(`SELECT payload_json FROM space_external_events WHERE id = ?`)
        .get('evt-legacy') as { payload_json: string };
      const payload = JSON.parse(row.payload_json);
      expect(payload.prNumber).toBe(42);
      expect(payload.repoOwner).toBe('lsm');
      expect(payload.repoName).toBe('neokai');
      expect(payload.branch).toBe('feature-42');
      expect(payload.action).toBe('opened');
    });

    test('backfill does not overwrite existing payload values', () => {
      runMigration124(db);
      const row = db
        .prepare(`SELECT payload_json FROM space_external_events WHERE id = ?`)
        .get('evt-payload-dup') as { payload_json: string };
      const payload = JSON.parse(row.payload_json);
      expect(payload.prNumber).toBe(99);
      expect(payload.repoOwner).toBe('acme');
      expect(payload.repoName).toBe('widget');
      expect(payload.branch).toBe('hotfix-99');
    });

    test('malformed payload_json is coerced to valid JSON and backfilled', () => {
      runMigration124(db);
      const row = db
        .prepare(`SELECT payload_json FROM space_external_events WHERE id = ?`)
        .get('evt-malformed') as { payload_json: string };
      const payload = JSON.parse(row.payload_json);
      expect(payload.prNumber).toBe(77);
      expect(payload.repoOwner).toBe('acme');
      expect(payload.repoName).toBe('widget');
      expect(payload.branch).toBe('bugfix-77');
    });

    test('payload values win over malformed legacy columns', () => {
      runMigration124(db);
      const row = db
        .prepare(`SELECT payload_json FROM space_external_events WHERE id = ?`)
        .get('evt-payload-wins') as { payload_json: string };
      const payload = JSON.parse(row.payload_json);
      expect(payload.prNumber).toBe(99);
      expect(payload.repoOwner).toBe('acme');
      expect(payload.repoName).toBe('widget');
      expect(payload.branch).toBe('hotfix-99');
    });

    test('valid non-object JSON root is coerced to object before backfill', () => {
      runMigration124(db);
      const row = db
        .prepare(`SELECT payload_json FROM space_external_events WHERE id = ?`)
        .get('evt-array-root') as { payload_json: string };
      const payload = JSON.parse(row.payload_json);
      expect(Array.isArray(payload)).toBe(false);
      expect(payload.prNumber).toBe(55);
      expect(payload.repoOwner).toBe('acme');
      expect(payload.repoName).toBe('widget');
      expect(payload.branch).toBe('hotfix-55');
    });

    test('routed_task_id is preserved in payload for historical events', () => {
      runMigration124(db);
      const row = db
        .prepare(`SELECT payload_json FROM space_external_events WHERE id = ?`)
        .get('evt-routed-task') as { payload_json: string };
      const payload = JSON.parse(row.payload_json);
      expect(payload.routedTaskId).toBe('task-routed-1');
      const stateRow = db
        .prepare(`SELECT state FROM space_external_events WHERE id = ?`)
        .get('evt-routed-task') as { state: string };
      expect(stateRow.state).toBe('published');
    });

    test('state values are migrated correctly', () => {
      runMigration124(db);
      const legacy = db
        .prepare(`SELECT state FROM space_external_events WHERE id = ?`)
        .get('evt-legacy') as { state: string };
      expect(legacy.state).toBe('published');

      const payloadDup = db
        .prepare(`SELECT state FROM space_external_events WHERE id = ?`)
        .get('evt-payload-dup') as { state: string };
      expect(payloadDup.state).toBe('published');

      const minimal = db
        .prepare(`SELECT state FROM space_external_events WHERE id = ?`)
        .get('evt-minimal') as { state: string };
      expect(minimal.state).toBe('ignored');
    });

    test('delivery rows are preserved (not cascade-deleted)', () => {
      runMigration124(db);
      const deliveries = db
        .prepare(`SELECT COUNT(*) AS n FROM space_external_event_deliveries WHERE event_id = ?`)
        .get('evt-legacy') as { n: number };
      expect(deliveries.n).toBe(1);
    });

    test('legacy columns are dropped from the schema', () => {
      runMigration124(db);
      const columns = columnNames(db, 'space_external_events');
      expect(columns).not.toContain('pr_number');
      expect(columns).not.toContain('repo_owner');
      expect(columns).not.toContain('repo_name');
      expect(columns).not.toContain('branch');
      expect(columns).not.toContain('routed_task_id');
    });

    test('indexes are recreated', () => {
      runMigration124(db);
      expect(indexExists(db, 'idx_space_external_events_lookup')).toBe(true);
      expect(indexExists(db, 'idx_space_external_events_state')).toBe(true);
    });

    test('is idempotent — running a second time is a no-op', () => {
      runMigration124(db);
      const before = db.prepare(`SELECT COUNT(*) AS n FROM space_external_events`).get() as {
        n: number;
      };
      const deliveriesBefore = db
        .prepare(`SELECT COUNT(*) AS n FROM space_external_event_deliveries`)
        .get() as { n: number };

      expect(() => runMigration124(db)).not.toThrow();

      const after = db.prepare(`SELECT COUNT(*) AS n FROM space_external_events`).get() as {
        n: number;
      };
      const deliveriesAfter = db
        .prepare(`SELECT COUNT(*) AS n FROM space_external_event_deliveries`)
        .get() as { n: number };
      expect(after.n).toBe(before.n);
      expect(deliveriesAfter.n).toBe(deliveriesBefore.n);
    });

    test('restores original foreign_keys pragma after migration', () => {
      db.exec('PRAGMA foreign_keys = OFF');
      const before = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(before.foreign_keys).toBe(0);

      runMigration124(db);

      const after = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(after.foreign_keys).toBe(0);
    });
  });

  describe('crash recovery', () => {
    beforeEach(() => {
      seedPreM124Schema(db);
      db.prepare(
        `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run('sp-1', 'sp-1', '/tmp/test', 'Test Space', 1, 1);
    });

    test('cleans up leftover space_external_events_new from interrupted migration', () => {
      db.exec(`
				CREATE TABLE space_external_events_new (
					id TEXT PRIMARY KEY
				)
			`);
      expect(tableExists(db, 'space_external_events_new')).toBe(true);

      expect(() => runMigration124(db)).not.toThrow();
      expect(tableExists(db, 'space_external_events_new')).toBe(false);
    });

    test('recovers when old table was dropped but new table remains', () => {
      db.exec(`ALTER TABLE space_external_events RENAME TO space_external_events_new`);
      expect(tableExists(db, 'space_external_events')).toBe(false);
      expect(tableExists(db, 'space_external_events_new')).toBe(true);

      expect(() => runMigration124(db)).not.toThrow();
      expect(tableExists(db, 'space_external_events')).toBe(true);
      expect(tableExists(db, 'space_external_events_new')).toBe(false);
    });

    test('recovers when empty old table was recreated and new table still has data', () => {
      db.prepare(`
				INSERT INTO space_external_events (
					id, space_id, source, topic, dedupe_key,
					occurred_at, ingested_at, source_event_id,
					pr_number, repo_owner, repo_name, branch,
					summary, external_url, payload_json, routed_task_id,
					state, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
        'evt-recovery',
        'sp-1',
        'github',
        'github/lsm/neokai/pull_request.opened',
        'dk-recovery',
        1_700_000_000_000,
        1_700_000_001_000,
        null,
        1,
        'lsm',
        'neokai',
        'main',
        'PR #1 opened',
        null,
        JSON.stringify({ action: 'opened' }),
        null,
        'published',
        1_700_000_000_000,
        1_700_000_000_000
      );

      db.exec(`ALTER TABLE space_external_events RENAME TO space_external_events_new`);
      db.exec(`
				CREATE TABLE IF NOT EXISTS space_external_events (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					source TEXT NOT NULL,
					topic TEXT NOT NULL,
					dedupe_key TEXT NOT NULL,
					occurred_at INTEGER NOT NULL,
					ingested_at INTEGER NOT NULL,
					source_event_id TEXT,
					pr_number INTEGER,
					repo_owner TEXT,
					repo_name TEXT,
					branch TEXT,
					summary TEXT NOT NULL,
					external_url TEXT,
					payload_json TEXT NOT NULL,
					routed_task_id TEXT,
					state TEXT NOT NULL DEFAULT 'published'
						CHECK(state IN ('published', 'routed', 'delivered', 'delivery_failed', 'failed', 'ignored', 'ambiguous')),
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					UNIQUE(space_id, source, dedupe_key),
					FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
				)
			`);
      expect(tableExists(db, 'space_external_events')).toBe(true);
      expect(tableExists(db, 'space_external_events_new')).toBe(true);

      expect(() => runMigration124(db)).not.toThrow();
      expect(tableExists(db, 'space_external_events')).toBe(true);
      expect(tableExists(db, 'space_external_events_new')).toBe(false);

      const count = db.prepare(`SELECT COUNT(*) AS n FROM space_external_events`).get() as {
        n: number;
      };
      expect(count.n).toBeGreaterThan(0);
    });
  });

  describe('missing table — no-op guard', () => {
    test('runMigration124 on an empty DB does not throw', () => {
      expect(() => runMigration124(db)).not.toThrow();
      expect(tableExists(db, 'space_external_events')).toBe(false);
    });
  });
});
