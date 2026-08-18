import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigration166 } from '../../../../../src/storage/schema/index.ts';

interface ArtifactRow {
  id: string;
  run_id: string;
  node_id: string;
  artifact_type: string;
  artifact_key: string;
  data: string;
}

function createArtifactsTable(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE workflow_run_artifacts (
			id TEXT PRIMARY KEY NOT NULL,
			run_id TEXT NOT NULL,
			node_id TEXT NOT NULL,
			artifact_type TEXT NOT NULL,
			artifact_key TEXT NOT NULL DEFAULT '',
			data TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(run_id, node_id, artifact_type, artifact_key)
		)
	`);
}

function insert(
  db: BunDatabase,
  params: {
    id: string;
    runId?: string;
    nodeId?: string;
    type: string;
    key?: string;
    data: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
  }
): void {
  db.prepare(
    `INSERT INTO workflow_run_artifacts (
				id, run_id, node_id, artifact_type, artifact_key, data, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.id,
    params.runId ?? 'run-1',
    params.nodeId ?? 'node-1',
    params.type,
    params.key ?? '',
    JSON.stringify(params.data),
    params.createdAt,
    params.updatedAt
  );
}

function allArtifacts(db: BunDatabase): ArtifactRow[] {
  return db
    .prepare(
      `SELECT id, run_id, node_id, artifact_type, artifact_key, data
			 FROM workflow_run_artifacts ORDER BY id`
    )
    .all() as ArtifactRow[];
}

const SHAPES: ReadonlySet<string> = new Set([
  'link',
  'commit_set',
  'check',
  'metric',
  'decision',
  'note',
]);

describe('Migration 166: artifact_type → generic shapes', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-166', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
    createArtifactsTable(db);
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  test('maps legacy types to shapes (pr→link kind:pr, review→decision kind:review, progress→note, result by data)', () => {
    insert(db, {
      id: 'a-pr',
      type: 'pr',
      key: 'pr',
      data: { pr_url: 'https://github.com/acme/app/pull/1' },
      createdAt: 10,
      updatedAt: 10,
    });
    insert(db, {
      id: 'a-review',
      type: 'review',
      key: 'review-1',
      data: { review_url: 'https://github.com/acme/app/pull/1#review-1' },
      createdAt: 11,
      updatedAt: 11,
    });
    insert(db, {
      id: 'a-result-url',
      type: 'result',
      key: 'r-url',
      data: { pr_url: 'https://github.com/acme/app/pull/2' },
      createdAt: 12,
      updatedAt: 12,
    });
    insert(db, {
      id: 'a-result-summary',
      type: 'result',
      key: 'r-summary',
      data: { summary: 'shipped' },
      createdAt: 13,
      updatedAt: 13,
    });

    runMigration166(db);

    const byId = new Map(allArtifacts(db).map((r) => [r.id, r]));
    const pr = byId.get('a-pr')!;
    expect(pr.artifact_type).toBe('link');
    expect(JSON.parse(pr.data).url).toBe('https://github.com/acme/app/pull/1');
    expect(JSON.parse(pr.data).kind).toBe('pr');

    const review = byId.get('a-review')!;
    expect(review.artifact_type).toBe('decision');
    expect(JSON.parse(review.data).kind).toBe('review');

    const resultUrl = byId.get('a-result-url')!;
    expect(resultUrl.artifact_type).toBe('link');
    expect(JSON.parse(resultUrl.data).url).toBe('https://github.com/acme/app/pull/2');

    const resultSummary = byId.get('a-result-summary')!;
    expect(resultSummary.artifact_type).toBe('decision');
    expect(JSON.parse(resultSummary.data).summary).toBe('shipped');
  });

  test('unknown legacy types become note with _legacyType preserved', () => {
    insert(db, {
      id: 'a-weird',
      type: 'code-pr-gate',
      data: { whatever: 'x' },
      createdAt: 10,
      updatedAt: 10,
    });

    runMigration166(db);

    const row = allArtifacts(db)[0]!;
    expect(row.artifact_type).toBe('note');
    const data = JSON.parse(row.data);
    expect(data.whatever).toBe('x');
    expect(data._legacyType).toBe('code-pr-gate');
  });

  test('collapses per-(run,node) note rows to the single most-recent one with key "current"', () => {
    insert(db, {
      id: 'p-1',
      type: 'progress',
      key: 'round-0',
      data: { summary: 'first' },
      createdAt: 10,
      updatedAt: 10,
    });
    insert(db, {
      id: 'p-2',
      type: 'progress',
      key: 'round-1',
      data: { summary: 'second' },
      createdAt: 20,
      updatedAt: 20,
    });
    insert(db, {
      id: 'p-3',
      type: 'progress',
      key: 'round-2',
      data: { summary: 'third' },
      createdAt: 30,
      updatedAt: 30,
    });

    runMigration166(db);

    const notes = allArtifacts(db).filter((r) => r.artifact_type === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.id).toBe('p-3');
    expect(notes[0]!.artifact_key).toBe('current');
    expect(JSON.parse(notes[0]!.data).summary).toBe('third');
  });

  test('dedupes legacy rows that collide on (run,node,shape,key) without throwing', () => {
    insert(db, {
      id: 'rev-1',
      type: 'review',
      key: 'final',
      data: { review_url: 'u' },
      createdAt: 10,
      updatedAt: 10,
    });
    insert(db, {
      id: 'res-1',
      type: 'result',
      key: 'final',
      data: { verdict: 'ok' },
      createdAt: 20,
      updatedAt: 20,
    });

    expect(() => runMigration166(db)).not.toThrow();

    const decisions = allArtifacts(db).filter(
      (r) => r.artifact_type === 'decision' && r.artifact_key === 'final'
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.id).toBe('res-1');
  });

  test('distinct unknown legacy types are preserved (only progress collapses)', () => {
    insert(db, {
      id: 'mb',
      type: 'merge_blocked',
      data: { summary: 'conflict' },
      createdAt: 10,
      updatedAt: 10,
    });
    insert(db, {
      id: 'mcl',
      type: 'merge_conflict_loop',
      data: { summary: 'loop' },
      createdAt: 20,
      updatedAt: 20,
    });

    runMigration166(db);

    const notes = allArtifacts(db).filter((r) => r.artifact_type === 'note');
    expect(notes).toHaveLength(2);
    const types = notes.map((n) => JSON.parse(n.data)._legacyType).sort();
    expect(types).toEqual(['merge_blocked', 'merge_conflict_loop']);
  });

  test('every row ends up on a known shape after migration', () => {
    insert(db, { id: 'x-1', type: 'pr', data: { pr_url: 'u' }, createdAt: 1, updatedAt: 1 });
    insert(db, { id: 'x-2', type: 'result', data: { summary: 's' }, createdAt: 2, updatedAt: 2 });
    insert(db, { id: 'x-3', type: 'weird-xyz', data: {}, createdAt: 3, updatedAt: 3 });

    runMigration166(db);

    for (const row of allArtifacts(db)) {
      expect(SHAPES.has(row.artifact_type)).toBe(true);
    }
  });

  test('is idempotent', () => {
    insert(db, {
      id: 'p-1',
      type: 'progress',
      key: 'round-0',
      data: { summary: 'a' },
      createdAt: 10,
      updatedAt: 10,
    });
    insert(db, {
      id: 'p-2',
      type: 'progress',
      key: 'round-1',
      data: { summary: 'b' },
      createdAt: 20,
      updatedAt: 20,
    });
    insert(db, {
      id: 'r-1',
      type: 'result',
      key: 'r-1',
      data: { pr_url: 'https://example.com/pr/1' },
      createdAt: 30,
      updatedAt: 30,
    });

    runMigration166(db);
    const afterFirst = allArtifacts(db);
    runMigration166(db);
    const afterSecond = allArtifacts(db);

    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.every((r) => SHAPES.has(r.artifact_type))).toBe(true);
  });

  test('is a no-op when the table does not exist', () => {
    db.exec('DROP TABLE workflow_run_artifacts');
    expect(() => runMigration166(db)).not.toThrow();
  });
});
